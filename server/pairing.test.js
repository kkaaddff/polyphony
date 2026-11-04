// pairing.js 状态机单测:node --test(Node 内置 runner,零新依赖)。
// 时间全部经 now 参数注入——过期/宽限/清扫等时间路径不必真等(D13 复审决策)。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createPairing,
  getPairingInfo,
  claimPairing,
  pollPairing,
  confirmPairing,
  cancelPairing,
  listPairings,
  _resetForTest,
  QR_TTL_MS,
  LINK_TTL_MINUTES,
  PICKUP_WINDOW_MS,
  GRACE_MS,
} from './pairing.js';

const ACC = { id: 'acc-1', name: 'zhang' };
const T0 = 1_000_000; // 任意基准时刻

const expectCode = (code, fn) =>
  assert.throws(fn, (e) => e.code === code);

test.beforeEach(() => _resetForTest());

test('create: qr 固定 2 分钟并忽略档位;link 校验档位默认 5', () => {
  const qr = createPairing(ACC, 'qr', 60, T0);
  assert.equal(qr.expiresAt, T0 + QR_TTL_MS);
  const link = createPairing(ACC, 'link', undefined, T0);
  assert.equal(link.expiresAt, T0 + LINK_TTL_MINUTES[0] * 60_000);
  createPairing(ACC, 'link', 60, T0); // 合法档位上限
  expectCode('E_PAIR_KIND', () => createPairing(ACC, 'link', 7, T0));
  expectCode('E_PAIR_KIND', () => createPairing(ACC, 'sms', undefined, T0));
});

test('主流程:create→info→claim→confirm(accept)→poll 取到 token', () => {
  const { code } = createPairing(ACC, 'qr', undefined, T0);
  assert.equal(getPairingInfo(code, T0 + 1).status, 'pending');

  const { claimKey, accountName } = claimPairing(code, 'UA-test', T0 + 2);
  assert.equal(accountName, 'zhang');

  confirmPairing(code, ACC.id, true, 'poly_secret', T0 + 3);

  const got = pollPairing(code, claimKey, T0 + 4);
  assert.equal(got.status, 'approved');
  assert.equal(got.token, 'poly_secret');
  assert.deepEqual(got.account, { id: ACC.id, name: ACC.name });
});

test('严格一次性:双 claim 409;非持钥 poll 410', () => {
  const { code } = createPairing(ACC, 'link', 5, T0);
  claimPairing(code, 'UA-a', T0 + 1);
  expectCode('E_PAIR_CLAIMED', () => claimPairing(code, 'UA-b', T0 + 2));
  // 抢扫失败者持 code 但无 claimKey,approved 后也拿不走 token(D4)
  expectCode('E_PAIR_EXPIRED', () => pollPairing(code, 'wrong-key', T0 + 3));
});

test('poll 取件宽限:响应丢失可重取,宽限外 410', () => {
  // 用 60 分钟链接:expiresAt 不会裁剪取件截止,边界即 确认+120s
  const { code } = createPairing(ACC, 'link', 60, T0);
  const { claimKey } = claimPairing(code, 'UA', T0 + 1);
  confirmPairing(code, ACC.id, true, 'poly_secret', T0 + 2);
  assert.ok(pollPairing(code, claimKey, T0 + 3).token);
  assert.equal(pollPairing(code, claimKey, T0 + 4).token, 'poly_secret'); // 宽限内幂等
  const deadline = T0 + 2 + PICKUP_WINDOW_MS;
  assert.ok(pollPairing(code, claimKey, deadline + GRACE_MS - 1).token);
  expectCode('E_PAIR_EXPIRED', () => pollPairing(code, claimKey, deadline + GRACE_MS + 1));
});

test('取件截止:confirm 后 min(expiresAt, 确认+120s),失联不陪跑整个 TTL(D12)', () => {
  const { code } = createPairing(ACC, 'link', 60, T0); // TTL 60 分钟
  const { claimKey } = claimPairing(code, 'UA', T0 + 60_000);
  confirmPairing(code, ACC.id, true, 'poly_secret', T0 + 120_000);
  // 取件截止 = T0+120s+120s,远早于 expiresAt;跨过截止+宽限后整条消失
  const cutoff = T0 + 120_000 + PICKUP_WINDOW_MS + GRACE_MS + 1;
  expectCode('E_PAIR_EXPIRED', () => pollPairing(code, claimKey, cutoff));
  // 且已被清扫:info 同样 410
  expectCode('E_PAIR_EXPIRED', () => getPairingInfo(code, cutoff));
});

test('过期:pending/claimed 跨 expiresAt → 清扫,claim/poll 410', () => {
  const a = createPairing(ACC, 'qr', undefined, T0);
  expectCode('E_PAIR_EXPIRED', () => claimPairing(a.code, 'UA', T0 + QR_TTL_MS + 1));

  const b = createPairing(ACC, 'qr', undefined, T0);
  const { claimKey } = claimPairing(b.code, 'UA', T0 + 1);
  // claim 后不确认:确认窗口 = 到 expiresAt(D5),过期即作废
  expectCode('E_PAIR_EXPIRED', () => pollPairing(b.code, claimKey, T0 + QR_TTL_MS + 1));
});

test('confirm:拒绝 → denied,手机端 poll 可读;非 owner / 非 claimed 态 409', () => {
  const { code } = createPairing(ACC, 'qr', undefined, T0);
  const { claimKey } = claimPairing(code, 'UA', T0 + 1);

  expectCode('E_PAIR_STATE', () => confirmPairing(code, 'other-id', true, 't', T0 + 2));
  expectCode('E_PAIR_STATE', () => cancelPairing(code, 'other-id', T0 + 2));

  confirmPairing(code, ACC.id, false, undefined, T0 + 3);
  assert.equal(pollPairing(code, claimKey, T0 + 4).status, 'denied');
  // denied 是终态:再 confirm / cancel 均拒
  expectCode('E_PAIR_STATE', () => confirmPairing(code, ACC.id, true, 't', T0 + 5));
  expectCode('E_PAIR_STATE', () => cancelPairing(code, ACC.id, T0 + 5));
});

test('cancel:pending/claimed/approved 三态可撤,立即清 token(D11)', () => {
  // pending
  const a = createPairing(ACC, 'qr', undefined, T0);
  cancelPairing(a.code, ACC.id, T0 + 1);
  expectCode('E_PAIR_EXPIRED', () => claimPairing(a.code, 'UA', T0 + 2));

  // claimed → cancelled:手机端 poll 读到 cancelled
  const b = createPairing(ACC, 'qr', undefined, T0);
  const bk = claimPairing(b.code, 'UA', T0 + 1).claimKey;
  cancelPairing(b.code, ACC.id, T0 + 2);
  assert.equal(pollPairing(b.code, bk, T0 + 3).status, 'cancelled');

  // approved → cancelled:token 清掉,再 poll 不是 approved
  const c = createPairing(ACC, 'qr', undefined, T0);
  const ck = claimPairing(c.code, 'UA', T0 + 1).claimKey;
  confirmPairing(c.code, ACC.id, true, 'poly_secret', T0 + 2);
  cancelPairing(c.code, ACC.id, T0 + 3);
  assert.equal(pollPairing(c.code, ck, T0 + 4).status, 'cancelled');
});

test('并发上限:第 4 个 create 静默淘汰最旧', () => {
  const first = createPairing(ACC, 'link', 60, T0);
  createPairing(ACC, 'link', 60, T0 + 1);
  createPairing(ACC, 'link', 60, T0 + 2);
  createPairing(ACC, 'link', 60, T0 + 3); // 触发淘汰 first
  expectCode('E_PAIR_EXPIRED', () => claimPairing(first.code, 'UA', T0 + 4));
  assert.equal(listPairings(ACC.id, T0 + 4).length, 3);
});

test('status:含终态(未清扫)记录,供弹窗显示最终结果(D14)', () => {
  const { code } = createPairing(ACC, 'qr', undefined, T0);
  const { claimKey } = claimPairing(code, 'UA', T0 + 1);
  confirmPairing(code, ACC.id, true, 'poly_secret', T0 + 2);
  pollPairing(code, claimKey, T0 + 3); // 取走 → consumed
  const list = listPairings(ACC.id, T0 + 4);
  assert.equal(list.length, 1);
  assert.equal(list[0].status, 'consumed'); // 终态在宽限内仍可见
  // 跨过取件截止+宽限 → 自然消失
  const deadline = T0 + 2 + PICKUP_WINDOW_MS;
  assert.equal(listPairings(ACC.id, deadline + GRACE_MS + 1).length, 0);
});

test('未知 code:claim/info/poll 一律 410', () => {
  expectCode('E_PAIR_EXPIRED', () => claimPairing('nope', 'UA', T0));
  expectCode('E_PAIR_EXPIRED', () => getPairingInfo('nope', T0));
  expectCode('E_PAIR_EXPIRED', () => pollPairing('nope', 'k', T0));
});

// 配对 v2 单测(docs/identity-and-sharing.md §7)。node --test,注入时钟与临时 DATA_DIR。
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'polyphony-pair-'));

const auth = await import('./auth.js');
const {
  createPushPairing,
  requestPullPairing,
  getPairingInfo,
  claimPushPairing,
  approvePairing,
  pollPairing,
  cancelPairing,
  listPairingsForAccount,
  countPendingPairings,
  _resetForTest,
} = await import('./pairing.js');

const T0 = 1_700_000_000_000;
const MIN = 60_000;
let seq = 0;
const newSecret = () => crypto.randomBytes(24).toString('hex');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120.0';

function mkAccount(name) {
  const secret = newSecret();
  const r = auth.createAccount({ name, secret, platform: { client: 'web', os: 'macos' }, ua: UA }, T0);
  return { name, token: `poly_d_${r.deviceId}_${secret}`, device1: r.deviceId, recoveryKey: r.recoveryKey };
}

function accountOf(mk) {
  return auth.authenticate(mk.token, T0).account;
}

before(() => {
  _resetForTest();
});

test('push 全流程:claim→同账号批准→设备写入;全部配对响应不含 secret;轮询幂等', () => {
  const owner = mkAccount(`发起者${++seq}`);
  const { code } = createPushPairing(accountOf(owner), 'qr', undefined, T0);

  const secret = newSecret();
  const pending = auth.buildPendingDevice(secret, { client: 'app', os: 'android' }, UA);
  const claimed = claimPushPairing(code, pending, T0 + 1000);
  assert.equal(claimed.accountName, owner.name);
  assert.match(claimed.deviceId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

  const stranger = mkAccount(`陌生人${++seq}`);
  assert.throws(
    () => approvePairing({ code, account: accountOf(stranger), accept: true, now: T0 + 2000 }),
    (e) => e.code === 'E_PAIR_STATE'
  );

  // V11:同账号的另一台设备批准
  const secret2 = newSecret();
  const second = auth.exchange({ key: owner.recoveryKey, secret: secret2, platform: {} }, T0 + 2000);
  const secondSession = auth.authenticate(`poly_d_${second.deviceId}_${secret2}`, T0 + 2000);
  const approved = approvePairing({ code, account: secondSession.account, accept: true, now: T0 + 3000 });
  assert.equal(approved.status, 'approved');

  const poll1 = pollPairing({ code, deviceId: pending.id, now: T0 + 4000 });
  const poll2 = pollPairing({ code, deviceId: pending.id, now: T0 + 5000 });
  assert.deepEqual(poll1, poll2); // 幂等
  assert.equal(poll1.status, 'approved');
  assert.equal(poll1.accountName, owner.name);
  assert.ok(!JSON.stringify(poll1).includes(secret), '轮询响应不得含 secret');

  // 新设备本地拼凭据即登录成功
  const newcomer = auth.authenticate(`poly_d_${pending.id}_${secret}`, T0 + 6000);
  assert.ok(newcomer);
  assert.equal(newcomer.account.name, owner.name);
  assert.equal(newcomer.device.label, 'App · Android');
});

test('push:双 claim 409;poll deviceId 不符 410(防探测)', () => {
  const owner = mkAccount(`发起者${++seq}`);
  const { code } = createPushPairing(accountOf(owner), 'link', 5, T0);
  const p1 = auth.buildPendingDevice(newSecret(), {}, UA);
  claimPushPairing(code, p1, T0 + 1);
  const p2 = auth.buildPendingDevice(newSecret(), {}, UA);
  assert.throws(() => claimPushPairing(code, p2, T0 + 2), (e) => e.code === 'E_PAIR_CLAIMED');
  assert.throws(
    () => pollPairing({ code, deviceId: p2.id, now: T0 + 3 }),
    (e) => e.code === 'E_PAIR_EXPIRED'
  );
});

test('push 活跃上限 3:最旧被静默淘汰为 cancelled', () => {
  const owner = mkAccount(`发起者${++seq}`);
  const codes = [];
  for (let i = 0; i < 3; i++) codes.push(createPushPairing(accountOf(owner), 'link', 60, T0 + i).code);
  const fourth = createPushPairing(accountOf(owner), 'link', 60, T0 + 10).code;
  const list = listPairingsForAccount(accountOf(owner).id, T0 + 11);
  const byCode = Object.fromEntries(list.map((x) => [x.code, x]));
  assert.equal(list.length, 4);
  assert.equal(byCode[codes[0]].status, 'cancelled');
  assert.equal(byCode[fourth].status, 'pending');
});

test('pull 全流程:request→info 不含账号→批准绑定→取件;凭据可登录', () => {
  const approver = mkAccount(`批准者${++seq}`);
  const secret = newSecret();
  const pending = auth.buildPendingDevice(secret, { client: 'web', os: 'windows' }, 'Mozilla/5.0 (Windows NT 10.0) Firefox/121.0');
  const req = requestPullPairing(pending, T0);
  assert.equal(req.deviceId, pending.id);

  const info = getPairingInfo(req.code, T0 + 1);
  assert.equal(info.direction, 'pull');
  assert.equal(info.newcomerLabel, 'Firefox · Windows');
  assert.ok(!('accountName' in info), 'pull info 不得暴露账号');

  const r = approvePairing({ code: req.code, account: accountOf(approver), accept: true, now: T0 + 2000 });
  assert.equal(r.status, 'approved');
  const poll = pollPairing({ code: req.code, deviceId: pending.id, now: T0 + 3000 });
  assert.equal(poll.status, 'approved');
  assert.equal(poll.accountName, approver.name);

  const newcomer = auth.authenticate(`poly_d_${pending.id}_${secret}`, T0 + 4000);
  assert.equal(newcomer.account.name, approver.name);
});

test('pull:拒绝后 poll denied;过期 410;claim 方向错 E_PAIR_DIRECTION', () => {
  const approver = mkAccount(`批准者${++seq}`);
  const pending = auth.buildPendingDevice(newSecret(), {}, UA);
  const req = requestPullPairing(pending, T0);
  assert.throws(
    () => claimPushPairing(req.code, auth.buildPendingDevice(newSecret(), {}, UA), T0 + 1),
    (e) => e.code === 'E_PAIR_DIRECTION'
  );
  approvePairing({ code: req.code, account: accountOf(approver), accept: false, now: T0 + 2000 });
  assert.equal(pollPairing({ code: req.code, deviceId: pending.id, now: T0 + 3000 }).status, 'denied');

  const pending2 = auth.buildPendingDevice(newSecret(), {}, UA);
  const req2 = requestPullPairing(pending2, T0);
  assert.throws(() => getPairingInfo(req2.code, T0 + 130_000), (e) => e.code === 'E_PAIR_EXPIRED');
});

test('pull 全局上限 500:E_PAIR_BUSY', () => {
  const pending = auth.buildPendingDevice(newSecret(), {}, UA);
  for (let i = 0; i < 500; i++) {
    requestPullPairing(auth.buildPendingDevice(newSecret(), {}, UA), T0 + i);
  }
  assert.throws(() => requestPullPairing(pending, T0 + 1000), (e) => e.code === 'E_PAIR_BUSY');
});

test('清扫:已决记录过期后消失,但已写入的设备不受影响', () => {
  const owner = mkAccount(`发起者${++seq}`);
  const { code } = createPushPairing(accountOf(owner), 'qr', undefined, T0);
  const secret = newSecret();
  const pending = auth.buildPendingDevice(secret, {}, UA);
  claimPushPairing(code, pending, T0 + 1);
  approvePairing({ code, account: accountOf(owner), accept: true, now: T0 + 2 });
  // 决议后 2 分钟:记录被清扫(poll 410),但已写入的设备不受影响 —— 本地凭据照常登录
  assert.throws(() => pollPairing({ code, deviceId: pending.id, now: T0 + 3 * MIN }), (e) =>
    e.code === 'E_PAIR_EXPIRED'
  );
  const newcomer = auth.authenticate(`poly_d_${pending.id}_${secret}`, T0 + 3 * MIN);
  assert.ok(newcomer, '记录清扫后本地凭据必须仍然有效');
});

test('cancel:approved 记录撤销 → 已写入设备一并吊销', () => {
  const owner = mkAccount(`发起者${++seq}`);
  const { code } = createPushPairing(accountOf(owner), 'link', 15, T0);
  const secret = newSecret();
  const pending = auth.buildPendingDevice(secret, {}, UA);
  claimPushPairing(code, pending, T0 + 1);
  approvePairing({ code, account: accountOf(owner), accept: true, now: T0 + 2 });
  const r = cancelPairing({ code, accountId: accountOf(owner).id, now: T0 + 3 });
  assert.equal(r.status, 'cancelled');
  assert.equal(r.revokedDeviceId, pending.id);
  assert.equal(auth.authenticate(`poly_d_${pending.id}_${secret}`, T0 + 4), null);
});

test('deviceOnline:批准后未上线 false,首次鉴权后 true', () => {
  const owner = mkAccount(`发起者${++seq}`);
  const { code } = createPushPairing(accountOf(owner), 'link', 15, T0);
  const secret = newSecret();
  const pending = auth.buildPendingDevice(secret, {}, UA);
  claimPushPairing(code, pending, T0 + 1);
  approvePairing({ code, account: accountOf(owner), accept: true, now: T0 + 2 });

  const before = listPairingsForAccount(accountOf(owner).id, T0 + 3).find((x) => x.code === code);
  assert.equal(before.deviceOnline, false);
  auth.authenticate(`poly_d_${pending.id}_${secret}`, T0 + 4);
  const after = listPairingsForAccount(accountOf(owner).id, T0 + 5).find((x) => x.code === code);
  assert.equal(after.deviceOnline, true);
});

test('countPendingPairings:仅统计本账号 claimed 的 push', () => {
  const owner = mkAccount(`发起者${++seq}`);
  const acc = accountOf(owner);
  assert.equal(countPendingPairings(acc.id, T0), 0);
  const a = createPushPairing(acc, 'qr', undefined, T0).code;
  const b = createPushPairing(acc, 'qr', undefined, T0 + 1).code;
  claimPushPairing(b, auth.buildPendingDevice(newSecret(), {}, UA), T0 + 2);
  assert.equal(countPendingPairings(acc.id, T0 + 3), 1);
  claimPushPairing(a, auth.buildPendingDevice(newSecret(), {}, UA), T0 + 4);
  assert.equal(countPendingPairings(acc.id, T0 + 5), 2);
  approvePairing({ code: b, account: acc, accept: true, now: T0 + 6 });
  assert.equal(countPendingPairings(acc.id, T0 + 7), 1);
});

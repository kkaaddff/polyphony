// 配对登录（扫码 / 邀请链接）服务端状态机:一次性短时效配对码换 token 中转。
// 全内存、单进程、无定时器(惰性清扫);时间参数可注入(node --test 覆盖时间路径)。
// 契约与决策见 docs/pairing-login.md(D1-D15)。
import crypto from 'crypto';

export const QR_TTL_MS = 2 * 60 * 1000; // QR 固定 2 分钟(屏显码,偷拍窗口要短)
export const LINK_TTL_MINUTES = [5, 15, 30, 60]; // 链接档位(分钟),默认 5
export const PICKUP_WINDOW_MS = 2 * 60 * 1000; // 确认后取件窗口(D12)
export const GRACE_MS = 30 * 1000; // 取回宽限:防 poll 响应丢失(D4)
const MAX_ACTIVE = 3; // 单账号活跃配对上限,超出静默淘汰最旧

const pairings = new Map(); // code -> record

function randKey() {
  // 128 位 CSPRNG,base64url 22 字符:在线猜测不可行,故不做限流(§5)
  return crypto.randomBytes(16).toString('base64url');
}

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/** 惰性清扫:未确认态按 expiresAt、已确认态按 max(取走, 取件截止)+宽限。 */
function sweep(now) {
  for (const [code, p] of pairings) {
    const deadline =
      p.pickupDeadline != null
        ? Math.max(p.consumedAt ?? 0, p.pickupDeadline) + GRACE_MS
        : p.expiresAt;
    if (now > deadline) pairings.delete(code);
  }
}

function isActive(p) {
  return p.status === 'pending' || p.status === 'claimed' || p.status === 'approved';
}

/** 创建配对:qr 固定 2 分钟;link 校验档位。超上限静默淘汰本账号最旧活跃项。 */
export function createPairing(account, kind, ttlMinutes, now = Date.now()) {
  if (kind !== 'qr' && kind !== 'link') {
    throw fail('E_PAIR_KIND', 'kind 需为 qr 或 link');
  }
  let ttl;
  if (kind === 'qr') {
    ttl = QR_TTL_MS; // 屏显码忽略 ttlMinutes
  } else {
    const tier = ttlMinutes ?? LINK_TTL_MINUTES[0];
    if (!LINK_TTL_MINUTES.includes(tier)) {
      throw fail('E_PAIR_KIND', `ttlMinutes 需为 ${LINK_TTL_MINUTES.join('/')} 之一`);
    }
    ttl = tier * 60 * 1000;
  }

  sweep(now);
  const mine = [...pairings.values()]
    .filter((p) => p.accountId === account.id && isActive(p))
    .sort((a, b) => a.createdAt - b.createdAt);
  while (mine.length >= MAX_ACTIVE) {
    pairings.delete(mine.shift().code);
  }

  const code = randKey();
  pairings.set(code, {
    code,
    accountId: account.id,
    accountName: account.name, // 快照:info/claim 展示用,账号名创建后不可改
    kind,
    createdAt: now,
    expiresAt: now + ttl,
    status: 'pending',
    claimedMeta: null,
    claimKey: null,
    token: null,
    pickupDeadline: null,
    consumedAt: null,
  });
  return { code, kind, expiresAt: now + ttl };
}

/** 落地页预览:活跃(pending/claimed/approved)可见;终态/未知一律 410,不区分。 */
export function getPairingInfo(code, now = Date.now()) {
  sweep(now);
  const p = pairings.get(code);
  if (!p || !isActive(p)) throw fail('E_PAIR_EXPIRED', '配对码不存在、已过期或已使用');
  return { status: p.status, accountName: p.accountName, kind: p.kind, expiresAt: p.expiresAt };
}

/** claim:仅 pending 可领;claimed → 409(抢扫信号),其余 → 410。签发 claimKey。 */
export function claimPairing(code, ua, now = Date.now()) {
  sweep(now);
  const p = pairings.get(code);
  if (!p) throw fail('E_PAIR_EXPIRED', '配对码不存在或已过期');
  if (p.status !== 'pending') {
    if (p.status === 'claimed') {
      throw fail('E_PAIR_CLAIMED', '配对码已被其他设备使用');
    }
    throw fail('E_PAIR_EXPIRED', '配对码不存在或已过期');
  }
  p.status = 'claimed';
  p.claimedMeta = { ua: String(ua ?? '').slice(0, 200), at: now };
  p.claimKey = randKey();
  return { claimKey: p.claimKey, accountName: p.accountName, expiresAt: p.expiresAt };
}

/** poll:仅 claim 持钥者可访问;approved 首次命中即置 consumed 并交出 token(30s 内幂等)。 */
export function pollPairing(code, key, now = Date.now()) {
  sweep(now);
  const p = pairings.get(code);
  // key 不符与不存在同响应,避免探测
  if (!p || !p.claimKey || key !== p.claimKey) {
    throw fail('E_PAIR_EXPIRED', '配对码不存在或已过期');
  }
  if (p.status === 'claimed' || p.status === 'denied' || p.status === 'cancelled') {
    return { status: p.status };
  }
  // approved / 宽限内 consumed:交出 token(首次命中标 consumed,宽限内可重取)
  if (p.status === 'approved') {
    p.status = 'consumed';
    p.consumedAt = now;
  }
  return {
    status: 'approved',
    token: p.token,
    account: { id: p.accountId, name: p.accountName },
  };
}

/**
 * confirm(owner 专属,仅 claimed 态):accept 时写入 token 并收紧取件截止;
 * 拒绝 → denied(claimKey 保留,手机端 poll 能读到被拒)。
 * token 的合法性(verifyToken + 归属)由路由层校验,这里只做状态机。
 */
export function confirmPairing(code, accountId, accept, token, now = Date.now()) {
  sweep(now);
  const p = pairings.get(code);
  if (!p || p.accountId !== accountId || p.status !== 'claimed') {
    throw fail('E_PAIR_STATE', '配对不存在、非本人或状态已变化');
  }
  if (accept) {
    p.status = 'approved';
    p.token = token;
    p.pickupDeadline = Math.min(p.expiresAt, now + PICKUP_WINDOW_MS);
  } else {
    p.status = 'denied';
  }
  return { status: p.status };
}

/** cancel(owner 专属,活跃三态可撤):清 token;claimKey 保留至清扫,手机端能报「已被撤销」。 */
export function cancelPairing(code, accountId, now = Date.now()) {
  sweep(now);
  const p = pairings.get(code);
  if (!p || p.accountId !== accountId || !isActive(p)) {
    throw fail('E_PAIR_STATE', '配对不存在、非本人或已结束');
  }
  p.status = 'cancelled';
  p.token = null;
  p.pickupDeadline = null; // 回落到 expiresAt 清扫
  return { status: p.status };
}

/** 本账号全部未清扫记录(含终态,弹窗显示最终结果用;sweep 后自然消失)。 */
export function listPairings(accountId, now = Date.now()) {
  sweep(now);
  return [...pairings.values()]
    .filter((p) => p.accountId === accountId)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(({ code, kind, status, expiresAt, claimedMeta }) => ({
      code,
      kind,
      status,
      expiresAt,
      claimedMeta,
    }));
}

/** 测试专用:清空状态(生产代码不得调用)。 */
export function _resetForTest() {
  pairings.clear();
}

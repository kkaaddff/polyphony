// 配对 v2(双向):契约见 docs/identity-and-sharing.md §4.4。
// 与 v1(v3.6.0,未发版)的本质差异:
//  - 双向:push=已登录端发起(码/链接),pull=新设备发起(本机二维码,已登录端扫)
//  - 新设备凭据由设备本地生成(secret 提交一次,服务端只存哈希)——
//    批准即写入设备,轮询幂等且不承载任何秘密(原 D3/D4/D12/GRACE_MS/consumed 全部删除)
//  - 成功以新设备首次上线(last_seen_at 被写)为准,取代 D14 的 consumed 语义
// 纯内存 + 惰性清扫(D10);时钟可注入供测试。
import crypto from 'crypto';
import {
  DEVICE_LIMIT,
  deviceCountFor,
  insertPendingDevice,
  isDeviceOnline,
  revokeDevice,
} from './auth.js';

export const QR_TTL_MS = 120_000;
export const LINK_TTL_MINUTES = [5, 15, 30, 60];
export const PULL_TTL_MS = 120_000;
export const ACTIVE_PUSH_PER_ACCOUNT = 3; // 每账号活跃 push 上限,超出静默淘汰最旧(沿用)
export const ACTIVE_PULL_GLOBAL = 500; // 全局活跃 pull 上限(匿名创建的滥用闸)
const DECIDED_GRACE_MS = 120_000; // 已决记录保留供双端读取的窗口

/** @type {Map<string, object>} */
const pairings = new Map();

function err(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

function newCode() {
  return crypto.randomBytes(16).toString('hex'); // 128-bit
}

/** 惰性清扫:未决按 expiresAt;已决按 decidedAt+GRACE。 */
function sweep(now) {
  for (const [code, p] of pairings) {
    const deadline =
      p.status === 'pending' || p.status === 'claimed'
        ? p.expiresAt
        : p.decidedAt + DECIDED_GRACE_MS;
    if (now > deadline) pairings.delete(code);
  }
}

export function _resetForTest() {
  pairings.clear();
}

// ---------- push(已登录端发起) ----------

export function createPushPairing(account, kind, ttlMinutes, now = Date.now()) {
  sweep(now);
  let expiresAt;
  if (kind === 'qr') {
    expiresAt = now + QR_TTL_MS;
  } else if (kind === 'link') {
    const ttl = LINK_TTL_MINUTES.includes(ttlMinutes) ? ttlMinutes : 5;
    expiresAt = now + ttl * 60_000;
  } else {
    throw err('E_PAIR_KIND', '配对类型须为 qr 或 link');
  }

  // 每账号活跃 push ≤3:静默淘汰最旧(被淘汰者 poll 可见 cancelled)
  const mine = [...pairings.values()]
    .filter((p) => p.direction === 'push' && p.accountId === account.id && (p.status === 'pending' || p.status === 'claimed'))
    .sort((a, b) => a.createdAt - b.createdAt);
  while (mine.length >= ACTIVE_PUSH_PER_ACCOUNT) {
    const oldest = mine.shift();
    oldest.status = 'cancelled';
    oldest.decidedAt = now;
  }

  const p = {
    code: newCode(),
    direction: 'push',
    kind,
    accountId: account.id,
    accountName: account.name,
    pendingDevice: null, // claim 时登记
    status: 'pending',
    createdAt: now,
    expiresAt,
    decidedAt: null,
  };
  pairings.set(p.code, p);
  return { code: p.code, expiresAt: p.expiresAt };
}

// ---------- pull(新设备发起) ----------

export function requestPullPairing(pending, now = Date.now()) {
  sweep(now);
  const activePulls = [...pairings.values()].filter(
    (p) => p.direction === 'pull' && p.status === 'pending'
  ).length;
  if (activePulls >= ACTIVE_PULL_GLOBAL) {
    throw err('E_PAIR_BUSY', '当前配对请求过多,请稍后再试');
  }
  const p = {
    code: newCode(),
    direction: 'pull',
    kind: 'qr',
    accountId: null, // 批准时绑定
    accountName: null,
    pendingDevice: pending,
    status: 'pending',
    createdAt: now,
    expiresAt: now + PULL_TTL_MS,
    decidedAt: null,
  };
  pairings.set(p.code, p);
  return { code: p.code, deviceId: pending.id, expiresAt: p.expiresAt };
}

// ---------- 查询 ----------

export function getPairingInfo(code, now = Date.now()) {
  sweep(now);
  const p = pairings.get(String(code ?? ''));
  if (!p) throw err('E_PAIR_EXPIRED', '配对码不存在或已过期');
  if (p.direction === 'push') {
    // 落地页预览:显示将登录哪个账号(不暴露设备信息)
    return { direction: 'push', kind: p.kind, status: p.status, accountName: p.accountName, expiresAt: p.expiresAt };
  }
  // pull:绝不暴露账号信息,只给新设备平台名(批准页防钓鱼锚点)
  return { direction: 'pull', kind: p.kind, status: p.status, newcomerLabel: p.pendingDevice?.label, expiresAt: p.expiresAt };
}

export function listPairingsForAccount(accountId, now = Date.now()) {
  sweep(now);
  return [...pairings.values()]
    .filter((p) => p.accountId === accountId)
    .map((p) => ({
      code: p.code,
      direction: p.direction,
      kind: p.kind,
      status: p.status,
      accountName: p.accountName,
      newcomerLabel: p.pendingDevice?.label,
      createdAt: p.createdAt,
      expiresAt: p.expiresAt,
      decidedAt: p.decidedAt,
      // 「✓ 该设备已登录」以新设备首次上线为准(取代 D14 consumed)
      deviceOnline: p.status === 'approved' ? isDeviceOnline(p.pendingDevice?.id) : undefined,
    }));
}

export function countPendingPairings(accountId, now = Date.now()) {
  sweep(now);
  let n = 0;
  for (const p of pairings.values()) {
    if (p.accountId === accountId && p.direction === 'push' && p.status === 'claimed') n += 1;
  }
  return n;
}

// ---------- 认领(仅 push) ----------

export function claimPushPairing(code, pending, now = Date.now()) {
  sweep(now);
  const p = pairings.get(String(code ?? ''));
  if (!p) throw err('E_PAIR_EXPIRED', '配对码不存在或已过期');
  if (p.direction !== 'push') throw err('E_PAIR_DIRECTION', '该码需由已登录设备扫码批准,无需认领');
  if (p.status === 'claimed') throw err('E_PAIR_CLAIMED', '配对码已被其他设备使用');
  if (p.status !== 'pending') throw err('E_PAIR_STATE', '配对码不可用');
  p.pendingDevice = pending;
  p.status = 'claimed';
  return { deviceId: pending.id, accountName: p.accountName, expiresAt: p.expiresAt };
}

// ---------- 批准 / 拒绝(会话;该账号任一设备均可,V11) ----------

export function approvePairing({ code, account, accept, now = Date.now() }) {
  sweep(now);
  const p = pairings.get(String(code ?? ''));
  if (!p) throw err('E_PAIR_EXPIRED', '配对码不存在或已过期');

  if (p.direction === 'push') {
    if (p.status !== 'claimed') throw err('E_PAIR_STATE', '配对码尚未被认领或已处理');
    if (p.accountId !== account.id) throw err('E_PAIR_STATE', '只能处理自己账号的配对');
  } else {
    if (p.status !== 'pending') throw err('E_PAIR_STATE', '配对码已处理');
    p.accountId = account.id; // pull:批准时绑定当前账号
    p.accountName = account.name;
  }

  if (!accept) {
    p.status = 'denied';
    p.decidedAt = now;
    return { status: 'denied' };
  }

  if (deviceCountFor(p.accountId) >= DEVICE_LIMIT) {
    throw err('E_DEVICE_LIMIT', '设备数量已达上限,请先吊销不用的设备');
  }
  insertPendingDevice(p.accountId, p.pendingDevice, now);
  p.status = 'approved';
  p.decidedAt = now;
  return { status: 'approved' };
}

// ---------- 轮询(新设备;幂等、无秘密) ----------

export function pollPairing({ code, deviceId, now = Date.now() }) {
  sweep(now);
  const p = pairings.get(String(code ?? ''));
  // 记录不存在与 deviceId 不符同样 410:不给探测面
  if (!p || p.pendingDevice?.id !== String(deviceId ?? '')) {
    throw err('E_PAIR_EXPIRED', '配对码不存在或已过期');
  }
  const out = { status: p.status };
  if (p.status === 'approved') out.accountName = p.accountName;
  return out;
}

// ---------- 撤销(push 发起账号) ----------

export function cancelPairing({ code, accountId, now = Date.now() }) {
  sweep(now);
  const p = pairings.get(String(code ?? ''));
  if (!p) throw err('E_PAIR_EXPIRED', '配对码不存在或已过期');
  if (p.direction !== 'push' || p.accountId !== accountId) {
    throw err('E_PAIR_STATE', '只能撤销自己账号发起的配对');
  }
  let revokedDeviceId = null;
  if (p.status === 'approved') {
    // 已批准的设备一并吊销(等价设备吊销);路由负责断其 WS
    revokeDevice(p.pendingDevice.id);
    revokedDeviceId = p.pendingDevice.id;
  }
  if (p.status !== 'denied') {
    p.status = 'cancelled';
    p.decidedAt = now;
  }
  return revokedDeviceId
    ? { status: p.status, revokedDeviceId }
    : { status: p.status };
}

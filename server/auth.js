// 账号与设备凭据(v4):SQLite 存储。契约见 docs/identity-and-sharing.md §4.1–4.4、§4.7。
// 核心:设备凭据秘密由设备本地生成,服务端只存 sha256、从不下发;
// 全系统服务端生成并下发的秘密只有恢复密钥(仅注册/重生成时出现一次)。
import crypto from 'crypto';
import { getDb, withTx } from './db.js';

export const DEVICE_LIMIT = 20;
const NAME_MAX = 20;
const ACCOUNT_DELETE_GRACE_MS = 30 * 24 * 3600 * 1000; // 注销撤销窗口,与文档回收站同节奏
const SECRET_RE = /^[0-9a-f]{48}$/;
const DEVICE_TOKEN_RE = /^poly_d_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_([0-9a-f]{48})$/;

function err(code, message, extra = {}) {
  const e = new Error(message);
  e.code = code;
  Object.assign(e, extra);
  return e;
}

export function sha256hex(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

// ---------- 平台枚举与服务端拼名(V15:不接受客户端自由文本) ----------

const CLIENTS = ['app', 'web'];
const OSES = ['android', 'ios', 'macos', 'windows', 'linux', 'other'];
const OS_LABEL = { android: 'Android', ios: 'iOS', macos: 'macOS', windows: 'Windows', linux: 'Linux', other: 'Other' };

function osFromUa(ua) {
  if (/Android/i.test(ua)) return 'android';
  if (/iPhone|iPad/i.test(ua)) return 'ios';
  if (/Mac OS X/i.test(ua)) return 'macos';
  if (/Windows/i.test(ua)) return 'windows';
  if (/Linux/i.test(ua)) return 'linux';
  return 'other';
}

function browserFromUa(ua) {
  if (/Edg\//.test(ua)) return 'Edge';
  if (/Chrome\//.test(ua)) return 'Chrome';
  if (/Firefox\//.test(ua)) return 'Firefox';
  if (/Safari\//.test(ua)) return 'Safari';
  return '浏览器';
}

function normalizePlatform(raw, ua) {
  const p = raw && typeof raw === 'object' ? raw : {};
  const client = CLIENTS.includes(p.client) ? p.client : 'web';
  let os = OSES.includes(p.os) ? p.os : 'other';
  if (os === 'other') os = osFromUa(ua); // 客户端没报准时按 UA 兜底,仍落在枚举内
  return { client, os };
}

function labelFor(platform, ua) {
  return platform.client === 'app'
    ? `App · ${OS_LABEL[platform.os]}`
    : `${browserFromUa(ua)} · ${OS_LABEL[platform.os]}`;
}

// ---------- 凭据 ----------

function assertSecret(secret) {
  if (typeof secret !== 'string' || !SECRET_RE.test(secret)) {
    throw err('E_SECRET_INVALID', '设备秘密格式无效');
  }
}

/** 解析 `poly_d_<uuid>_<secret>`;其余格式(含恢复密钥)一律 null。 */
export function parseCredential(token) {
  if (typeof token !== 'string') return null;
  const m = token.match(DEVICE_TOKEN_RE);
  return m ? { deviceId: m[1], secret: m[2] } : null;
}

function insertDevice(accountId, secret, rawPlatform, ua, now) {
  const platform = normalizePlatform(rawPlatform, ua);
  const deviceId = crypto.randomUUID();
  getDb()
    .prepare(
      'INSERT INTO devices (id, account_id, hash, client, os, label, created_at) VALUES (?,?,?,?,?,?,?)'
    )
    .run(deviceId, accountId, sha256hex(secret), platform.client, platform.os, labelFor(platform, ua), now);
  return deviceId;
}

export function deviceCountFor(accountId) {
  return getDb().prepare('SELECT COUNT(*) AS n FROM devices WHERE account_id = ?').get(accountId).n;
}

// ---- 供配对 v2 使用:新设备凭据在批准前先以 pendingDevice 形态登记 ----

/** 生成本地 secret 已生成设备的登记材料(id/hash/平台/拼名)。 */
export function buildPendingDevice(secret, rawPlatform, ua) {
  assertSecret(secret);
  const platform = normalizePlatform(rawPlatform, ua);
  return {
    id: crypto.randomUUID(),
    hash: sha256hex(secret),
    client: platform.client,
    os: platform.os,
    label: labelFor(platform, ua),
  };
}

/** 批准时把 pendingDevice 写入账号(INSERT;id/hash/label 均已就绪)。 */
export function insertPendingDevice(accountId, pending, now = Date.now()) {
  getDb()
    .prepare(
      'INSERT INTO devices (id, account_id, hash, client, os, label, created_at) VALUES (?,?,?,?,?,?,?)'
    )
    .run(pending.id, accountId, pending.hash, pending.client, pending.os, pending.label, now);
}

export function isDeviceOnline(deviceId) {
  const row = getDb().prepare('SELECT last_seen_at FROM devices WHERE id = ?').get(deviceId);
  return Boolean(row && row.last_seen_at !== null);
}

// ---------- 账号 ----------

/** 创建账号(全端):本地已生成 secret,服务端登记哈希 + 生成一次性恢复密钥。 */
export function createAccount({ name: rawName, secret, platform, ua }, now = Date.now()) {
  const name = String(rawName ?? '').trim();
  if (!name || name.length > NAME_MAX) {
    throw err('E_NAME_INVALID', '用户名需为 1-20 个字符');
  }
  assertSecret(secret);
  const recoveryKey = 'poly_r_' + crypto.randomBytes(24).toString('hex');
  const accountId = crypto.randomUUID();
  return withTx(() => {
    // 注销中的账号仍占用用户名(V24),彻底删除后才释放 —— UNIQUE 约束兜底
    if (getDb().prepare('SELECT 1 FROM accounts WHERE name = ?').get(name)) {
      throw err('E_NAME_TAKEN', '用户名已被占用');
    }
    getDb()
      .prepare('INSERT INTO accounts (id, name, recovery_hash, created_at) VALUES (?,?,?,?)')
      .run(accountId, name, sha256hex(recoveryKey), now);
    const deviceId = insertDevice(accountId, secret, platform, ua, now);
    return { name, deviceId, recoveryKey };
  });
}

// last_seen_at 写库节流:距库中值 ≥1h 才 UPDATE,避免每请求写库
/** 鉴权:设备凭据 → { account, device };任何不匹配返回 null。 */
export function authenticate(token, now = Date.now()) {
  const parsed = parseCredential(token);
  if (!parsed) return null;
  const row = getDb()
    .prepare(
      `SELECT d.id AS device_id, d.hash, d.label, d.client, d.os, d.created_at, d.last_seen_at,
              a.id AS account_id, a.name, a.deleted_at
         FROM devices d JOIN accounts a ON a.id = d.account_id
        WHERE d.id = ?`
    )
    .get(parsed.deviceId);
  if (!row || row.hash !== sha256hex(parsed.secret) || row.deleted_at) return null;

  if (row.last_seen_at === null || now - row.last_seen_at >= 3600_000) {
    getDb().prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(now, row.device_id);
    row.last_seen_at = now;
  }
  return {
    account: { id: row.account_id, name: row.name },
    device: {
      id: row.device_id,
      label: row.label,
      client: row.client,
      os: row.os,
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
    },
  };
}

/** 恢复密钥兑换本机设备凭据。 */
export function exchange({ key, secret, platform, ua }, now = Date.now()) {
  assertSecret(secret);
  if (typeof key !== 'string' || !/^poly_r_[0-9a-f]{48}$/.test(key)) {
    throw err('E_UNAUTHORIZED', '恢复密钥无效');
  }
  const account = getDb()
    .prepare('SELECT id, name, deleted_at FROM accounts WHERE recovery_hash = ?')
    .get(sha256hex(key));
  if (!account) throw err('E_UNAUTHORIZED', '恢复密钥无效');
  if (account.deleted_at) {
    throw err('E_ACCOUNT_DELETED', '该账号正在注销', {
      purgeAt: account.deleted_at + ACCOUNT_DELETE_GRACE_MS,
    });
  }
  if (deviceCountFor(account.id) >= DEVICE_LIMIT) {
    throw err('E_DEVICE_LIMIT', '设备数量已达上限,请先吊销不用的设备');
  }
  const deviceId = insertDevice(account.id, secret, platform, ua, now);
  return { name: account.name, deviceId };
}

export function listDevices(accountId, currentDeviceId) {
  const rows = getDb()
    .prepare('SELECT id, label, created_at, last_seen_at FROM devices WHERE account_id = ? ORDER BY created_at')
    .all(accountId);
  return rows.map((r) => ({
    id: r.id,
    label: r.label,
    createdAt: r.created_at,
    lastSeenAt: r.last_seen_at,
    current: r.id === currentDeviceId,
  }));
}

/** 吊销设备;返回 { accountId } 供路由关闭其 WS。 */
export function revokeDevice(deviceId) {
  const row = getDb().prepare('SELECT account_id FROM devices WHERE id = ?').get(deviceId);
  if (!row) return null;
  getDb().prepare('DELETE FROM devices WHERE id = ?').run(deviceId);
  return { accountId: row.account_id };
}

export function regenerateRecovery(accountId) {
  const recoveryKey = 'poly_r_' + crypto.randomBytes(24).toString('hex');
  getDb().prepare('UPDATE accounts SET recovery_hash = ? WHERE id = ?').run(sha256hex(recoveryKey), accountId);
  return recoveryKey;
}

// ---------- 注销账号(§4.7) ----------

/**
 * 注销:单事务内标记 deleted_at、删除全部设备、自有 active 文档进回收站。
 * 返回 { deviceIds, docCodes } 供路由立即关闭对应 WS。
 */
export function deleteAccount({ accountId, name: rawName, now = Date.now() }) {
  const name = String(rawName ?? '').trim();
  return withTx(() => {
    const account = getDb().prepare('SELECT name, deleted_at FROM accounts WHERE id = ?').get(accountId);
    if (!account) throw err('E_NOT_FOUND', '账号不存在');
    if (account.name !== name) throw err('E_NAME_MISMATCH', '输入的用户名与账号不一致');
    if (account.deleted_at) throw err('E_ACCOUNT_STATE', '账号已在注销中');

    const docCodes = getDb()
      .prepare("SELECT code FROM docs WHERE owner_id = ? AND status = 'active'")
      .all(accountId)
      .map((r) => r.code);
    const deviceIds = getDb()
      .prepare('SELECT id FROM devices WHERE account_id = ?')
      .all(accountId)
      .map((r) => r.id);

    getDb().prepare('UPDATE accounts SET deleted_at = ? WHERE id = ?').run(now, accountId);
    if (docCodes.length > 0) {
      getDb()
        .prepare(
          "UPDATE docs SET status = 'trashed', trash_reason = 'account_deleted', trashed_at = ? WHERE owner_id = ? AND status = 'active'"
        )
        .run(now, accountId);
    }
    getDb().prepare('DELETE FROM devices WHERE account_id = ?').run(accountId);
    return { deviceIds, docCodes };
  });
}

/** 撤销注销(恢复密钥):账号恢复 + account_deleted 文档恢复 active + 登记新设备。 */
export function restoreAccount({ key, secret, platform, ua }, now = Date.now()) {
  assertSecret(secret);
  if (typeof key !== 'string' || !/^poly_r_[0-9a-f]{48}$/.test(key)) {
    throw err('E_UNAUTHORIZED', '恢复密钥无效');
  }
  const account = getDb()
    .prepare('SELECT id, name, deleted_at FROM accounts WHERE recovery_hash = ?')
    .get(sha256hex(key));
  if (!account) throw err('E_UNAUTHORIZED', '恢复密钥无效');
  if (!account.deleted_at) throw err('E_ACCOUNT_ACTIVE', '该账号不在注销中');

  return withTx(() => {
    getDb().prepare('UPDATE accounts SET deleted_at = NULL WHERE id = ?').run(account.id);
    getDb()
      .prepare(
        "UPDATE docs SET status = 'active', trash_reason = NULL, trashed_at = NULL WHERE owner_id = ? AND status = 'trashed' AND trash_reason = 'account_deleted'"
      )
      .run(account.id);
    const deviceId = insertDevice(account.id, secret, platform, ua, now);
    return { name: account.name, deviceId };
  });
}

// ---------- 清扫(sweeper.js 每小时调度;账号 30 天到期清除随 L1 的文档 purge 一起接入) ----------

const ORPHAN_MS = 24 * 3600 * 1000; // 批准后从未上线的设备
const INACTIVE_MS = 180 * 24 * 3600 * 1000; // 长期不活动自动吊销(V20)

export function sweepDevices(now = Date.now()) {
  const db = getDb();
  const orphan = db
    .prepare('DELETE FROM devices WHERE last_seen_at IS NULL AND created_at < ?')
    .run(now - ORPHAN_MS).changes;
  const inactive = db
    .prepare('DELETE FROM devices WHERE last_seen_at IS NOT NULL AND last_seen_at < ?')
    .run(now - INACTIVE_MS).changes;
  return { orphan, inactive };
}

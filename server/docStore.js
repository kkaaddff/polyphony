// 文档存储与持久化(docs/document-lifecycle.md §4.2):
// - 内容快照 = Y.encodeStateAsUpdate 存 SQLite docs.state(BLOB)
// - bindState 同步读盘(y-websocket 不 await,同步消除首客户端空文档竞态 L8)
// - 防抖写库(静默 2s / 最长 10s);最后一人断开立即写并卸载(内存不再泄漏)
// - 停写标志:purge 先停写再断开再删,防止 writeState 把快照写回(L19)
// - 文档名单源:写库时从 meta.roomName 同步到 docs.name(L25)
import * as Y from 'yjs';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { getDb, withTx, dataDir } from './db.js';
import { uploadsDir } from './resetV3.js';

const DEBOUNCE_MS = 2_000;
const MAX_DIRTY_MS = 10_000;
const CODE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

function err(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

// ---------- 生命周期查询(WS 门控 / 路由共用) ----------

export function getDocRow(code) {
  return getDb().prepare('SELECT * FROM docs WHERE code = ?').get(String(code ?? '').toUpperCase());
}

/**
 * WS 连接前检查:不存在/已清除 → { allowed: false, closeCode: 4004 };
 * 回收站 → { allowed: false, closeCode: 4010 };正常 → { allowed: true }。
 * 顺带节流更新 last_access_at(1h,不活动过期的计时节拍)。
 */
const lastAccessFlushed = new Map();

export function checkDocForConnection(code, now = Date.now()) {
  const row = getDocRow(code);
  if (!row || row.status === 'purged') return { allowed: false, closeCode: 4004, reason: 'doc missing' };
  if (row.status === 'trashed') return { allowed: false, closeCode: 4010, reason: 'doc trashed' };
  const key = row.code;
  const last = lastAccessFlushed.get(key) ?? row.last_access_at;
  if (now - last >= 3_600_000) {
    getDb().prepare('UPDATE docs SET last_access_at = ? WHERE code = ?').run(now, key);
    lastAccessFlushed.set(key, now);
  }
  return { allowed: true, row };
}

// ---------- 创建 / 状态迁移(L2 路由使用) ----------

/** 生成 8 位 [A-Z0-9] 码,与 docs 表(含墓碑)去重。 */
export function generateDocCode() {
  const db = getDb();
  for (;;) {
    let code = '';
    for (let i = 0; i < 8; i++) code += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
    if (!db.prepare('SELECT 1 FROM docs WHERE code = ?').get(code)) return code;
  }
}

/** 创建文档:单事务写 docs + owner 成员关系(原子性验收项)。 */
export function createDoc({ ownerId, name = '', now = Date.now() }) {
  const db = getDb();
  return withTx(() => {
    const code = generateDocCode();
    db.prepare(
      "INSERT INTO docs (code, owner_id, name, status, created_at, last_access_at) VALUES (?,?,?,'active',?,?)"
    ).run(code, ownerId, String(name).slice(0, 40), now, now);
    db.prepare(
      "INSERT INTO memberships (account_id, doc_code, role, last_used) VALUES (?,?,'owner',?)"
    ).run(ownerId, code, now);
    return { code };
  });
}

/** active → trashed(reason: owner|inactive|account_deleted)。 */
export function trashDoc(code, reason, now = Date.now()) {
  const res = getDb()
    .prepare(
      "UPDATE docs SET status = 'trashed', trash_reason = ?, trashed_at = ? WHERE code = ? AND status = 'active'"
    )
    .run(reason, now, String(code).toUpperCase());
  if (res.changes === 0) throw err('E_DOC_STATE', '文档不在可删除状态');
}

/** trashed → active(所有者恢复)。 */
export function restoreDoc(code, now = Date.now()) {
  const res = getDb()
    .prepare(
      "UPDATE docs SET status = 'active', trash_reason = NULL, trashed_at = NULL WHERE code = ? AND status = 'trashed'"
    )
    .run(String(code).toUpperCase());
  if (res.changes === 0) throw err('E_DOC_STATE', '文档不在回收站');
}

/**
 * 彻底清除(顺序固定,L19):
 * 1) 停写 + 取消防抖(防 writeState 写回);2) 断开在线连接(路由负责);
 * 3) 单事务:删 memberships/doc_refs/attachments 行 + docs 降为墓碑(state 置 NULL);
 * 4) 事务提交后删 uploads/<码>/ 目录(崩溃由调度器孤儿目录清理兜底)。
 * 返回被清附件的磁盘 key 列表(供日志/测试)。
 */
export function purgeDoc(code, now = Date.now()) {
  const docCode = String(code).toUpperCase();
  stopWrites(docCode);

  const removed = withTx(() => {
    const db = getDb();
    const attachments = db.prepare('SELECT key FROM attachments WHERE doc_code = ?').all(docCode);
    db.prepare('DELETE FROM memberships WHERE doc_code = ?').run(docCode);
    db.prepare('DELETE FROM doc_refs WHERE doc_code = ?').run(docCode);
    db.prepare('DELETE FROM attachments WHERE doc_code = ?').run(docCode);
    db.prepare(
      "UPDATE docs SET status = 'purged', purged_at = ?, owner_id = NULL, name = '', trash_reason = NULL, trashed_at = NULL, state = NULL WHERE code = ?"
    ).run(now, docCode);
    lastAccessFlushed.delete(docCode);
    return attachments.map((a) => a.key);
  });

  const dir = path.join(uploadsDir(), docCode);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  return removed;
}

// ---------- 清扫(§4.6;调度器每小时跑) ----------

const INACTIVE_MS = 365 * 24 * 3600 * 1000; // 1 年无人访问 → 回收站
const TRASH_MS = 30 * 24 * 3600 * 1000; // 回收站 30 天 → 清除
const ACCOUNT_DELETE_MS = 30 * 24 * 3600 * 1000; // 注销 30 天 → 账号与文档同日清除

export function sweepDocs(now = Date.now()) {
  const db = getDb();
  const inactive = db
    .prepare(
      "UPDATE docs SET status = 'trashed', trash_reason = 'inactive', trashed_at = ? WHERE status = 'active' AND last_access_at < ?"
    )
    .run(now, now - INACTIVE_MS).changes;

  // 到期清除:含 account_deleted(与注销账号同日)
  const expired = db
    .prepare('SELECT code FROM docs WHERE status = \'trashed\' AND trashed_at < ?')
    .all(now - TRASH_MS)
    .map((r) => r.code);
  let purged = 0;
  for (const code of expired) {
    purgeDoc(code, now);
    purged += 1;
  }

  // 注销到期:先清其 account_deleted 文档,再删账号行(级联设备/成员关系,用户名释放)
  const dueAccounts = db
    .prepare('SELECT id, name FROM accounts WHERE deleted_at IS NOT NULL AND deleted_at < ?')
    .all(now - ACCOUNT_DELETE_MS);
  for (const acc of dueAccounts) {
    const docs = db
      .prepare("SELECT code FROM docs WHERE owner_id = ? AND status = 'trashed' AND trash_reason = 'account_deleted'")
      .all(acc.id)
      .map((r) => r.code);
    for (const code of docs) {
      purgeDoc(code, now);
      purged += 1;
    }
    db.prepare('DELETE FROM accounts WHERE id = ?').run(acc.id);
    console.log(`[auth] account-purge ${acc.name} docs=${docs.length}`);
  }

  return { inactive, purged, accounts: dueAccounts.length };
}

/** 回收站列表(所有者视角)。 */
export function listTrash(ownerId) {
  return getDb()
    .prepare(
      "SELECT code, name, trash_reason AS trashReason, trashed_at AS trashedAt FROM docs WHERE owner_id = ? AND status = 'trashed' ORDER BY trashed_at DESC"
    )
    .all(ownerId);
}

// ---------- 快照持久化(setPersistence 接入 y-websocket) ----------

const DEBOUNCED = new Map(); // code → { timer, maxTimer, dirty, writable }

function writeSnapshot(code, ydoc, now = Date.now()) {
  const slot = DEBOUNCED.get(code);
  if (slot && !slot.writable) return; // 停写后一律空操作(L19)
  const state = Y.encodeStateAsUpdate(ydoc);
  const roomName = String(ydoc.getMap('meta').get('roomName') ?? '').slice(0, 40);
  getDb().prepare('UPDATE docs SET state = ?, name = ? WHERE code = ?').run(state, roomName, code);
  if (slot) {
    slot.dirty = false;
    slot.lastWrite = now;
  }
}

function stopWrites(code) {
  const slot = DEBOUNCED.get(code);
  if (!slot) {
    DEBOUNCED.set(code, { timer: null, maxTimer: null, dirty: false, writable: false, lastWrite: 0 });
    return;
  }
  if (slot.timer) clearTimeout(slot.timer);
  if (slot.maxTimer) clearTimeout(slot.maxTimer);
  slot.timer = slot.maxTimer = null;
  slot.writable = false;
}

/** 活动文档引用(bindState 登记,destroy 移除;flushAllSync 用)。 */
const YDOCS = new Map();

/** 进程收 SIGTERM:同步刷写所有可写脏文档(容器重建不丢最近 10s)。 */
export function flushAllSync(now = Date.now()) {
  for (const slot of DEBOUNCED.values()) {
    if (slot.timer) clearTimeout(slot.timer);
    if (slot.maxTimer) clearTimeout(slot.maxTimer);
    slot.timer = slot.maxTimer = null;
  }
  for (const [code, slot] of DEBOUNCED) {
    if (!slot.dirty || !slot.writable) continue;
    const doc = YDOCS.get(code);
    if (doc) writeSnapshot(code, doc, now);
  }
}

export function makePersistence() {
  return {
    bindState(code, ydoc) {
      // 同步读盘:首客户端的 sync 消息处理前,文档已就绪(L8)
      const row = getDb().prepare('SELECT state FROM docs WHERE code = ?').get(code);
      if (row?.state) {
        try {
          Y.applyUpdate(ydoc, row.state);
        } catch (e) {
          // 数据异常:另存 + 按空文档继续(客户端缓存补齐)
          console.error(`[docs] snapshot corrupt ${code}: ${e.message}`);
          saveCorrupt(code, row.state);
        }
      }
      const slot = { timer: null, maxTimer: null, dirty: false, writable: true, lastWrite: Date.now() };
      DEBOUNCED.set(code, slot);
      YDOCS.set(code, ydoc);
      ydoc.on('update', () => {
        if (!slot.writable) return;
        slot.dirty = true;
        if (slot.timer) clearTimeout(slot.timer);
        slot.timer = setTimeout(() => {
          slot.timer = null;
          if (slot.dirty && slot.writable) writeSnapshot(code, ydoc);
        }, DEBOUNCE_MS);
        if (!slot.maxTimer) {
          slot.maxTimer = setTimeout(() => {
            slot.maxTimer = null;
            if (slot.dirty && slot.writable) writeSnapshot(code, ydoc);
          }, MAX_DIRTY_MS);
        }
      });
      ydoc.on('destroy', () => {
        if (slot.timer) clearTimeout(slot.timer);
        if (slot.maxTimer) clearTimeout(slot.maxTimer);
        DEBOUNCED.delete(code);
        YDOCS.delete(code);
      });
    },
    writeState(code, ydoc) {
      // 最后一人断开:立即写盘(y-websocket 随后 destroy 释放内存);
      // 已停写(purge 中)则空操作
      writeSnapshot(code, ydoc);
      const slot = DEBOUNCED.get(code);
      if (slot && slot.timer) clearTimeout(slot.timer);
      if (slot && slot.maxTimer) clearTimeout(slot.maxTimer);
      return Promise.resolve();
    },
  };
}

function saveCorrupt(code, blob) {
  try {
    const base = dataDir();
    fs.mkdirSync(path.join(base, 'corrupt'), { recursive: true });
    fs.writeFileSync(path.join(base, 'corrupt', `${code}-${Date.now()}.ystate`), blob);
  } catch {
    /* 尽力而为 */
  }
}

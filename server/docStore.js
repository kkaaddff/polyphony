// 文档存储与持久化(docs/document-lifecycle.md §4.2):
// - 内容快照 = Y.encodeStateAsUpdate 存 SQLite docs.state(BLOB)
// - bindState 同步读盘(y-websocket 不 await,同步消除首客户端空文档竞态 L8)
// - 防抖写库(静默 2s / 最长 10s);最后一人断开立即写并卸载(内存不再泄漏)
// - 停写标志:purge 先停写再断开再删,防止 writeState 把快照写回(L19)
// - 文档名单源:写库时从 meta.roomName 同步到 docs.name(L25)
import Y from './yjs.js';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { getDb, withTx, dataDir } from './db.js';
import { uploadsDir } from './resetV3.js';
import { applyRefs, sweepAttachments } from './attachments.js';

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
    // 他文档指向本档附件的悬空引用一并清(purge 无条件删附件,L9)
    db.prepare('DELETE FROM doc_refs WHERE attachment_key IN (SELECT key FROM attachments WHERE doc_code = ?)').run(docCode);
    db.prepare('DELETE FROM memberships WHERE doc_code = ?').run(docCode);
    db.prepare('DELETE FROM doc_refs WHERE doc_code = ?').run(docCode);
    db.prepare('DELETE FROM attachments WHERE doc_code = ?').run(docCode);
    db.prepare(
      "UPDATE docs SET status = 'purged', purged_at = ?, owner_id = NULL, name = '', trash_reason = NULL, trashed_at = NULL, state = NULL WHERE code = ?"
    ).run(now, docCode);
    lastAccessFlushed.delete(docCode);
    return attachments.map((a) => a.key);
  });
  PREVIEW_CACHE.delete(docCode);

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

  // 附件:无引用满 30 天回收 + 孤儿目录兜底
  const att = sweepAttachments(now);

  return { inactive, purged, accounts: dueAccounts.length, ...att };
}

/** 导出用:读正文与文档名(优先内存活文档,否则解码快照)。 */
export function readDocForExport(code) {
  const docCode = String(code ?? '').toUpperCase();
  const live = YDOCS.get(docCode);
  if (live) {
    return {
      name: String(live.getMap('meta').get('roomName') ?? docCode).slice(0, 40),
      text: live.getText('document').toString(),
    };
  }
  const row = getDb().prepare('SELECT state, name, status FROM docs WHERE code = ?').get(docCode);
  if (!row || row.status === 'purged') return null;
  if (!row.state) return { name: row.name || docCode, text: '' };
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, row.state);
  } catch {
    return { name: row.name || docCode, text: '' };
  }
  const metaName = String(doc.getMap('meta').get('roomName') ?? '').slice(0, 40);
  return { name: metaName || row.name || docCode, text: doc.getText('document').toString() };
}

/** 回收站列表(所有者视角)。 */
export function listTrash(ownerId) {
  return getDb()
    .prepare(
      "SELECT code, name, trash_reason AS trashReason, trashed_at AS trashedAt FROM docs WHERE owner_id = ? AND status = 'trashed' ORDER BY trashed_at DESC"
    )
    .all(ownerId)
    .map((row) => ({ ...row, preview: docPreview(row.code) }));
}

// ---------- 列表预览(未命名文档在列表里以正文开头代替标题) ----------

const PREVIEW_MAX = 40;
/** 非活文档的预览缓存(code → 文本);快照落盘时刷新、purge 时删除,读不到才解码一次快照。 */
const PREVIEW_CACHE = new Map();

/**
 * Markdown 正文 → 第一行有内容的纯文本(去图片/链接地址/HTML/列表与标题标记/强调符号/MDX 转义),
 * 最多 PREVIEW_MAX 个字符(按码点截,不切坏 emoji)。全空返回 ''。
 */
export function textPreview(markdown) {
  for (const raw of String(markdown ?? '').split('\n')) {
    const line = raw
      .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ') // 图片
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // 链接只留文字
      .replace(/<[^>]+>/g, ' ') // HTML 标签
      .replace(/&(?:nbsp|#x20|#32);/g, ' ') // MDXEditor 写出的空格实体
      .replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s*)?/, '') // 列表 / 任务列表
      .replace(/^\s*(?:#{1,6}|>+)\s*/, '') // 标题 / 引用
      .replace(/(?<!\\)[*_~`]+/g, '') // 强调 / 行内代码标记(转义的保留)
      .replace(/\\([\\`*_{}[\]()#+\-.!|~>])/g, '$1') // MDX 转义还原
      .replace(/\s+/g, ' ')
      .trim();
    // 跳过表格分隔行、分割线、代码围栏这类只剩符号的行
    if (line && !/^[-*_=|:\s]+$/.test(line)) return Array.from(line).slice(0, PREVIEW_MAX).join('');
  }
  return '';
}

/**
 * 活文档的当前共享名(内存 meta,不等 2s 防抖落库)。未加载、或 meta 里从没设过名
 * (如 POST /docs 时带 name 创建、尚无人改名)返回 null,由调用方回落到库里的 docs.name。
 */
export function liveDocName(code) {
  const meta = YDOCS.get(String(code ?? '').toUpperCase())?.getMap('meta');
  return meta?.has('roomName') ? String(meta.get('roomName') ?? '').slice(0, 40) : null;
}

/** 文档列表预览:活文档读内存(始终最新),否则用缓存/解码快照。 */
export function docPreview(code) {
  const docCode = String(code ?? '').toUpperCase();
  const live = YDOCS.get(docCode);
  if (live) return textPreview(live.getText('document').toString());
  if (PREVIEW_CACHE.has(docCode)) return PREVIEW_CACHE.get(docCode);
  const row = getDb().prepare('SELECT state FROM docs WHERE code = ?').get(docCode);
  let preview = '';
  if (row?.state) {
    const doc = new Y.Doc();
    try {
      Y.applyUpdate(doc, row.state);
      preview = textPreview(doc.getText('document').toString());
    } catch {
      /* 快照异常:按无预览处理 */
    } finally {
      doc.destroy();
    }
  }
  PREVIEW_CACHE.set(docCode, preview);
  return preview;
}

// ---------- 快照持久化(setPersistence 接入 y-websocket) ----------

const DEBOUNCED = new Map(); // code → { timer, maxTimer, dirty, writable }

function writeSnapshot(code, ydoc, now = Date.now()) {
  const slot = DEBOUNCED.get(code);
  if (slot && !slot.writable) return; // 停写后一律空操作(L19)
  const state = Y.encodeStateAsUpdate(ydoc);
  const meta = ydoc.getMap('meta');
  // meta 从没设过名时保留库里的 docs.name(创建时带的名),不拿空串覆盖
  const roomName = meta.has('roomName') ? String(meta.get('roomName') ?? '').slice(0, 40) : null;
  const text = ydoc.getText('document').toString();
  // 快照与引用 diff 同一事务;refs 无变化时 applyRefs 不写任何行(L20)
  withTx(() => {
    getDb()
      .prepare('UPDATE docs SET state = ?, name = COALESCE(?, name) WHERE code = ?')
      .run(state, roomName, code);
    applyRefs(code, text, now);
  });
  PREVIEW_CACHE.set(code, textPreview(text));
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

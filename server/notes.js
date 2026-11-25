// 语音便签(docs/voice-input.md §6):账号级的短文本流,每次「发送」追加一条,全端共用。
// 保留天数按账号设置(0 = 永久);过期条目读取时即不可见,sweeper 每小时物理删除。
// 与输入通道(inputRelay.js)无关:中继仍然不落库,便签是用户显式保存的内容。
import crypto from 'crypto';
import { getDb } from './db.js';

export const MAX_NOTE_CHARS = 4000;
export const MAX_NOTES_PER_ACCOUNT = 5000;
export const DEFAULT_RETENTION_DAYS = 30;
export const MAX_RETENTION_DAYS = 3650;
const DAY_MS = 24 * 3600_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function err(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

const toNote = (r) => ({ id: r.id, text: r.text, createdAt: r.created_at, device: r.device_label });

export function getRetentionDays(accountId) {
  const row = getDb().prepare('SELECT retention_days FROM note_settings WHERE account_id = ?').get(accountId);
  return row ? row.retention_days : DEFAULT_RETENTION_DAYS;
}

/** 0 = 永久;其余 1..3650 的整数。缩短保留期立即清掉已过期的条目。 */
export function setRetentionDays(accountId, days, now = Date.now()) {
  if (!Number.isInteger(days) || days < 0 || days > MAX_RETENTION_DAYS) {
    throw err('E_NOTE_INVALID', '保留天数无效');
  }
  getDb()
    .prepare(
      `INSERT INTO note_settings (account_id, retention_days) VALUES (?, ?)
       ON CONFLICT(account_id) DO UPDATE SET retention_days = excluded.retention_days`
    )
    .run(accountId, days);
  purgeExpired(accountId, now);
  return days;
}

function cutoff(accountId, now) {
  const days = getRetentionDays(accountId);
  return days > 0 ? now - days * DAY_MS : 0;
}

function purgeExpired(accountId, now) {
  const c = cutoff(accountId, now);
  if (c > 0) getDb().prepare('DELETE FROM notes WHERE account_id = ? AND created_at < ?').run(accountId, c);
}

/**
 * 追加一条。id 由客户端生成时幂等(离线补传/重试不产生重复);createdAt 可由客户端提供
 * (离线时写下的时间),但不能晚于服务端当前时间。
 */
export function addNote(accountId, { id, text, createdAt, deviceLabel } = {}, now = Date.now()) {
  if (typeof text !== 'string') throw err('E_NOTE_INVALID', '便签内容无效');
  const body = text.trim();
  if (!body || body.length > MAX_NOTE_CHARS) throw err('E_NOTE_INVALID', '便签内容为空或过长');
  if (id !== undefined && (typeof id !== 'string' || !UUID_RE.test(id))) {
    throw err('E_NOTE_INVALID', '便签 id 无效');
  }
  const noteId = id ?? crypto.randomUUID();
  const at = Number.isSafeInteger(createdAt) && createdAt > 0 ? Math.min(createdAt, now) : now;
  const db = getDb();

  const existing = db.prepare('SELECT id, account_id, text, created_at, device_label FROM notes WHERE id = ?').get(noteId);
  if (existing) {
    // 别的账号的 id 不可见也不可覆盖
    if (existing.account_id !== accountId) throw err('E_NOTE_CONFLICT', '便签 id 冲突');
    return { note: toNote(existing), created: false };
  }
  db.prepare('INSERT INTO notes (id, account_id, text, created_at, device_label) VALUES (?,?,?,?,?)').run(
    noteId,
    accountId,
    body,
    at,
    String(deviceLabel ?? '').slice(0, 64)
  );
  // 容量上限:挤掉最旧的
  db.prepare(
    `DELETE FROM notes WHERE account_id = ? AND id IN (
       SELECT id FROM notes WHERE account_id = ? ORDER BY created_at DESC, id DESC LIMIT -1 OFFSET ?)`
  ).run(accountId, accountId, MAX_NOTES_PER_ACCOUNT);
  return { note: { id: noteId, text: body, createdAt: at, device: String(deviceLabel ?? '').slice(0, 64) }, created: true };
}

/** 新 → 旧分页;q 为子串搜索(LIKE,通配符转义);before 为上一页最后一条的 createdAt。 */
export function listNotes(accountId, { q = '', limit = 100, before } = {}, now = Date.now()) {
  const lim = Math.min(Math.max(Number.parseInt(limit, 10) || 100, 1), 500);
  const where = ['account_id = ?', 'created_at >= ?'];
  const args = [accountId, cutoff(accountId, now)];
  const needle = String(q ?? '').trim().slice(0, 200);
  if (needle) {
    where.push("text LIKE ? ESCAPE '\\'");
    args.push(`%${needle.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
  }
  const b = Number(before);
  if (Number.isSafeInteger(b) && b > 0) {
    where.push('created_at < ?');
    args.push(b);
  }
  const rows = getDb()
    .prepare(
      `SELECT id, text, created_at, device_label FROM notes
        WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ?`
    )
    .all(...args, lim + 1);
  return { notes: rows.slice(0, lim).map(toNote), hasMore: rows.length > lim };
}

export function deleteNote(accountId, id) {
  const r = getDb().prepare('DELETE FROM notes WHERE account_id = ? AND id = ?').run(accountId, String(id ?? ''));
  return r.changes > 0;
}

/** 清扫全部账号的过期便签(sweeper 每小时);返回删除条数。 */
export function sweepNotes(now = Date.now()) {
  const r = getDb()
    .prepare(
      `DELETE FROM notes WHERE created_at < ? - ${DAY_MS} * COALESCE(
         (SELECT NULLIF(retention_days, 0) FROM note_settings s WHERE s.account_id = notes.account_id),
         CASE WHEN EXISTS (SELECT 1 FROM note_settings s WHERE s.account_id = notes.account_id)
              THEN NULL ELSE ${DEFAULT_RETENTION_DAYS} END)`
    )
    .run(now);
  return Number(r.changes);
}

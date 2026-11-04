// 附件登记/引用/回收(docs/document-lifecycle.md §4.5):
// - 附件属于某文档(uploads/<码>/<32hex>.<ext>),读取免登录(128-bit 熵 + 文档状态校验 L10)
// - 引用扫描在文档写库时执行:正文里出现的 /uploads/<码>/<文件> 维护 doc_refs
// - 回收按全局引用:任何 active/trashed 文档引用即保留;无引用满 30 天删文件与登记
// - purge 无条件删除名下附件,并清掉他文档指向这些附件的悬空引用(L9)
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { getDb, withTx } from './db.js';
import { uploadsDir } from './resetV3.js';

const RECYCLE_MS = 30 * 24 * 3600 * 1000; // 无引用宽限(覆盖撤销与离线端迟到同步)
const EXT_RE = /\.(jpe?g|png|gif|webp)$/;
const ATTACHMENT_RE = /\/uploads\/([A-Z0-9]{8})\/([a-f0-9]{32}\.(?:jpe?g|png|gif|webp))/g;

export function attachmentPath(key) {
  return path.join(uploadsDir(), key);
}

/** 登记新附件(上传时):unreferenced_since=now,插入正文并写库后才清零。 */
export function registerAttachment({ docCode, filename, size, uploaderId, now = Date.now() }) {
  const key = `${docCode}/${filename}`;
  getDb()
    .prepare(
      'INSERT INTO attachments (key, doc_code, size, uploader_id, created_at, unreferenced_since) VALUES (?,?,?,?,?,?)'
    )
    .run(key, docCode, size, uploaderId, now, now);
  return key;
}

/** 扫描正文中的附件引用(忽略可能存在的协议与主机前缀)。 */
export function scanRefs(text) {
  const refs = new Set();
  for (const m of String(text).matchAll(ATTACHMENT_RE)) {
    refs.add(`${m[1]}/${m[2]}`);
  }
  return refs;
}

/**
 * 文档写库事务的一部分:diff doc_refs 并同步相关附件的 unreferenced_since。
 * refs 集合无变化时不动任何行(L20)。
 */
export function applyRefs(docCode, text, now = Date.now()) {
  const next = scanRefs(text);
  const db = getDb();
  const prev = new Set(
    db.prepare('SELECT attachment_key FROM doc_refs WHERE doc_code = ?').all(docCode).map((r) => r.attachment_key)
  );
  const removed = [...prev].filter((k) => !next.has(k));
  const added = [...next].filter((k) => !prev.has(k));
  if (removed.length === 0 && added.length === 0) return false;

  withTx(() => {
    const del = db.prepare('DELETE FROM doc_refs WHERE doc_code = ? AND attachment_key = ?');
    const ins = db.prepare('INSERT OR IGNORE INTO doc_refs (doc_code, attachment_key) VALUES (?,?)');
    for (const k of removed) del.run(docCode, k);
    for (const k of added) ins.run(docCode, k);
    // 只重算受影响键:被任何文档引用 → NULL;无引用 → 首次记时
    const recompute = db.prepare(
      `UPDATE attachments SET unreferenced_since =
         CASE WHEN EXISTS (SELECT 1 FROM doc_refs r WHERE r.attachment_key = attachments.key)
              THEN NULL ELSE COALESCE(unreferenced_since, ?) END
        WHERE key = ?`
    );
    for (const k of [...removed, ...added]) recompute.run(now, k);
  });
  return true;
}

/** 读取校验:文档 active 且附件已登记 → 绝对路径;否则 null(404)。 */
export function resolveAttachment(docCode, filename) {
  if (!/^[A-Z0-9]{8}$/.test(docCode) || !/^[a-f0-9]{32}\.(?:jpe?g|png|gif|webp)$/.test(filename)) return null;
  const row = getDb()
    .prepare(
      `SELECT a.key FROM attachments a JOIN docs d ON d.code = a.doc_code
        WHERE a.key = ? AND d.status = 'active'`
    )
    .get(`${docCode}/${filename}`);
  if (!row) return null;
  const p = attachmentPath(row.key);
  return fs.existsSync(p) ? p : null;
}

/** 生成新附件文件名:<32 hex>.<ext>。 */
export function newAttachmentFilename(originalname) {
  const ext = path.extname(String(originalname ?? '')).toLowerCase();
  return crypto.randomBytes(16).toString('hex') + (EXT_RE.test(ext) ? ext : '.png');
}

/** 删除附件(登记行 + 文件);文件缺失不视为错误。 */
export function deleteAttachment(key) {
  getDb().prepare('DELETE FROM attachments WHERE key = ?').run(key);
  const p = attachmentPath(key);
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

/**
 * 附件清扫(调度器):无引用满 30 天 → 删;孤儿目录(purged/不存在的文档残留)→ 删目录。
 * 返回 {recycled, orphanDirs}。
 */
export function sweepAttachments(now = Date.now()) {
  const db = getDb();
  const due = db
    .prepare('SELECT key FROM attachments WHERE unreferenced_since IS NOT NULL AND unreferenced_since < ?')
    .all(now - RECYCLE_MS);
  for (const { key } of due) deleteAttachment(key);

  // 孤儿目录:uploads/ 下存在但文档已 purged/不存在(purge 第 4 步前崩溃的兜底)
  let orphanDirs = 0;
  const base = uploadsDir();
  if (fs.existsSync(base)) {
    for (const entry of fs.readdirSync(base)) {
      if (!/^[A-Z0-9]{8}$/.test(entry)) continue;
      const row = db.prepare('SELECT status FROM docs WHERE code = ?').get(entry);
      if (!row || row.status === 'purged') {
        fs.rmSync(path.join(base, entry), { recursive: true, force: true });
        orphanDirs += 1;
      }
    }
  }
  return { recycled: due.length, orphanDirs };
}

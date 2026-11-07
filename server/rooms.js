// 房间簿(v4 最小实现:mappings 表)。L1/L2 落地 docStore 后由其接管并最终化
// (文档状态门控、/rooms 附 status/isOwner 等),此处先保证 v4 分支服务可用。
import { getDb } from './db.js';

const MEMBER_CAP = 50; // 所有者行不计入、永不被挤掉(L23)

function err(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

function normalizeCode(code) {
  return String(code ?? '').trim().toUpperCase().slice(0, 16);
}

/** 我的房间:memberships ⨝ docs(isOwner 供首页区分 🗑/✕ 行操作)。 */
export function listRooms(accountId) {
  return getDb()
    .prepare(
      `SELECT m.doc_code AS code, m.role,
              CASE WHEN m.role = 'owner' THEN 1 ELSE 0 END AS isOwner,
              m.last_used AS lastUsed, d.name, d.status
         FROM memberships m JOIN docs d ON d.code = m.doc_code
        WHERE m.account_id = ?
        /* 稳定顺序:按加入先后(新加入的在前),不随「最后使用时间」变化——
           否则点开一个文档就把它挪到列表第一行,选中文档会跳动(联调反馈) */
        ORDER BY m.rowid DESC`
    )
    .all(accountId);
}

/** 进入登记(upsert;已是 owner 只刷新 last_used,role 不被覆盖)。 */
export function enterRoom(accountId, rawCode, now = Date.now()) {
  const code = normalizeCode(rawCode);
  const db = getDb();
  const doc = code
    ? db.prepare("SELECT code FROM docs WHERE code = ? AND status = 'active'").get(code)
    : null;
  if (!doc) throw err('E_DOC_MISSING', '文档不存在');

  db.prepare(
    `INSERT INTO memberships (account_id, doc_code, role, last_used) VALUES (?, ?, 'member', ?)
     ON CONFLICT(account_id, doc_code) DO UPDATE SET last_used = excluded.last_used`
  ).run(accountId, code, now);

  // member 容量:超出删最旧 member(owner 行豁免)
  const stale = db
    .prepare(
      `SELECT doc_code FROM memberships WHERE account_id = ? AND role = 'member' AND doc_code != ?
        ORDER BY last_used DESC LIMIT -1 OFFSET ?`
    )
    .all(accountId, code, MEMBER_CAP - 1);
  for (const row of stale) {
    db.prepare("DELETE FROM memberships WHERE account_id = ? AND doc_code = ? AND role = 'member'").run(
      accountId,
      row.doc_code
    );
  }
}

/** 批量退出:只删 member 行(owner 行不可经 leave 删除,所有者用删除文档)。 */
export function leaveRooms(accountId, rawCodes) {
  const codes = (Array.isArray(rawCodes) ? rawCodes : []).map(normalizeCode).filter(Boolean);
  for (const code of codes) {
    // owner 行不可退出(所有者用删除文档);例外:已入回收站的行允许移出列表 ——
    // 只删书签,文档本体仍在回收站(TrashModal 按 docs.owner 查询,不受影响)。
    getDb()
      .prepare(
        `DELETE FROM memberships
          WHERE account_id = ? AND doc_code = ?
            AND (role = 'member' OR (role = 'owner' AND doc_code IN (SELECT code FROM docs WHERE status = 'trashed')))`
      )
      .run(accountId, code);
  }
}

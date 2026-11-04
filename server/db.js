// v4 统一存储:Node 内置 node:sqlite(实验特性,零原生依赖),单文件 data/polyphony.db。
// 表结构来自 docs/identity-and-sharing.md §4.2(账号/设备)与
// docs/document-lifecycle.md §4.1(docs/memberships/attachments/doc_refs)。
// 惰性单例:首次 getDb() 才打开(index.js 必须先跑 resetV3 再调它)。
import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function dataDir() {
  return process.env.DATA_DIR || path.join(__dirname, 'data');
}

let _db = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  recovery_hash TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  deleted_at    INTEGER
);
CREATE TABLE IF NOT EXISTS devices (
  id           TEXT PRIMARY KEY,
  account_id   TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  hash         TEXT NOT NULL,
  client       TEXT NOT NULL,
  os           TEXT NOT NULL,
  label        TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER
);
CREATE INDEX IF NOT EXISTS devices_by_account ON devices(account_id);
CREATE TABLE IF NOT EXISTS docs (
  code           TEXT PRIMARY KEY,
  owner_id       TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  name           TEXT NOT NULL DEFAULT '',
  status         TEXT NOT NULL,
  trash_reason   TEXT,
  created_at     INTEGER NOT NULL,
  last_access_at INTEGER NOT NULL,
  trashed_at     INTEGER,
  purged_at      INTEGER,
  state          BLOB
);
CREATE TABLE IF NOT EXISTS memberships (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  doc_code   TEXT NOT NULL REFERENCES docs(code),
  role       TEXT NOT NULL,
  last_used  INTEGER NOT NULL,
  PRIMARY KEY (account_id, doc_code)
);
CREATE TABLE IF NOT EXISTS attachments (
  key                TEXT PRIMARY KEY,
  doc_code           TEXT NOT NULL REFERENCES docs(code),
  size               INTEGER NOT NULL,
  uploader_id        TEXT,
  created_at         INTEGER NOT NULL,
  unreferenced_since INTEGER
);
CREATE INDEX IF NOT EXISTS attachments_by_doc ON attachments(doc_code);
CREATE TABLE IF NOT EXISTS doc_refs (
  doc_code       TEXT NOT NULL,
  attachment_key TEXT NOT NULL,
  PRIMARY KEY (doc_code, attachment_key)
);
CREATE INDEX IF NOT EXISTS refs_by_attachment ON doc_refs(attachment_key);
`;

export function getDb() {
  if (_db) return _db;
  const dir = dataDir();
  fs.mkdirSync(dir, { recursive: true });
  _db = new DatabaseSync(path.join(dir, 'polyphony.db'));
  _db.exec('PRAGMA journal_mode = WAL;');
  _db.exec('PRAGMA synchronous = NORMAL;');
  _db.exec('PRAGMA foreign_keys = ON;');
  _db.exec(SCHEMA);
  return _db;
}

/** 测试隔离用:关连接并遗忘(生产代码不调用)。 */
export function _closeDbForTest() {
  if (_db) {
    _db.close();
    _db = null;
  }
}

let txDepth = 0;

/** 事务包装(SAVEPOINT 支持嵌套):fn 抛错整体回滚。 */
export function withTx(fn) {
  const db = getDb();
  const sp = `sp${txDepth}`;
  txDepth += 1;
  db.exec(`SAVEPOINT ${sp}`);
  try {
    const result = fn();
    db.exec(`RELEASE SAVEPOINT ${sp}`);
    return result;
  } catch (e) {
    db.exec(`ROLLBACK TO ${sp}`);
    db.exec(`RELEASE ${sp}`);
    throw e;
  } finally {
    txDepth -= 1;
  }
}

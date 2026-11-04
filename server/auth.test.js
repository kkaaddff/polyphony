// v4 凭据模型单测(docs/identity-and-sharing.md §7)。node --test,注入时钟与临时 DATA_DIR。
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'polyphony-auth-'));

const {
  createAccount,
  exchange,
  authenticate,
  listDevices,
  revokeDevice,
  regenerateRecovery,
  deleteAccount,
  restoreAccount,
  sweepDevices,
  sha256hex,
} = await import('./auth.js');
const { getDb, withTx } = await import('./db.js');
const { runResetV3 } = await import('./resetV3.js');
const { enterRoom, listRooms, leaveRooms } = await import('./rooms.js');

const T0 = 1_700_000_000_000;
const HOUR = 3600_000;
const DAY = 24 * HOUR;
let seq = 0;
const newName = () => `测试用户${++seq}`;
const newSecret = () => crypto.randomBytes(24).toString('hex');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0 Safari/537.36';

before(() => getDb()); // 提前建库,后续测试直接读库断言

test('create: 只返回 deviceId+恢复密钥,响应体不含 secret;拼出凭据可鉴权', () => {
  const secret = newSecret();
  const r = createAccount({ name: newName(), secret, platform: { client: 'app', os: 'android' }, ua: UA }, T0);
  assert.equal(r.deviceId.split('-').length, 5);
  assert.match(r.recoveryKey, /^poly_r_[0-9a-f]{48}$/);
  const session = authenticate(`poly_d_${r.deviceId}_${secret}`, T0 + 1000);
  assert.ok(session);
  assert.equal(session.device.label, 'App · Android');
});

test('恢复密钥不可直接作会话凭据', () => {
  const secret = newSecret();
  const r = createAccount({ name: newName(), secret, platform: { client: 'web', os: 'macos' }, ua: UA }, T0);
  assert.equal(authenticate(r.recoveryKey, T0), null);
  assert.equal(authenticate(`poly_${newSecret()}`, T0), null); // v3 旧格式直接失效(V4)
});

test('exchange: 恢复密钥兑换第二台设备;web 平台按 UA 拼浏览器名', () => {
  const secret = newSecret();
  const r = createAccount({ name: newName(), secret, platform: { client: 'web', os: 'macos' }, ua: UA }, T0);
  const secret2 = newSecret();
  const r2 = exchange({ key: r.recoveryKey, secret: secret2, platform: { client: 'web', os: 'macos' }, ua: UA }, T0 + HOUR);
  assert.equal(r2.name, r.name);
  const session = authenticate(`poly_d_${r2.deviceId}_${secret2}`, T0 + HOUR);
  assert.ok(session);
  assert.equal(session.device.label, 'Chrome · macOS');
});

test('exchange: 错误恢复密钥 401;非法 secret E_SECRET_INVALID', () => {
  const r = createAccount({ name: newName(), secret: newSecret(), platform: {}, ua: UA }, T0);
  assert.throws(
    () => exchange({ key: 'poly_r_' + '0'.repeat(48), secret: newSecret(), platform: {} }, T0),
    (e) => e.code === 'E_UNAUTHORIZED'
  );
  assert.throws(
    () => exchange({ key: r.recoveryKey, secret: 'not-hex', platform: {} }, T0),
    (e) => e.code === 'E_SECRET_INVALID'
  );
  assert.throws(
    () => createAccount({ name: newName(), secret: 'short', platform: {} }, T0),
    (e) => e.code === 'E_SECRET_INVALID'
  );
});

test('设备上限 20:E_DEVICE_LIMIT,不静默淘汰', () => {
  const secret = newSecret();
  const r = createAccount({ name: newName(), secret, platform: {}, ua: UA }, T0);
  for (let i = 0; i < 19; i++) {
    exchange({ key: r.recoveryKey, secret: newSecret(), platform: {} }, T0 + i);
  }
  assert.throws(
    () => exchange({ key: r.recoveryKey, secret: newSecret(), platform: {} }, T0 + 100),
    (e) => e.code === 'E_DEVICE_LIMIT'
  );
  assert.equal(listDevices(authenticate(`poly_d_${r.deviceId}_${secret}`, T0).account.id, r.deviceId).length, 20);
});

test('revoke: 吊销后凭据立即失效', () => {
  const secret = newSecret();
  const r = createAccount({ name: newName(), secret, platform: {}, ua: UA }, T0);
  const token = `poly_d_${r.deviceId}_${secret}`;
  const session = authenticate(token, T0);
  const rev = revokeDevice(r.deviceId);
  assert.equal(rev.accountId, session.account.id);
  assert.equal(authenticate(token, T0 + 1), null);
  assert.equal(revokeDevice(r.deviceId), null); // 二次吊销:设备已不存在
});

test('regenerate: 新密钥可兑换,旧密钥立即作废', () => {
  const secret = newSecret();
  const r = createAccount({ name: newName(), secret, platform: {}, ua: UA }, T0);
  const accountId = authenticate(`poly_d_${r.deviceId}_${secret}`, T0).account.id;
  const newKey = regenerateRecovery(accountId);
  assert.match(newKey, /^poly_r_/);
  assert.throws(
    () => exchange({ key: r.recoveryKey, secret: newSecret(), platform: {} }, T0),
    (e) => e.code === 'E_UNAUTHORIZED'
  );
  const r2 = exchange({ key: newKey, secret: newSecret(), platform: {} }, T0);
  assert.equal(r2.name, r.name);
});

test('平台枚举归一:非法 client/os 落入安全值,UA 兜底仍限枚举', () => {
  const secret = newSecret();
  const r = createAccount(
    { name: newName(), secret, platform: { client: 'evil', os: 'hack<svg>' }, ua: 'Mozilla/5.0 (Windows NT 10.0) Firefox/121.0' },
    T0
  );
  const session = authenticate(`poly_d_${r.deviceId}_${secret}`, T0);
  // client 非法 → web;os 非法 → other → UA 兜底 windows;label 不含任何客户端自由文本
  assert.equal(session.device.client, 'web');
  assert.equal(session.device.os, 'windows');
  assert.equal(session.device.label, 'Firefox · Windows');
});

test('last_seen_at 写库节流:1 小时内只落一次', () => {
  const secret = newSecret();
  const r = createAccount({ name: newName(), secret, platform: {}, ua: UA }, T0);
  const token = `poly_d_${r.deviceId}_${secret}`;
  authenticate(token, T0 + 1000); // 首次:NULL → 立即落库
  const row1 = getDb().prepare('SELECT last_seen_at FROM devices WHERE id = ?').get(r.deviceId);
  authenticate(token, T0 + 1000 + 30 * 60 * 1000); // 30 分钟后:节流,不写
  const row2 = getDb().prepare('SELECT last_seen_at FROM devices WHERE id = ?').get(r.deviceId);
  assert.equal(row1.last_seen_at, row2.last_seen_at);
  authenticate(token, T0 + 1000 + 2 * HOUR); // 2 小时后:再写
  const row3 = getDb().prepare('SELECT last_seen_at FROM devices WHERE id = ?').get(r.deviceId);
  assert.ok(row3.last_seen_at > row2.last_seen_at);
});

test('清扫:孤儿设备 24h、不活动设备 180 天', () => {
  const secret = newSecret();
  const r = createAccount({ name: newName(), secret, platform: {}, ua: UA }, T0);
  const secret2 = newSecret();
  const r2 = exchange({ key: r.recoveryKey, secret: secret2, platform: {} }, T0);
  const db = getDb();
  // r2 从未鉴权且创建超过 24h → 孤儿;r 上线过但把 last_seen 拨到 181 天前 → 不活动
  db.prepare('UPDATE devices SET created_at = ? WHERE id = ?').run(T0 - 25 * HOUR, r2.deviceId);
  db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(T0 - 181 * DAY, r.deviceId);
  const before = db.prepare('SELECT COUNT(*) n FROM devices').get().n;
  const res = sweepDevices(T0);
  assert.equal(res.orphan + res.inactive, 2);
  const after = db.prepare('SELECT COUNT(*) n FROM devices').get().n;
  assert.equal(after, before - 2);
  assert.equal(authenticate(`poly_d_${r2.deviceId}_${secret2}`, T0), null);
});

test('注销:设备全删、自有 active 文档进回收站(account_deleted)、同名仍占用、exchange 报 E_ACCOUNT_DELETED', () => {
  const secret = newSecret();
  const r = createAccount({ name: '注销者', secret, platform: {}, ua: UA }, T0);
  const token = `poly_d_${r.deviceId}_${secret}`;
  const session = authenticate(token, T0);
  // 造两篇自有文档 + 一篇他人文档
  const db = getDb();
  const other = createAccount({ name: newName(), secret: newSecret(), platform: {}, ua: UA }, T0);
  const insertDoc = (code, owner) =>
    db.prepare(
      "INSERT INTO docs (code, owner_id, name, status, created_at, last_access_at) VALUES (?,?,?,'active',?,?)"
    ).run(code, owner, code, T0, T0);
  insertDoc('DELDOC01', session.account.id);
  insertDoc('DELDOC02', session.account.id);
  insertDoc('OTHDOC01', accountIdOf(other)); // 他人文档:不受注销影响
  const trash = deleteAccount({ accountId: session.account.id, name: '注销者', now: T0 + HOUR });
  assert.deepEqual([...trash.docCodes].sort(), ['DELDOC01', 'DELDOC02']);
  assert.equal(trash.deviceIds.length, 1);
  assert.equal(authenticate(token, T0 + HOUR + 1), null);
  const rows = db.prepare("SELECT code, status, trash_reason FROM docs WHERE owner_id = ?").all(session.account.id);
  for (const row of rows) {
    assert.equal(row.status, 'trashed');
    assert.equal(row.trash_reason, 'account_deleted');
  }
  const otherRow = db.prepare("SELECT status FROM docs WHERE code = 'OTHDOC01'").get();
  assert.equal(otherRow.status, 'active'); // 他人文档不受影响
  assert.throws(
    () => createAccount({ name: '注销者', secret: newSecret(), platform: {}, ua: UA }, T0),
    (e) => e.code === 'E_NAME_TAKEN'
  );
  assert.throws(
    () => exchange({ key: r.recoveryKey, secret: newSecret(), platform: {}, ua: UA }, T0 + HOUR),
    (e) => e.code === 'E_ACCOUNT_DELETED' && e.purgeAt === T0 + HOUR + 30 * DAY
  );
  // 注销中重复注销 → E_ACCOUNT_STATE;名字不匹配 → E_NAME_MISMATCH(新账号验证)
  const fresh = createAccount({ name: newName(), secret: newSecret(), platform: {}, ua: UA }, T0);
  assert.throws(
    () => deleteAccount({ accountId: accountIdOf(fresh), name: '错误名字', now: T0 }),
    (e) => e.code === 'E_NAME_MISMATCH'
  );
});

test('撤销注销:账号与 account_deleted 文档恢复、得新设备;未注销账号 → E_ACCOUNT_ACTIVE', () => {
  const secret = newSecret();
  const r = createAccount({ name: '回头客', secret, platform: {}, ua: UA }, T0);
  const accId = accountIdOf(r);
  getDb()
    .prepare("INSERT INTO docs (code, owner_id, name, status, created_at, last_access_at) VALUES ('RESDOC01',?,?,'active',?,?)")
    .run(accId, 'RESDOC01', T0, T0);
  deleteAccount({ accountId: accId, name: '回头客', now: T0 + HOUR });
  const secret2 = newSecret();
  const back = restoreAccount({ key: r.recoveryKey, secret: secret2, platform: { client: 'app', os: 'ios' }, ua: UA }, T0 + 2 * HOUR);
  assert.equal(back.name, '回头客');
  assert.ok(authenticate(`poly_d_${back.deviceId}_${secret2}`, T0 + 2 * HOUR));
  const doc = getDb().prepare("SELECT status, trash_reason FROM docs WHERE code = 'RESDOC01'").get();
  assert.equal(doc.status, 'active');
  assert.equal(doc.trash_reason, null);
  assert.throws(
    () => restoreAccount({ key: r.recoveryKey, secret: newSecret(), platform: {} }, T0 + 3 * HOUR),
    (e) => e.code === 'E_ACCOUNT_ACTIVE'
  );
});

test('withTx:中途抛错整体回滚', () => {
  const name = newName();
  assert.throws(() =>
    withTx(() => {
      getDb()
        .prepare('INSERT INTO accounts (id, name, recovery_hash, created_at) VALUES (?,?,?,?)')
        .run(crypto.randomUUID(), name, sha256hex('x'), T0);
      throw new Error('boom');
    })
  );
  assert.equal(getDb().prepare('SELECT 1 FROM accounts WHERE name = ?').get(name), undefined);
});

test('房间簿:文档不存在拒绝登记;member 上限挤最旧,owner 行豁免', () => {
  const secret = newSecret();
  const r = createAccount({ name: newName(), secret, platform: {}, ua: UA }, T0);
  const accId = accountIdOf(r);
  const db = getDb();
  assert.throws(() => enterRoom(accId, 'NOSUCH01', T0), (e) => e.code === 'E_DOC_MISSING');

  const mkDoc = (code, owner) =>
    db.prepare(
      "INSERT INTO docs (code, owner_id, name, status, created_at, last_access_at) VALUES (?,?,?,'active',?,?)"
    ).run(code, owner, code, T0, T0);
  // 本人拥有 1 篇 + 进入 50 篇他人的
  mkDoc('OWNDOC01', accId);
  // owner 行由建文档流程写入(L2 的 POST /docs);此处按该契约手工补
  db.prepare("INSERT INTO memberships (account_id, doc_code, role, last_used) VALUES (?,?,'owner',?)").run(accId, 'OWNDOC01', T0);
  for (let i = 0; i < 50; i++) {
    mkDoc(`MBRDOC${String(i).padStart(2, '0')}`, null);
    enterRoom(accId, `MBRDOC${String(i).padStart(2, '0')}`, T0 + i);
  }
  enterRoom(accId, 'OWNDOC01', T0 + 100); // owner 行存在后进入只刷新 last_used
  // 第 51 篇 → 挤掉最旧的 member
  mkDoc('MBRDOC51', null);
  enterRoom(accId, 'MBRDOC51', T0 + 200);
  const rooms = listRooms(accId);
  assert.equal(rooms.length, 51); // 50 member + 1 owner
  assert.ok(rooms.some((x) => x.code === 'OWNDOC01' && x.role === 'owner'), 'owner 行不得被挤掉');
  assert.ok(!rooms.some((x) => x.code === 'MBRDOC00'), '最旧 member 应被挤掉');
  // leave 不能删 owner 行
  leaveRooms(accId, ['OWNDOC01']);
  assert.ok(listRooms(accId).some((x) => x.code === 'OWNDOC01'));
});

test('resetV3:归档 v3 数据、幂等、干净目录不动作', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'polyphony-reset-d-'));
  const uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'polyphony-reset-u-'));
  // 干净目录:不动作
  const none = runResetV3({ dataDir, uploadsDir });
  assert.equal(none.archived, false);
  // 放入 v3 数据
  fs.writeFileSync(path.join(dataDir, 'accounts.json'), '[]');
  fs.writeFileSync(path.join(uploadsDir, 'image-1-1.png'), 'x');
  fs.writeFileSync(path.join(uploadsDir, 'image-2-2.jpg'), 'y');
  fs.mkdirSync(path.join(uploadsDir, 'sub')); // v4 子目录形态,不动
  const done = runResetV3({ dataDir, uploadsDir });
  assert.equal(done.archived, true);
  assert.equal(done.detail.uploads, 2);
  assert.ok(!fs.existsSync(path.join(dataDir, 'accounts.json')));
  const dataArchive = fs.readdirSync(dataDir).find((d) => d.startsWith('_v3-archive-'));
  assert.ok(dataArchive && fs.existsSync(path.join(dataDir, dataArchive, 'accounts.json')));
  const upEntries = fs.readdirSync(uploadsDir);
  assert.ok(!upEntries.some((e) => e.startsWith('image-')), '平铺图片应被移走');
  assert.ok(upEntries.includes('sub'), '子目录不动');
  // 幂等:再次运行无 v3 痕迹
  const again = runResetV3({ dataDir, uploadsDir });
  assert.equal(again.archived, false);
  // 已是 v4(db 存在)时即使有散落文件也不动
  fs.writeFileSync(path.join(dataDir, 'polyphony.db'), '');
  fs.writeFileSync(path.join(uploadsDir, 'image-3-3.png'), 'z');
  const v4 = runResetV3({ dataDir, uploadsDir });
  assert.equal(v4.archived, false);
  assert.ok(fs.existsSync(path.join(uploadsDir, 'image-3-3.png')));
});

// ---- 小工具:绕过鉴权拿 accountId(测试内直接查库) ----
function accountIdOf(createResult) {
  const db = getDb();
  const row = db.prepare('SELECT id FROM accounts WHERE name = ?').get(createResult.name);
  return row.id;
}

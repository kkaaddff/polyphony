// 文档生命周期单测(docs/document-lifecycle.md §7 L1/L2)。node --test,注入时钟与临时目录。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import Y from './yjs.js';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'polyphony-doc-d-'));
process.env.UPLOADS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'polyphony-doc-u-'));

const auth = await import('./auth.js');
const store = await import('./docStore.js');
const { getDb } = await import('./db.js');

const T0 = 1_700_000_000_000;
const DAY = 24 * 3600_000;
let seq = 0;

function mkAccount() {
  const secret = crypto.randomBytes(24).toString('hex');
  const r = auth.createAccount(
    { name: `文档用户${++seq}`, secret, platform: { client: 'web', os: 'macos' }, ua: 'Chrome/120.0' },
    T0
  );
  const session = auth.authenticate(`poly_d_${r.deviceId}_${secret}`, T0 + 1);
  return { account: session.account, recoveryKey: r.recoveryKey };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('create:8 位码 + owner 成员关系同一事务;墓碑码不复用', () => {
  const { account } = mkAccount();
  const { code } = store.createDoc({ ownerId: account.id, now: T0 });
  assert.match(code, /^[A-Z0-9]{8}$/);
  const m = getDb().prepare('SELECT role FROM memberships WHERE account_id = ? AND doc_code = ?').get(account.id, code);
  assert.equal(m.role, 'owner');

  // 墓碑后,generateDocCode 不会给出该码(实测:清空 CHAR 空间不现实,验证函数级排除)
  store.trashDoc(code, 'owner', T0 + 1);
  store.purgeDoc(code, T0 + 2);
  const row = getDb().prepare('SELECT status, state, purged_at FROM docs WHERE code = ?').get(code);
  assert.equal(row.status, 'purged');
  assert.equal(row.state, null);
  for (let i = 0; i < 50; i++) {
    assert.notEqual(store.generateDocCode(), code);
  }
});

test('快照往返:bindState 读盘 → 编辑 → writeState → 卸载重载内容一致;name 随 roomName 同步', () => {
  const { account } = mkAccount();
  const { code } = store.createDoc({ ownerId: account.id, now: T0 });
  const persistence = store.makePersistence();

  const d1 = new Y.Doc();
  persistence.bindState(code, d1);
  d1.getText('document').insert(0, '第一段');
  d1.getMap('meta').set('roomName', '会议纪要');
  persistence.writeState(code, d1);
  d1.destroy();

  const d2 = new Y.Doc();
  persistence.bindState(code, d2);
  assert.equal(d2.getText('document').toString(), '第一段');
  assert.equal(d2.getMap('meta').get('roomName'), '会议纪要');
  const row = getDb().prepare('SELECT name FROM docs WHERE code = ?').get(code);
  assert.equal(row.name, '会议纪要'); // L25:文档名单源
});

test('快照重载后仍接受客户端更新:与 y-websocket 共用同一 Yjs 实例(双实例回归)', () => {
  const { account } = mkAccount();
  const { code } = store.createDoc({ ownerId: account.id, now: T0 });
  const persistence = store.makePersistence();

  // 客户端与首个服务端文档协同,写库后卸载
  const client = new Y.Doc();
  client.getText('document').insert(0, 'first');
  const s1 = new Y.Doc();
  persistence.bindState(code, s1);
  Y.applyUpdate(s1, Y.encodeStateAsUpdate(client));
  persistence.writeState(code, s1);
  s1.destroy();

  // y-websocket(CJS)真实路径:它 require('yjs') 建文档,bindState 往里灌快照
  const wsUtils = createRequire(import.meta.url)('y-websocket/bin/utils');
  wsUtils.setPersistence(persistence);
  const s2 = wsUtils.getYDoc(code); // 内部 bindState,与线上 WS 连接同路径
  try {
    assert.equal(s2.getText('document').toString(), 'first');

    // 客户端接着写(依赖快照里已有的结构体):必须整合进服务端文档,而不是积压为 pending
    const sv = Y.encodeStateVector(s2);
    client.getText('document').insert(5, ' second');
    Y.applyUpdate(s2, Y.encodeStateAsUpdate(client, sv));
    assert.equal(s2.getText('document').toString(), 'first second');
    assert.equal(s2.store.pendingStructs, null);
  } finally {
    // 断言失败也要释放:WSSharedDoc 的 awareness 定时器会让测试进程挂住
    wsUtils.docs.delete(code);
    wsUtils.setPersistence(null);
    s2.awareness.destroy();
    s2.destroy();
  }
});

test('防抖写库:更新静默 2s 后自动落库(不等 writeState)', async () => {
  const { account } = mkAccount();
  const { code } = store.createDoc({ ownerId: account.id, now: T0 });
  const persistence = store.makePersistence();
  const d = new Y.Doc();
  persistence.bindState(code, d);
  d.getText('document').insert(0, '防抖内容');
  await wait(2300); // DEBOUNCE_MS=2000
  const row = getDb().prepare('SELECT state FROM docs WHERE code = ?').get(code);
  assert.ok(row.state && row.state.length > 0, '静默 2s 后应已落库');
  const reloaded = new Y.Doc();
  Y.applyUpdate(reloaded, row.state);
  assert.equal(reloaded.getText('document').toString(), '防抖内容');
});

test('flushAllSync:待写脏文档随进程退出刷写', async () => {
  const { account } = mkAccount();
  const { code } = store.createDoc({ ownerId: account.id, now: T0 });
  const persistence = store.makePersistence();
  const d = new Y.Doc();
  persistence.bindState(code, d);
  d.getText('document').insert(0, '退出前内容');
  store.flushAllSync(); // 不等防抖
  const row = getDb().prepare('SELECT state FROM docs WHERE code = ?').get(code);
  const reloaded = new Y.Doc();
  Y.applyUpdate(reloaded, row.state);
  assert.equal(reloaded.getText('document').toString(), '退出前内容');
});

test('purge 竞态:防抖挂起时清除,快照不得被写回(L19)', async () => {
  const { account } = mkAccount();
  const { code } = store.createDoc({ ownerId: account.id, now: T0 });
  const persistence = store.makePersistence();
  const d = new Y.Doc();
  persistence.bindState(code, d);
  d.getText('document').insert(0, '待清除内容'); // 防抖计时器挂起中
  store.purgeDoc(code, T0 + 5); // 立即清除:停写 → 事务降墓碑
  await wait(2300); // 防抖本该触发的时间点
  const row = getDb().prepare('SELECT status, state FROM docs WHERE code = ?').get(code);
  assert.equal(row.status, 'purged');
  assert.equal(row.state, null, '停写后快照不得写回');
  // writeState(最后连接断开)也是空操作
  persistence.writeState(code, d);
  assert.equal(getDb().prepare('SELECT state FROM docs WHERE code = ?').get(code).state, null);
});

test('purge:成员关系/附件登记随事务删除;附件目录删除', () => {
  const { account } = mkAccount();
  const { code } = store.createDoc({ ownerId: account.id, now: T0 });
  const db = getDb();
  const member = mkAccount();
  db.prepare('INSERT INTO memberships (account_id, doc_code, role, last_used) VALUES (?,?,?,?)').run(
    member.account.id, code, 'member', T0
  );
  db.prepare('INSERT INTO attachments (key, doc_code, size, uploader_id, created_at) VALUES (?,?,?,?,?)').run(
    `${code}/abc.png`, code, 10, null, T0
  );
  db.prepare('INSERT INTO doc_refs (doc_code, attachment_key) VALUES (?,?)').run(code, `${code}/abc.png`);
  const dir = path.join(process.env.UPLOADS_DIR, code);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'abc.png'), 'x');

  store.trashDoc(code, 'owner', T0 + 1);
  store.purgeDoc(code, T0 + 2);

  assert.equal(db.prepare('SELECT COUNT(*) n FROM memberships WHERE doc_code = ?').get(code).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM attachments WHERE doc_code = ?').get(code).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM doc_refs WHERE doc_code = ?').get(code).n, 0);
  assert.ok(!fs.existsSync(dir), '附件目录应被删除');
});

test('损坏快照:另存 corrupt 后按空文档继续', () => {
  const { account } = mkAccount();
  const { code } = store.createDoc({ ownerId: account.id, now: T0 });
  getDb().prepare('UPDATE docs SET state = ? WHERE code = ?').run(Buffer.from('not-a-snapshot'), code);
  const persistence = store.makePersistence();
  const d = new Y.Doc();
  persistence.bindState(code, d); // 不抛错
  assert.equal(d.getText('document').toString(), '');
  const corruptDir = path.join(process.env.DATA_DIR, 'corrupt');
  assert.ok(fs.readdirSync(corruptDir).some((f) => f.startsWith(`${code}-`)));
});

test('WS 门控:active 放行;trashed 4010;missing/purged 4004', () => {
  const { account } = mkAccount();
  const { code } = store.createDoc({ ownerId: account.id, now: T0 });
  assert.equal(store.checkDocForConnection(code, T0 + 1).allowed, true);
  assert.equal(store.checkDocForConnection('NOSUCH01', T0).closeCode, 4004);

  store.trashDoc(code, 'owner', T0 + 2);
  assert.equal(store.checkDocForConnection(code, T0 + 3).closeCode, 4010);

  store.restoreDoc(code, T0 + 4);
  assert.equal(store.checkDocForConnection(code, T0 + 5).allowed, true);

  store.trashDoc(code, 'owner', T0 + 6);
  store.purgeDoc(code, T0 + 7);
  assert.equal(store.checkDocForConnection(code, T0 + 8).closeCode, 4004);
});

test('状态机:重复删除/恢复非回收站 → E_DOC_STATE', () => {
  const { account } = mkAccount();
  const { code } = store.createDoc({ ownerId: account.id, now: T0 });
  store.trashDoc(code, 'owner', T0 + 1);
  assert.throws(() => store.trashDoc(code, 'owner', T0 + 2), (e) => e.code === 'E_DOC_STATE');
  store.restoreDoc(code, T0 + 3);
  assert.throws(() => store.restoreDoc(code, T0 + 4), (e) => e.code === 'E_DOC_STATE');
});

test('sweepDocs:1 年不活跃→回收站;30 天→清除;注销到期→文档清除+账号删除+用户名释放', () => {
  const owner = mkAccount();
  const { code } = store.createDoc({ ownerId: owner.account.id, now: T0 });
  getDb().prepare('UPDATE docs SET last_access_at = ? WHERE code = ?').run(T0 - 366 * DAY, code);

  // 注销账号的文档(先建第二账号并注销)
  const quitter = mkAccount();
  const qDoc = store.createDoc({ ownerId: quitter.account.id, now: T0 });
  auth.deleteAccount({ accountId: quitter.account.id, name: quitter.account.name, now: T0 - 31 * DAY });
  getDb().prepare('UPDATE accounts SET deleted_at = ? WHERE id = ?').run(T0 - 31 * DAY, quitter.account.id);

  const r = store.sweepDocs(T0);
  assert.equal(r.inactive, 1);
  assert.equal(getDb().prepare('SELECT status FROM docs WHERE code = ?').get(code).status, 'trashed');
  assert.equal(getDb().prepare('SELECT trash_reason FROM docs WHERE code = ?').get(code).trash_reason, 'inactive');
  // 注销文档同批清除 + 账号行删除 + 用户名释放
  assert.equal(getDb().prepare('SELECT status FROM docs WHERE code = ?').get(qDoc.code).status, 'purged');
  assert.equal(getDb().prepare('SELECT 1 FROM accounts WHERE id = ?').get(quitter.account.id), undefined);
  const reborn = auth.createAccount(
    { name: quitter.account.name, secret: 'f'.repeat(48), platform: {} },
    T0 + 1
  );
  assert.ok(reborn.deviceId);

  // 回收站再满 30 天 → 清除
  const r2 = store.sweepDocs(T0 + 31 * DAY);
  assert.ok(r2.purged >= 1);
  assert.equal(getDb().prepare('SELECT status FROM docs WHERE code = ?').get(code).status, 'purged');
});

test('listTrash:只列本人所有的 trashed 文档', () => {
  const a = mkAccount();
  const b = mkAccount();
  const da = store.createDoc({ ownerId: a.account.id, now: T0 });
  store.trashDoc(da.code, 'owner', T0 + 1);
  const db_ = store.createDoc({ ownerId: b.account.id, now: T0 });
  store.trashDoc(db_.code, 'owner', T0 + 1);
  const list = store.listTrash(a.account.id);
  assert.equal(list.length, 1);
  assert.equal(list[0].code, da.code);
  assert.equal(list[0].trashReason, 'owner');
});

test('textPreview:取第一行有内容的纯文本,去 Markdown 标记,按码点截 40', () => {
  const p = store.textPreview;
  assert.equal(p(''), '');
  assert.equal(p('\n\n   \n'), '');
  assert.equal(p('# 周报 **草稿**\n正文'), '周报 草稿');
  assert.equal(p('\n---\n> 引用一句'), '引用一句');
  assert.equal(p('- [ ] 买牛奶\n- [x] 写周报'), '买牛奶');
  assert.equal(p('1. 第一步'), '第一步');
  assert.equal(p('![图](/uploads/AB/x.png)\n看 [链接](https://e.com) 吧'), '看 链接 吧');
  assert.equal(p('```\ncode()\n```'), 'code()');
  assert.equal(p('价格 5\\*3&#x20;元'), '价格 5*3 元');
  assert.equal(p('| --- | :-: |\n表后文字'), '表后文字');
  const long = '😀'.repeat(50);
  assert.equal(Array.from(p(long)).length, 40);
});

test('docPreview:活文档读内存;卸载后读快照(缓存随 writeState 刷新);列表/回收站带 preview', () => {
  const { account } = mkAccount();
  const { code } = store.createDoc({ ownerId: account.id, now: T0 });
  assert.equal(store.docPreview(code), ''); // 无快照

  const persistence = store.makePersistence();
  const d1 = new Y.Doc();
  persistence.bindState(code, d1);
  d1.getText('document').insert(0, '## 待办\n明天开会');
  assert.equal(store.docPreview(code), '待办'); // 活文档:未落盘也即时可见
  d1.getText('document').delete(0, 6);
  persistence.writeState(code, d1);
  d1.destroy();
  assert.equal(store.docPreview(code), '明天开会'); // 卸载后:快照落盘时刷新的缓存

  store.trashDoc(code, 'manual', T0 + 1);
  const entry = store.listTrash(account.id).find((x) => x.code === code);
  assert.equal(entry.preview, '明天开会');
});

test('liveDocName:活文档即时返回内存名(不等防抖落库);卸载后 null', () => {
  const { account } = mkAccount();
  const { code } = store.createDoc({ ownerId: account.id, now: T0 });
  assert.equal(store.liveDocName(code), null);
  const persistence = store.makePersistence();
  const d = new Y.Doc();
  persistence.bindState(code, d);
  d.getMap('meta').set('roomName', '刚改的名');
  assert.equal(store.liveDocName(code), '刚改的名');
  assert.equal(getDb().prepare('SELECT name FROM docs WHERE code = ?').get(code).name, ''); // 库里还没落
  persistence.writeState(code, d);
  d.destroy();
  assert.equal(store.liveDocName(code), null);
});

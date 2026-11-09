// 附件单测(docs/document-lifecycle.md §7 L3)。node --test,注入时钟与临时目录。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import Y from './yjs.js';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'polyphony-att-d-'));
process.env.UPLOADS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'polyphony-att-u-'));

const auth = await import('./auth.js');
const store = await import('./docStore.js');
const att = await import('./attachments.js');
const { getDb } = await import('./db.js');

const T0 = 1_700_000_000_000;
const DAY = 24 * 3600_000;
let seq = 0;

function mkAccount() {
  const secret = crypto.randomBytes(24).toString('hex');
  const r = auth.createAccount(
    { name: `附件用户${++seq}`, secret, platform: { client: 'web', os: 'macos' }, ua: 'Chrome/120.0' },
    T0
  );
  return auth.authenticate(`poly_d_${r.deviceId}_${secret}`, T0 + 1).account;
}

function mkAttachment(docCode, name = crypto.randomBytes(16).toString('hex') + '.png', now = T0) {
  const dir = path.join(process.env.UPLOADS_DIR, docCode);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), 'x'.repeat(10));
  const key = att.registerAttachment({ docCode, filename: name, size: 10, uploaderId: null, now });
  return { key, name };
}

test('resolve:active+已登记→路径;trashed/未登记/非法格式→null', () => {
  const owner = mkAccount();
  const { code } = store.createDoc({ ownerId: owner.id, now: T0 });
  const { key, name } = mkAttachment(code);
  assert.equal(att.resolveAttachment(code, name), path.join(process.env.UPLOADS_DIR, key));

  store.trashDoc(code, 'owner', T0 + 1);
  assert.equal(att.resolveAttachment(code, name), null);
  store.restoreDoc(code, T0 + 2);
  assert.equal(att.resolveAttachment(code, name), path.join(process.env.UPLOADS_DIR, key));

  assert.equal(att.resolveAttachment(code, 'deadbeef'.repeat(4) + '.png'), null); // 未登记
  assert.equal(att.resolveAttachment(code, '../' + name), null); // 穿透/非法格式
  assert.equal(att.resolveAttachment('..%2F', name), null);
});

test('applyRefs:识别带主机前缀的引用;登记→引用计时清零;移除→重新计时;全局引用保护跨文档', () => {
  const owner = mkAccount();
  const docD = store.createDoc({ ownerId: owner.id, now: T0 }).code;
  const docE = store.createDoc({ ownerId: owner.id, now: T0 }).code;
  const { key, name } = mkAttachment(docD);

  // 上传后未插入正文:unreferenced_since 保持上传时刻
  assert.equal(getDb().prepare('SELECT unreferenced_since FROM attachments WHERE key = ?').get(key).unreferenced_since, T0);

  // 插入正文(带协议与主机前缀,异地粘贴形态)
  const changed1 = att.applyRefs(docD, `![x](http://192.168.1.5:3001/uploads/${docD}/${name})`, T0 + 1000);
  assert.equal(changed1, true);
  assert.equal(getDb().prepare('SELECT unreferenced_since FROM attachments WHERE key = ?').get(key).unreferenced_since, null);

  // 复制到另一篇文档:两处引用
  att.applyRefs(docE, `![y](/uploads/${docD}/${name})`, T0 + 2000);
  // 从原文档移除,但 docE 仍引用 → 计时不得启动(全局引用保护)
  att.applyRefs(docD, '无图正文', T0 + 3000);
  assert.equal(getDb().prepare('SELECT unreferenced_since FROM attachments WHERE key = ?').get(key).unreferenced_since, null);

  // 所有引用移除 → 计时启动于此刻
  att.applyRefs(docE, '无图正文', T0 + 4000);
  assert.equal(getDb().prepare('SELECT unreferenced_since FROM attachments WHERE key = ?').get(key).unreferenced_since, T0 + 4000);

  // refs 无变化 → 返回 false 且不写行(L20)
  assert.equal(att.applyRefs(docD, '无图正文', T0 + 5000), false);
});

test('sweepAttachments:无引用满 30 天删登记与文件;孤儿目录兜底删除', () => {
  const owner = mkAccount();
  const code = store.createDoc({ ownerId: owner.id, now: T0 }).code;
  const { key } = mkAttachment(code, undefined, T0 - 31 * DAY); // 上传即失联 31 天
  assert.ok(fs.existsSync(att.attachmentPath(key)));

  const r = att.sweepAttachments(T0);
  assert.ok(r.recycled >= 1);
  assert.equal(getDb().prepare('SELECT 1 FROM attachments WHERE key = ?').get(key), undefined);
  assert.ok(!fs.existsSync(att.attachmentPath(key)));

  // 孤儿目录:purge 后目录残留(模拟 purge 第 4 步前崩溃)→ 兜底删除
  const code2 = store.createDoc({ ownerId: owner.id, now: T0 }).code;
  fs.mkdirSync(path.join(process.env.UPLOADS_DIR, code2), { recursive: true });
  store.trashDoc(code2, 'owner', T0 + 1);
  store.purgeDoc(code2, T0 + 2);
  fs.mkdirSync(path.join(process.env.UPLOADS_DIR, code2), { recursive: true }); // 人为复活残留
  const r2 = att.sweepAttachments(T0 + 3);
  assert.ok(r2.orphanDirs >= 1);
  assert.ok(!fs.existsSync(path.join(process.env.UPLOADS_DIR, code2)));
});

test('purge:名下附件无条件删除,他文档悬空引用一并清除(L9)', () => {
  const owner = mkAccount();
  const docD = store.createDoc({ ownerId: owner.id, now: T0 }).code;
  const docE = store.createDoc({ ownerId: owner.id, now: T0 }).code;
  const { key } = mkAttachment(docD);
  att.applyRefs(docD, `![x](/uploads/${key})`, T0 + 1);
  att.applyRefs(docE, `![y](/uploads/${key})`, T0 + 2);

  store.trashDoc(docD, 'owner', T0 + 3);
  store.purgeDoc(docD, T0 + 4);

  assert.equal(getDb().prepare('SELECT 1 FROM attachments WHERE key = ?').get(key), undefined);
  assert.ok(!fs.existsSync(att.attachmentPath(key)));
  assert.equal(getDb().prepare('SELECT 1 FROM doc_refs WHERE attachment_key = ?').get(key), undefined);
  assert.equal(att.resolveAttachment(docD, path.basename(key)), null);
});

test('写库联动:writeSnapshot 触发引用登记', async () => {
  const owner = mkAccount();
  const code = store.createDoc({ ownerId: owner.id, now: T0 });
  const { key, name } = mkAttachment(code.code);
  const persistence = store.makePersistence();
  const d = new Y.Doc();
  persistence.bindState(code.code, d);
  d.getText('document').insert(0, `![x](/uploads/${code.code}/${name})`);
  store.flushAllSync(T0 + 100);
  assert.equal(getDb().prepare('SELECT unreferenced_since FROM attachments WHERE key = ?').get(key).unreferenced_since, null);
  assert.ok(getDb().prepare('SELECT 1 FROM doc_refs WHERE doc_code = ? AND attachment_key = ?').get(code.code, key));
});

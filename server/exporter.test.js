// 导出单测(docs/document-lifecycle.md §7 L4)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import * as Y from 'yjs';
import { unzipSync } from 'fflate';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'polyphony-exp-d-'));
process.env.UPLOADS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'polyphony-exp-u-'));

const auth = await import('./auth.js');
const store = await import('./docStore.js');
const att = await import('./attachments.js');
const exporter = await import('./exporter.js');

const T0 = 1_700_000_000_000;
let seq = 0;

function mkAccount() {
  const secret = crypto.randomBytes(24).toString('hex');
  const r = auth.createAccount(
    { name: `导出用户${++seq}`, secret, platform: { client: 'web', os: 'macos' }, ua: 'Chrome/120.0' },
    T0
  );
  return auth.authenticate(`poly_d_${r.deviceId}_${secret}`, T0 + 1).account;
}

/** 造一篇带图文档:正文引用 refKey(带主机前缀)+ 提及 lostKey(文件不存在)。 */
function seedDoc({ withLost }) {
  const owner = mkAccount();
  const { code } = store.createDoc({ ownerId: owner.id, now: T0 });
  const mkName = () => crypto.randomBytes(16).toString('hex') + '.png';
  const refName = mkName();
  fs.mkdirSync(path.join(process.env.UPLOADS_DIR, code), { recursive: true });
  fs.writeFileSync(path.join(process.env.UPLOADS_DIR, code, refName), 'PNGDATA');
  att.registerAttachment({ docCode: code, filename: refName, size: 7, uploaderId: null, now: T0 });
  const refKey = `${code}/${refName}`;

  let lostKey = null;
  let text = "# 标题\n\n![a](http://10.0.0.2:3001/uploads/" + refKey + ")";
  if (withLost) {
    const lostName = mkName();
    lostKey = `${code}/${lostName}`;
    att.registerAttachment({ docCode: code, filename: lostName, size: 7, uploaderId: null, now: T0 });
    text += ` ![b](/uploads/${lostKey})`; // 已登记但文件缺失
  }

  const persistence = store.makePersistence();
  const d = new Y.Doc();
  persistence.bindState(code, d);
  d.getText('document').insert(0, text);
  d.getMap('meta').set('roomName', '导出测试文档');
  persistence.writeState(code, d);
  d.destroy();
  return { code, refKey, refName };
}

test('导出:地址改写为 images/;未引用/缺文件附件不进包;内容与文档名正确', () => {
  const { code, refKey, refName } = seedDoc({ withLost: true });
  const bundle = exporter.buildExportZip(code);
  assert.ok(bundle);
  assert.equal(bundle.filename, '导出测试文档.zip');

  const files = unzipSync(bundle.zip);
  const names = Object.keys(files);
  assert.ok(names.includes('导出测试文档.md'));
  assert.ok(names.includes(`images/${refName}`), `应含被引用图片: ${names.join(', ')}`);
  assert.equal(names.length, 2, '未引用与缺文件的附件不得进包');

  const md = Buffer.from(files['导出测试文档.md']).toString('utf-8');
  assert.ok(!md.includes(`/uploads/${refKey}`), '原地址不得残留');
  assert.ok(md.includes(`images/${refName}`), '应改写为 images/ 路径');
  assert.equal(Buffer.from(files[`images/${refName}`]).toString(), 'PNGDATA');
});

test('contentDisposition:ASCII 回落 + filename* 百分号编码', () => {
  const h = exporter.contentDisposition('会议纪要.zip');
  assert.match(h, /^attachment; filename="[^"]*"; filename\*=UTF-8''/);
  assert.ok(h.includes(encodeURIComponent('会议纪要.zip').replace(/['()]/g, escape)));
});

test('导出不存在/已清除文档 → null', () => {
  const owner = mkAccount();
  const { code } = store.createDoc({ ownerId: owner.id, now: T0 });
  store.trashDoc(code, 'owner', T0 + 1);
  store.purgeDoc(code, T0 + 2);
  assert.equal(exporter.buildExportZip(code), null);
  assert.equal(exporter.buildExportZip('NOSUCH01'), null);
});

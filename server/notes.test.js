// 语音便签单测(docs/voice-input.md §6)。node --test,注入时钟与临时 DATA_DIR。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'polyphony-notes-'));

const auth = await import('./auth.js');
const { getDb } = await import('./db.js');
const {
  addNote,
  listNotes,
  deleteNote,
  getRetentionDays,
  setRetentionDays,
  sweepNotes,
  DEFAULT_RETENTION_DAYS,
  MAX_NOTE_CHARS,
} = await import('./notes.js');

const T0 = 1_700_000_000_000;
const DAY = 24 * 3600_000;
let seq = 0;

function mkAccount() {
  const secret = crypto.randomBytes(24).toString('hex');
  const r = auth.createAccount(
    { name: `便签${++seq}`, secret, platform: { client: 'web', os: 'macos' }, ua: 'Mozilla/5.0 Chrome/120.0' },
    T0
  );
  return auth.authenticate(`poly_d_${r.deviceId}_${secret}`, T0).account.id;
}

test('追加:去首尾空白、新→旧排序、分页 hasMore/before', () => {
  const acc = mkAccount();
  for (let i = 1; i <= 5; i++) addNote(acc, { text: `  第${i}条  `, deviceLabel: 'App · Android' }, T0 + i * 1000);

  const page1 = listNotes(acc, { limit: 2 }, T0 + DAY);
  assert.deepEqual(page1.notes.map((n) => n.text), ['第5条', '第4条']);
  assert.equal(page1.hasMore, true);
  assert.equal(page1.notes[0].device, 'App · Android');

  const page2 = listNotes(acc, { limit: 10, before: page1.notes.at(-1).createdAt }, T0 + DAY);
  assert.deepEqual(page2.notes.map((n) => n.text), ['第3条', '第2条', '第1条']);
  assert.equal(page2.hasMore, false);
});

test('校验:空/超长/坏 id 拒绝;createdAt 不得晚于服务端时间', () => {
  const acc = mkAccount();
  for (const bad of [{ text: '   ' }, { text: 'x'.repeat(MAX_NOTE_CHARS + 1) }, { text: 1 }, { text: 'a', id: 'not-a-uuid' }]) {
    assert.throws(() => addNote(acc, bad, T0), (e) => e.code === 'E_NOTE_INVALID');
  }
  const { note } = addNote(acc, { text: '来自未来', createdAt: T0 + 99 * DAY }, T0);
  assert.equal(note.createdAt, T0);
  const offline = addNote(acc, { text: '离线时写的', createdAt: T0 - 3600_000 }, T0);
  assert.equal(offline.note.createdAt, T0 - 3600_000);
});

test('客户端 id 幂等:重试不重复;别的账号不能占用或读到', () => {
  const a = mkAccount();
  const b = mkAccount();
  const id = crypto.randomUUID();
  assert.equal(addNote(a, { id, text: '原文' }, T0).created, true);
  const again = addNote(a, { id, text: '重试时文本不同也不覆盖' }, T0 + 5);
  assert.equal(again.created, false);
  assert.equal(again.note.text, '原文');
  assert.equal(listNotes(a, {}, T0 + 10).notes.length, 1);

  assert.throws(() => addNote(b, { id, text: '抢占' }, T0), (e) => e.code === 'E_NOTE_CONFLICT');
  assert.equal(listNotes(b, {}, T0 + 10).notes.length, 0);
  assert.equal(deleteNote(b, id), false);
  assert.equal(deleteNote(a, id), true);
  assert.equal(deleteNote(a, id), false);
});

test('搜索:子串匹配,通配符按字面处理', () => {
  const acc = mkAccount();
  addNote(acc, { text: '明天下午三点开会' }, T0 + 1);
  addNote(acc, { text: '进度 100% 完成' }, T0 + 2);
  addNote(acc, { text: 'snake_case 命名' }, T0 + 3);

  assert.deepEqual(listNotes(acc, { q: '开会' }, T0 + 10).notes.map((n) => n.text), ['明天下午三点开会']);
  assert.deepEqual(listNotes(acc, { q: '100%' }, T0 + 10).notes.map((n) => n.text), ['进度 100% 完成']);
  assert.equal(listNotes(acc, { q: '%' }, T0 + 10).notes.length, 1);
  assert.equal(listNotes(acc, { q: '_' }, T0 + 10).notes.length, 1);
  assert.equal(listNotes(acc, { q: '不存在' }, T0 + 10).notes.length, 0);
});

test('保留天数:默认 30;过期条目读取即不可见;缩短立即清除;0 = 永久', () => {
  const acc = mkAccount();
  assert.equal(getRetentionDays(acc), DEFAULT_RETENTION_DAYS);
  addNote(acc, { text: '旧' }, T0);
  addNote(acc, { text: '新' }, T0 + 20 * DAY);

  assert.equal(listNotes(acc, {}, T0 + 25 * DAY).notes.length, 2);
  assert.deepEqual(listNotes(acc, {}, T0 + 31 * DAY).notes.map((n) => n.text), ['新']);

  setRetentionDays(acc, 0, T0 + 31 * DAY);
  assert.equal(listNotes(acc, {}, T0 + 31 * DAY).notes.length, 2); // 尚未清扫的旧条目在「永久」下重新可见

  setRetentionDays(acc, 7, T0 + 31 * DAY);
  const left = getDb().prepare('SELECT COUNT(*) AS n FROM notes WHERE account_id = ?').get(acc).n;
  assert.equal(left, 0); // 两条都超过 7 天
  for (const bad of [-1, 1.5, 99999, '7', null]) {
    assert.throws(() => setRetentionDays(acc, bad), (e) => e.code === 'E_NOTE_INVALID');
  }
});

test('清扫:按各账号的保留期删除(未设置用默认,永久不删)', () => {
  const dflt = mkAccount();
  const week = mkAccount();
  const forever = mkAccount();
  setRetentionDays(week, 7, T0);
  setRetentionDays(forever, 0, T0);
  for (const acc of [dflt, week, forever]) {
    addNote(acc, { text: '十天前' }, T0);
    addNote(acc, { text: '刚刚' }, T0 + 10 * DAY);
  }
  const count = (acc) => getDb().prepare('SELECT COUNT(*) AS n FROM notes WHERE account_id = ?').get(acc).n;

  sweepNotes(T0 + 10 * DAY + 1000);
  assert.deepEqual([count(dflt), count(week), count(forever)], [2, 1, 2]);

  sweepNotes(T0 + 45 * DAY);
  assert.deepEqual([count(dflt), count(week), count(forever)], [0, 0, 2]);
});

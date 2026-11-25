// 远程语音输入中继单测(docs/voice-input.md)。假 ws,不起网络;断言里不出现凭据。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  createInputRelay,
  sanitizeSenderMessage,
  sanitizeReceiverMessage,
  MAX_TEXT_CHARS,
  MAX_MESSAGE_BYTES,
  CLOSE_BAD_ROLE,
  CLOSE_REPLACED,
} from './inputRelay.js';

class FakeWs extends EventEmitter {
  readyState = 1;
  sent = [];
  closed = null;
  send(data) {
    this.sent.push(JSON.parse(data));
  }
  close(code, reason) {
    if (this.closed) return;
    this.closed = { code, reason };
    this.readyState = 3;
    this.emit('close');
  }
  /** 模拟对端发来一帧文本 */
  recv(obj) {
    this.emit('message', Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj)), false);
  }
  last(type) {
    return this.sent.filter((m) => m.type === type).at(-1);
  }
}

const session = (account, device) => ({
  account: { id: account, name: account },
  device: { id: device, label: `label-${device}` },
});

const snapshot = (seq, text, extra = {}) => ({
  type: 'text.snapshot',
  session_id: 's-1',
  seq,
  revision: seq,
  text,
  selection_start: text.length,
  selection_end: text.length,
  composing_start: null,
  composing_end: null,
  ...extra,
});

test('sanitize:白名单重建,丢未知字段;非法类型/超长/坏 offset 拒绝', () => {
  const ok = sanitizeSenderMessage({ ...snapshot(3, '你好'), evil: 'x', from: { device_id: 'spoof' } });
  assert.equal(ok.text, '你好');
  assert.equal(ok.seq, 3);
  assert.ok(!('evil' in ok) && !('from' in ok));

  assert.equal(sanitizeSenderMessage({ type: 'ack', session_id: 's', seq: 1 }), null);
  assert.equal(sanitizeSenderMessage(snapshot(1, 'x'.repeat(MAX_TEXT_CHARS + 1))), null);
  assert.equal(sanitizeSenderMessage(snapshot(-1, 'a')), null);
  assert.equal(sanitizeSenderMessage(snapshot(1, 'a', { composing_start: 'zero', composing_end: 1 })), null);
  assert.equal(sanitizeSenderMessage({ type: 'session.start', session_id: '', seq: 0 }), null);
  // finish 必须带终稿
  assert.equal(sanitizeSenderMessage({ type: 'session.finish', session_id: 's', seq: 9 }), null);
  assert.equal(
    sanitizeSenderMessage({ type: 'session.finish', session_id: 's', seq: 9, revision: 4, text: '终稿' }).text,
    '终稿'
  );

  assert.equal(sanitizeReceiverMessage({ type: 'text.snapshot', session_id: 's', seq: 1 }), null);
  assert.equal(sanitizeReceiverMessage({ type: 'session.status', session_id: 's', status: 'pwned' }), null);
  const st = sanitizeReceiverMessage({
    type: 'session.status',
    session_id: 's',
    status: 'suspended',
    reason: 'focus_lost',
    text: '不应回传',
  });
  assert.deepEqual(st, { v: 1, type: 'session.status', session_id: 's', status: 'suspended', reason: 'focus_lost' });
});

test('单接收端:快照转发并盖上来源设备;ack/status 回到发送端', () => {
  const relay = createInputRelay();
  const rx = new FakeWs();
  const tx = new FakeWs();
  relay.attach(rx, session('acc', 'desk'), 'receiver');
  relay.attach(tx, session('acc', 'phone'), 'sender');

  assert.deepEqual(tx.last('peers'), {
    v: 1,
    type: 'peers',
    receivers: [{ device_id: 'desk', label: 'label-desk' }],
    target: 'desk',
  });

  tx.recv({ type: 'session.start', session_id: 's-1', seq: 0 });
  tx.recv(snapshot(1, '帮我创建任务'));
  assert.equal(rx.sent.length, 2);
  assert.equal(rx.sent[1].text, '帮我创建任务');
  assert.deepEqual(rx.sent[1].from, { device_id: 'phone', label: 'label-phone' });

  rx.recv({ type: 'ack', session_id: 's-1', seq: 1, injected: true });
  assert.deepEqual(tx.last('ack'), { v: 1, type: 'ack', session_id: 's-1', seq: 1, injected: true });
  rx.recv({ type: 'session.status', session_id: 's-1', status: 'committed' });
  assert.equal(tx.last('session.status').status, 'committed');
});

test('账号隔离:别的账号的接收端收不到,也不出现在 peers 里', () => {
  const relay = createInputRelay();
  const otherRx = new FakeWs();
  const tx = new FakeWs();
  relay.attach(otherRx, session('acc-b', 'desk-b'), 'receiver');
  relay.attach(tx, session('acc-a', 'phone-a'), 'sender');

  assert.deepEqual(tx.last('peers').receivers, []);
  tx.recv(snapshot(1, '机密'));
  assert.equal(otherRx.sent.length, 0);
  assert.equal(tx.last('session.status').reason, 'no_receiver');
});

test('多接收端:未选目标时拒绝;选定后只发给目标;目标下线后回落', () => {
  const relay = createInputRelay();
  const rx1 = new FakeWs();
  const rx2 = new FakeWs();
  const tx = new FakeWs();
  relay.attach(rx1, session('acc', 'd1'), 'receiver');
  relay.attach(rx2, session('acc', 'd2'), 'receiver');
  relay.attach(tx, session('acc', 'phone'), 'sender');
  assert.equal(tx.last('peers').target, null);

  tx.recv(snapshot(1, 'a'));
  assert.equal(rx1.sent.length + rx2.sent.length, 0);
  assert.equal(tx.last('session.status').reason, 'no_receiver');

  tx.recv({ type: 'target', device_id: 'd2' });
  assert.equal(tx.last('peers').target, 'd2');
  tx.recv(snapshot(2, 'ab'));
  assert.equal(rx1.sent.length, 0);
  assert.equal(rx2.sent.length, 1);

  // 非目标接收端的回执不串到这个发送端
  const before = tx.sent.length;
  rx1.recv({ type: 'ack', session_id: 's-1', seq: 2 });
  assert.equal(tx.sent.length, before);

  rx2.close(1000);
  assert.equal(tx.last('peers').target, 'd1'); // 只剩一台 → 自动回落
});

test('同设备重复接收连接:旧连接被 4009 顶掉,新连接接管', () => {
  const relay = createInputRelay();
  const old = new FakeWs();
  const fresh = new FakeWs();
  const tx = new FakeWs();
  relay.attach(old, session('acc', 'desk'), 'receiver');
  relay.attach(fresh, session('acc', 'desk'), 'receiver');
  assert.equal(old.closed.code, CLOSE_REPLACED);

  relay.attach(tx, session('acc', 'phone'), 'sender');
  assert.equal(tx.last('peers').receivers.length, 1);
  tx.recv(snapshot(1, 'x'));
  assert.equal(fresh.sent.length, 1);
  assert.equal(old.sent.length, 0);
});

test('防护:坏 role 关闭;超大帧 1009;二进制与坏 JSON 静默丢弃', () => {
  const relay = createInputRelay();
  const bad = new FakeWs();
  relay.attach(bad, session('acc', 'x'), 'admin');
  assert.equal(bad.closed.code, CLOSE_BAD_ROLE);

  const rx = new FakeWs();
  const tx = new FakeWs();
  relay.attach(rx, session('acc', 'desk'), 'receiver');
  relay.attach(tx, session('acc', 'phone'), 'sender');
  tx.recv('{not json');
  tx.emit('message', Buffer.from([1, 2, 3]), true);
  assert.equal(rx.sent.length, 0);

  tx.recv('x'.repeat(MAX_MESSAGE_BYTES + 1));
  assert.equal(tx.closed.code, 1009);
});

test('快照限速:突发超出令牌桶的帧被丢,控制消息与后续补充的令牌不受影响', () => {
  let t = 1_000_000;
  const relay = createInputRelay({ now: () => t });
  const rx = new FakeWs();
  const tx = new FakeWs();
  relay.attach(rx, session('acc', 'desk'), 'receiver');
  relay.attach(tx, session('acc', 'phone'), 'sender');

  for (let i = 1; i <= 500; i++) tx.recv(snapshot(i, 'a'));
  const passed = rx.sent.length;
  assert.ok(passed >= 100 && passed < 500, `突发应被截断,实际放行 ${passed}`);

  tx.recv({ type: 'session.finish', session_id: 's-1', seq: 501, revision: 501, text: '终稿' });
  assert.equal(rx.sent.at(-1).type, 'session.finish');

  t += 1000;
  tx.recv(snapshot(502, 'b'));
  assert.equal(rx.sent.at(-1).text, 'b');
});

test('全部断开后账号分组被回收', () => {
  const relay = createInputRelay();
  const rx = new FakeWs();
  const tx = new FakeWs();
  relay.attach(rx, session('acc', 'desk'), 'receiver');
  relay.attach(tx, session('acc', 'phone'), 'sender');
  assert.equal(relay._accountCount(), 1);
  rx.close(1000);
  tx.close(1000);
  assert.equal(relay._accountCount(), 0);
});

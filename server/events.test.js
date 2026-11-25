// 账号级事件推送单测。假 ws,不起网络。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createEventHub } from './events.js';

class FakeWs extends EventEmitter {
  readyState = 1;
  sent = [];
  send(d) {
    this.sent.push(JSON.parse(d));
  }
  close() {
    this.readyState = 3;
    this.emit('close');
  }
}

test('只推给同账号的在线连接;断开后不再推并回收分组', () => {
  const hub = createEventHub();
  const a1 = new FakeWs();
  const a2 = new FakeWs();
  const b = new FakeWs();
  hub.attach(a1, 'acc-a');
  hub.attach(a2, 'acc-a');
  hub.attach(b, 'acc-b');

  hub.publish('acc-a', { type: 'notes.changed' });
  assert.deepEqual(a1.sent, [{ v: 1, type: 'notes.changed' }]);
  assert.equal(a2.sent.length, 1);
  assert.equal(b.sent.length, 0);

  a1.close();
  hub.publish('acc-a', { type: 'notes.changed' });
  assert.equal(a1.sent.length, 1);
  assert.equal(a2.sent.length, 2);

  a2.close();
  b.close();
  assert.equal(hub._accountCount(), 0);
  hub.publish('acc-a', { type: 'notes.changed' }); // 无人在线:不抛错
});

// 远程语音输入中继(docs/voice-input.md):同账号设备之间转发「输入会话」消息。
//   sender(手机原生语音输入页) → receiver(桌面壳,再经 Unix Socket 交给输入法插件)
// 纯内存、无状态转发:不落库、不写日志(消息体是用户正在输入的原文)。
// 转发前按白名单重建消息 —— 未知字段、超长文本、非法类型一律不出站。
// 与文档协同(y-websocket)完全独立,只共用 WS 入口的设备凭据鉴权。

/** 保留路径:文档码是大写字母数字,下划线前缀不会与之冲突。 */
export const INPUT_PATH = '/_input';

export const MAX_MESSAGE_BYTES = 16 * 1024;
export const MAX_TEXT_CHARS = 4000;
const MAX_ID_LEN = 64;
// 快照限速(令牌桶):语音输入每秒几条到几十条;超出直接丢 —— 全量快照天然容忍丢中间帧
const SNAPSHOT_BURST = 120;
const SNAPSHOT_PER_SEC = 60;

export const CLOSE_BAD_ROLE = 4002;
export const CLOSE_REPLACED = 4009;

const SENDER_TYPES = new Set(['session.start', 'text.snapshot', 'session.finish', 'session.cancel']);
const RECEIVER_TYPES = new Set(['ack', 'session.status']);
const STATUSES = new Set([
  'committed',
  'cancelled',
  'suspended',
  'resumed',
  'rejected',
  'unknown_session',
  'not_injected',
]);

// 诊断日志(POLYPHONY_VOICE_TRACE=1 开启,默认关):只记元数据 —— 类型 / 会话前 8 位 / seq / revision /
// 文本的 UTF-8 字节数 + FNV-1a 32 摘要(与手机、桌面 Rust、Fcitx5 插件同一算法,用来定位哪一跳截断)。
// 绝不记文本本身。
const TRACE = process.env.POLYPHONY_VOICE_TRACE === '1';
export function fnv(text) {
  let h = 0x811c9dc5;
  for (const b of Buffer.from(text, 'utf8')) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
function describe(m) {
  if (!m || typeof m !== 'object') return 'invalid';
  let s = `${m.type}`;
  if (typeof m.session_id === 'string') s += ` sid=${m.session_id.slice(0, 8)}`;
  if (m.seq !== undefined) s += ` seq=${m.seq}`;
  if (m.revision !== undefined) s += ` rev=${m.revision}`;
  if (m.status) s += ` status=${m.status}`;
  if (m.reason) s += ` reason=${m.reason}`;
  if (typeof m.text === 'string') s += ` bytes=${Buffer.byteLength(m.text)} chars=${m.text.length} h=${fnv(m.text)}`;
  return s;
}
function trace(line) {
  if (TRACE) console.log(`[polyvoice ${new Date().toISOString()}] ${line}`);
}

const isSeq = (n) => Number.isSafeInteger(n) && n >= 0;
const isId = (s) => typeof s === 'string' && s.length > 0 && s.length <= MAX_ID_LEN;
const isOffset = (n) => Number.isSafeInteger(n) && n >= 0 && n <= MAX_TEXT_CHARS;
const optOffset = (n) => (n === null || n === undefined ? null : isOffset(n) ? n : undefined);

/** sender → receiver 消息:校验并按白名单重建;非法返回 null。 */
export function sanitizeSenderMessage(msg) {
  if (!msg || typeof msg !== 'object' || !SENDER_TYPES.has(msg.type)) return null;
  if (!isId(msg.session_id) || !isSeq(msg.seq)) return null;
  const out = { v: 1, type: msg.type, session_id: msg.session_id, seq: msg.seq };
  if (msg.type === 'text.snapshot' || msg.type === 'session.finish') {
    // finish 自带终稿:末帧快照被限速/断线吞掉时,提交的仍是手机上的最终文本
    if (typeof msg.text !== 'string' || msg.text.length > MAX_TEXT_CHARS) return null;
    if (!isSeq(msg.revision)) return null;
    out.revision = msg.revision;
    out.text = msg.text;
  }
  if (msg.type === 'text.snapshot') {
    // offset 一律 UTF-16 code unit(Android Selection API 原样透传)
    const cs = optOffset(msg.composing_start);
    const ce = optOffset(msg.composing_end);
    if (cs === undefined || ce === undefined) return null;
    out.selection_start = isOffset(msg.selection_start) ? msg.selection_start : msg.text.length;
    out.selection_end = isOffset(msg.selection_end) ? msg.selection_end : out.selection_start;
    out.composing_start = cs === null || ce === null ? null : cs;
    out.composing_end = cs === null || ce === null ? null : ce;
    if (isSeq(msg.timestamp_ms)) out.timestamp_ms = msg.timestamp_ms;
  }
  return out;
}

/** receiver → sender 消息:校验并按白名单重建;非法返回 null。 */
export function sanitizeReceiverMessage(msg) {
  if (!msg || typeof msg !== 'object' || !RECEIVER_TYPES.has(msg.type)) return null;
  if (!isId(msg.session_id)) return null;
  if (msg.type === 'ack') {
    if (!isSeq(msg.seq)) return null;
    return { v: 1, type: 'ack', session_id: msg.session_id, seq: msg.seq, injected: msg.injected === true };
  }
  if (!STATUSES.has(msg.status)) return null;
  const out = { v: 1, type: 'session.status', session_id: msg.session_id, status: msg.status };
  if (typeof msg.reason === 'string' && /^[a-z_]{1,32}$/.test(msg.reason)) out.reason = msg.reason;
  return out;
}

function sendJson(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

export function createInputRelay({ now = () => Date.now() } = {}) {
  /** accountId → { receivers: Map<deviceId, {ws,label}>, senders: Set<senderState> } */
  const accounts = new Map();

  function group(accountId) {
    let g = accounts.get(accountId);
    if (!g) accounts.set(accountId, (g = { receivers: new Map(), senders: new Set() }));
    return g;
  }

  function dropIfEmpty(accountId) {
    const g = accounts.get(accountId);
    if (g && g.receivers.size === 0 && g.senders.size === 0) accounts.delete(accountId);
  }

  /** 发送端的目标:显式选择且在线 → 它;否则恰好一台接收端在线 → 它;否则无。 */
  function resolveTarget(g, sender) {
    if (sender.target && g.receivers.has(sender.target)) return sender.target;
    if (g.receivers.size === 1) return g.receivers.keys().next().value;
    return null;
  }

  function sendPeers(g, sender) {
    sendJson(sender.ws, {
      v: 1,
      type: 'peers',
      receivers: Array.from(g.receivers, ([device_id, r]) => ({ device_id, label: r.label })),
      target: resolveTarget(g, sender),
    });
  }

  function broadcastPeers(g) {
    for (const s of g.senders) sendPeers(g, s);
  }

  function parse(ws, raw, isBinary) {
    if (isBinary) return null;
    const size = typeof raw === 'string' ? Buffer.byteLength(raw) : raw.length;
    if (size > MAX_MESSAGE_BYTES) {
      ws.close(1009, 'message too large');
      return null;
    }
    try {
      return JSON.parse(raw.toString());
    } catch {
      return null;
    }
  }

  function attachReceiver(ws, session) {
    const g = group(session.account.id);
    const deviceId = session.device.id;
    const prev = g.receivers.get(deviceId);
    // 同一设备只保留最新一条接收连接(桌面壳重连/多窗口)
    // 先登记新连接再关旧的:旧连接的 close 回调据此判断「我已被接管」,不会误删/误回收分组
    g.receivers.set(deviceId, { ws, label: session.device.label });
    if (prev && prev.ws !== ws) prev.ws.close(CLOSE_REPLACED, 'replaced by newer receiver');
    broadcastPeers(g);

    ws.on('message', (raw, isBinary) => {
      const out = sanitizeReceiverMessage(parse(ws, raw, isBinary));
      if (!out) {
        trace(`receiver ${deviceId.slice(0, 8)} -> dropped invalid`);
        return;
      }
      trace(`receiver ${deviceId.slice(0, 8)} -> ${describe(out)}`);
      for (const s of g.senders) {
        if (resolveTarget(g, s) === deviceId) sendJson(s.ws, out);
      }
    });
    ws.on('close', () => {
      if (g.receivers.get(deviceId)?.ws === ws) {
        g.receivers.delete(deviceId);
        broadcastPeers(g);
      }
      dropIfEmpty(session.account.id);
    });
  }

  function attachSender(ws, session) {
    const g = group(session.account.id);
    const sender = { ws, target: null, tokens: SNAPSHOT_BURST, refilledAt: now() };
    g.senders.add(sender);
    sendPeers(g, sender);

    ws.on('message', (raw, isBinary) => {
      const msg = parse(ws, raw, isBinary);
      if (!msg || typeof msg !== 'object') return;

      if (msg.type === 'target') {
        sender.target = isId(msg.device_id) ? msg.device_id : null;
        sendPeers(g, sender);
        return;
      }

      const out = sanitizeSenderMessage(msg);
      if (!out) {
        trace(`sender ${session.device.id.slice(0, 8)} dropped invalid ${describe(msg)}`);
        return;
      }

      if (out.type === 'text.snapshot') {
        const t = now();
        sender.tokens = Math.min(
          SNAPSHOT_BURST,
          sender.tokens + ((t - sender.refilledAt) / 1000) * SNAPSHOT_PER_SEC
        );
        sender.refilledAt = t;
        if (sender.tokens < 1) {
          trace(`sender ${session.device.id.slice(0, 8)} RATE-LIMITED ${describe(out)}`);
          return;
        }
        sender.tokens -= 1;
      }

      const targetId = resolveTarget(g, sender);
      const receiver = targetId ? g.receivers.get(targetId) : null;
      if (!receiver) {
        trace(`sender ${session.device.id.slice(0, 8)} no receiver for ${describe(out)}`);
        sendJson(ws, {
          v: 1,
          type: 'session.status',
          session_id: out.session_id,
          status: 'rejected',
          reason: 'no_receiver',
        });
        return;
      }
      out.from = { device_id: session.device.id, label: session.device.label };
      trace(`sender ${session.device.id.slice(0, 8)} -> ${targetId.slice(0, 8)} ${describe(out)}`);
      sendJson(receiver.ws, out);
    });
    ws.on('close', () => {
      g.senders.delete(sender);
      dropIfEmpty(session.account.id);
    });
  }

  return {
    /** 已鉴权的输入通道连接入口;role 非法即关。 */
    attach(ws, session, role) {
      if (role === 'receiver') attachReceiver(ws, session);
      else if (role === 'sender') attachSender(ws, session);
      else ws.close(CLOSE_BAD_ROLE, 'role must be sender or receiver');
    },
    /** 测试/健康检查用:当前账号数。 */
    _accountCount: () => accounts.size,
  };
}

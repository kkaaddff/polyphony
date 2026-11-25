// 远程语音输入发送端(网页实现,docs/voice-input.md):手机上的输入框 → 电脑当前光标处。
// 与 Android 原生页(plugins/voice-input 的 VoiceInputActivity + SyncClient)同一套协议与会话语义:
//   WS /_input?role=sender,凭据走子协议;输入框每次变化发「全量快照」(text.snapshot),
//   点「发送」发 session.finish(自带终稿),清空则 session.cancel。
// iOS App 没有原生语音页,便签页的输入框直接接这个发送端:用输入法的语音键说话,文字实时出现在电脑上。
// 不缓存、不重放中间帧:断线重连后只补发最新完整快照。这里绝不打日志(消息体是用户正在输入的原文)。
import { getToken } from "./auth";
import { getServerBase } from "./serverConfig";

export type SenderConn = "connecting" | "connected" | "offline" | "unauthorized";
export interface SenderPeer {
  deviceId: string;
  label: string;
}

/** 会话提示:对应 i18n 的 voiceSend.<key>(与原生页 Strings.kt 同义)。 */
export type SenderHint =
  | "live"
  | "previewOnly"
  | "committed"
  | "notInjected"
  | "cancelled"
  | "resumed"
  | "suspendedFocus"
  | "suspendedKeyboard"
  | "suspended"
  | "noReceiver"
  | "rejectedFocus"
  | "savedOnly";

export interface SenderState {
  conn: SenderConn;
  receivers: SenderPeer[];
  /** 服务端解析出的目标电脑(显式选择且在线 / 恰好一台在线),没有则 null */
  target: string | null;
  hint: SenderHint | null;
  /** 电脑端会话已失效(unknown_session):点状态栏继续同步 */
  needsResume: boolean;
}

export interface VoiceSender {
  start(): void;
  stop(): void;
  /** 输入框内容 / 选区变化(内部节流,保证尾帧) */
  update(text: string, selectionStart: number, selectionEnd: number): void;
  /** 「发送」:把终稿提交到电脑。返回是否已交给一台在线的电脑。 */
  finish(text: string): boolean;
  /** 清空 / 离开:取消进行中的会话 */
  cancel(): void;
  /** 便签 → 电脑:一次性会话(start + finish),不经过输入框 */
  resend(text: string): boolean;
  setTarget(deviceId: string): void;
  /** unknown_session 之后:重新声明会话并补发最新快照 */
  resume(): void;
  getState(): SenderState;
}

const MAX_TEXT_CHARS = 4000; // 与服务端 inputRelay.MAX_TEXT_CHARS 一致
/** 快照最小间隔:20 帧/秒,远低于服务端限速(60/s) */
const MIN_FLUSH_INTERVAL_MS = 50;
const MAX_BUFFERED_BYTES = 64 * 1024;
const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 15000;
const CLOSE_UNAUTHORIZED = 4001;
const TARGET_KEY = "polyphony:voiceTarget";

interface Snapshot {
  text: string;
  start: number;
  end: number;
}

function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
}

export function createVoiceSender(onChange: (state: SenderState) => void): VoiceSender {
  let socket: WebSocket | null = null;
  let generation = 0;
  let wanted = false;
  let backoff = INITIAL_BACKOFF_MS;
  let reconnectTimer = 0;

  let state: SenderState = { conn: "offline", receivers: [], target: null, hint: null, needsResume: false };
  const set = (patch: Partial<SenderState>) => {
    state = { ...state, ...patch };
    onChange(state);
  };

  let sessionId: string | null = null;
  let seq = 0;
  let revision = 0;
  let current: Snapshot = { text: "", start: 0, end: 0 };
  let lastSent: Snapshot | null = null;
  let lastFlushAt = 0;
  let flushTimer = 0;

  const send = (obj: Record<string, unknown>): boolean => {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(obj));
    return true;
  };
  const base = (type: string) => ({ v: 1, type, session_id: sessionId, seq: seq++ });
  const snapshotMessage = (s: Snapshot) => ({
    ...base("text.snapshot"),
    revision,
    text: s.text,
    selection_start: s.start,
    selection_end: s.end,
    // 网页拿不到输入法的组合区间:整段按已上屏文本处理
    composing_start: null,
    composing_end: null,
    timestamp_ms: Date.now(),
  });
  const hasTarget = () => state.conn === "connected" && state.target !== null;

  const flush = () => {
    flushTimer = 0;
    const snap = current;
    if (lastSent && lastSent.text === snap.text && lastSent.start === snap.start && lastSent.end === snap.end) return;
    if (snap.text.length > MAX_TEXT_CHARS) return;
    if (sessionId === null) {
      if (snap.text === "") return;
      sessionId = newId();
      seq = 0;
      revision = 0;
      set({ needsResume: false, hint: null });
      send(base("session.start"));
    }
    // 弱网背压:发送队列积压时跳过这一帧,稍后只补最新状态
    if (socket && socket.bufferedAmount > MAX_BUFFERED_BYTES) {
      flushTimer = window.setTimeout(flush, MIN_FLUSH_INTERVAL_MS);
      return;
    }
    revision++;
    lastFlushAt = performance.now();
    lastSent = snap;
    send(snapshotMessage(snap));
  };

  const schedule = () => {
    const wait = Math.max(0, lastFlushAt + MIN_FLUSH_INTERVAL_MS - performance.now());
    window.clearTimeout(flushTimer);
    flushTimer = window.setTimeout(flush, wait);
  };

  /** 重连 / 目标电脑刚上线 / 会话失效后:重新声明会话并补发最新完整快照 */
  const resync = () => {
    if (sessionId === null) return;
    send(base("session.start"));
    revision++;
    lastSent = current;
    send(snapshotMessage(current));
  };

  const onMessage = (raw: unknown) => {
    if (typeof raw !== "string") return;
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    if (m.type === "peers") {
      const list = Array.isArray(m.receivers) ? (m.receivers as Array<Record<string, unknown>>) : [];
      const receivers = list
        .filter((r) => typeof r.device_id === "string")
        .map((r) => ({ deviceId: r.device_id as string, label: typeof r.label === "string" ? r.label : "" }));
      const hadTarget = state.target !== null;
      const target = typeof m.target === "string" ? m.target : null;
      set({ receivers, target });
      if (!hadTarget && target !== null) resync();
      return;
    }
    const current_ = m.session_id === sessionId;
    if (m.type === "ack") {
      if (!current_ || state.target === null) return;
      set({ hint: m.injected === true ? "live" : "previewOnly" });
      return;
    }
    if (m.type !== "session.status") return;
    const reason = typeof m.reason === "string" ? m.reason : "";
    switch (m.status) {
      case "committed":
        set({ hint: "committed" });
        break;
      case "not_injected":
        set({ hint: "notInjected" });
        break;
      case "cancelled":
        set({ hint: "cancelled" });
        break;
      case "resumed":
        set({ hint: "resumed" });
        break;
      case "suspended":
        set({ hint: reason === "focus_lost" ? "suspendedFocus" : reason === "user_interference" ? "suspendedKeyboard" : "suspended" });
        break;
      case "unknown_session":
        if (current_) set({ needsResume: true });
        break;
      case "rejected":
        if (reason === "no_receiver") set({ hint: "noReceiver" });
        else if (reason === "focus_lost") set({ hint: "rejectedFocus" });
        break;
      default:
    }
  };

  const open = () => {
    if (!wanted) return;
    const token = getToken();
    if (!token) {
      set({ conn: "unauthorized", receivers: [], target: null });
      return;
    }
    const gen = ++generation;
    set({ conn: "connecting" });
    let ws: WebSocket;
    try {
      ws = new WebSocket(`${getServerBase().replace(/^http/i, "ws")}/_input?role=sender`, ["polyphony.v1", `auth.${token}`]);
    } catch {
      scheduleReconnect();
      return;
    }
    socket = ws;
    ws.onopen = () => {
      if (gen !== generation) return;
      backoff = INITIAL_BACKOFF_MS;
      set({ conn: "connected" });
      const saved = localStorage.getItem(TARGET_KEY);
      if (saved) send({ type: "target", device_id: saved });
      // 进行中的会话不在这里补发:随后到达的 peers 给出目标电脑时由 onMessage 补发
    };
    ws.onmessage = (e) => {
      if (gen === generation) onMessage(e.data);
    };
    ws.onclose = (e) => {
      if (gen !== generation) return;
      socket = null;
      if (e.code === CLOSE_UNAUTHORIZED) {
        set({ conn: "unauthorized", receivers: [], target: null });
        return;
      }
      set({ conn: "offline", receivers: [], target: null });
      scheduleReconnect();
    };
  };

  const scheduleReconnect = () => {
    if (!wanted) return;
    window.clearTimeout(reconnectTimer);
    reconnectTimer = window.setTimeout(open, backoff);
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
  };

  // 回到前台(iOS 切后台会断 WS):立即重连,不等退避
  const onVisible = () => {
    if (wanted && document.visibilityState === "visible" && !socket) {
      window.clearTimeout(reconnectTimer);
      backoff = INITIAL_BACKOFF_MS;
      open();
    }
  };

  const endSession = () => {
    sessionId = null;
    lastSent = null;
    current = { text: "", start: 0, end: 0 };
    window.clearTimeout(flushTimer);
    flushTimer = 0;
  };

  return {
    start() {
      if (wanted) return;
      wanted = true;
      backoff = INITIAL_BACKOFF_MS;
      document.addEventListener("visibilitychange", onVisible);
      open();
    },
    stop() {
      if (sessionId !== null) send(base("session.cancel"));
      endSession();
      wanted = false;
      generation++;
      window.clearTimeout(reconnectTimer);
      document.removeEventListener("visibilitychange", onVisible);
      socket?.close();
      socket = null;
    },
    update(text, selectionStart, selectionEnd) {
      current = { text, start: selectionStart, end: selectionEnd };
      // 清空了输入框:会话不该留着半句预览
      if (text === "" && sessionId !== null) {
        send(base("session.cancel"));
        endSession();
        set({ needsResume: false });
        return;
      }
      schedule();
    },
    finish(text) {
      window.clearTimeout(flushTimer);
      flushTimer = 0;
      let delivered = false;
      if (text.trim() !== "" && text.length <= MAX_TEXT_CHARS && hasTarget()) {
        if (sessionId === null) {
          sessionId = newId();
          seq = 0;
          revision = 0;
          send(base("session.start"));
        }
        revision++;
        // finish 自带终稿:即使末帧快照丢了,提交的也是手机上的最终文本
        delivered = send({ ...base("session.finish"), revision, text });
      }
      endSession();
      // 离线时不排队补发:过后再把旧文本注入电脑当时的焦点窗口是危险的,由用户在便签上手动「发送到电脑」
      set({ needsResume: false, hint: delivered ? null : "savedOnly" });
      return delivered;
    },
    cancel() {
      if (sessionId !== null) send(base("session.cancel"));
      endSession();
      set({ needsResume: false });
    },
    resend(text) {
      if (!hasTarget() || text.length > MAX_TEXT_CHARS) return false;
      const id = newId();
      send({ v: 1, type: "session.start", session_id: id, seq: 0 });
      return send({ v: 1, type: "session.finish", session_id: id, seq: 1, revision: 1, text });
    },
    setTarget(deviceId) {
      localStorage.setItem(TARGET_KEY, deviceId);
      send({ type: "target", device_id: deviceId });
    },
    resume() {
      set({ needsResume: false });
      resync();
    },
    getState: () => state,
  };
}

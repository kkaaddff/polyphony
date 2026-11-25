// 远程语音输入 · 桌面接收端(docs/voice-input.md)。
// 本机开关(localStorage,默认关)打开后:连服务端输入通道 /_input?role=receiver,
// 把手机发来的会话消息交给 Rust(校验 → Unix Socket → 输入法插件),回执原样发回。
// 开关只能在本机打开 —— 服务端和其他设备都无法远程开启「向这台电脑注入文字」。
import { useSyncExternalStore } from "react";
import { getToken } from "@/lib/auth";
import { getServerBase } from "@/lib/serverConfig";
import { isDesktopTauri } from "@/platform";
import {
  bridgeMessage,
  bridgeRestartIme,
  bridgeSetEnabled,
  bridgeTrace,
  onBridgeState,
  onBridgeUpstream,
  type BridgeState,
} from "@/platform/voiceInput";

const ENABLED_KEY = "polyphony.voiceReceive";
const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 15000;
/** 凭据失效 / 被同设备的另一条连接顶掉:没必要快速重试 */
const RETRY_SLOW_MS = 30000;

export type VoiceReceiverState = {
  enabled: boolean;
  /** 与服务端输入通道的连接 */
  connected: boolean;
  /** 开启失败的原因(Socket 被占用等) */
  error: string | null;
  /** 最近一次发来内容的手机 */
  fromLabel: string | null;
  bridge: BridgeState | null;
};

let state: VoiceReceiverState = {
  enabled: false,
  connected: false,
  error: null,
  fromLabel: null,
  bridge: null,
};
const listeners = new Set<() => void>();

function setState(patch: Partial<VoiceReceiverState>): void {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

let ws: WebSocket | null = null;
let retryTimer: number | undefined;
let retryMs = RETRY_MIN_MS;
/** 入站消息串行交给 Rust(保持顺序;乱序帧本身也会被 seq 校验丢弃) */
let queue: Promise<void> = Promise.resolve();

function scheduleReconnect(delay: number): void {
  window.clearTimeout(retryTimer);
  if (!state.enabled) return;
  retryTimer = window.setTimeout(connect, delay);
}

function connect(): void {
  if (!state.enabled || ws) return;
  const token = getToken();
  if (!token) {
    scheduleReconnect(RETRY_SLOW_MS / 6); // 未登录:稍后再看
    return;
  }
  const url = `${getServerBase().replace(/^http/i, "ws")}/_input?role=receiver`;
  let socket: WebSocket;
  try {
    // 凭据走子协议头,与文档协同一致,不进 URL
    socket = new WebSocket(url, ["polyphony.v1", `auth.${token}`]);
  } catch {
    scheduleReconnect(RETRY_MAX_MS);
    return;
  }
  ws = socket;

  socket.onopen = () => {
    bridgeTrace("ws open");
    retryMs = RETRY_MIN_MS;
    setState({ connected: true });
  };
  socket.onmessage = (ev) => {
    if (typeof ev.data !== "string") return;
    const raw = ev.data;
    queue = queue
      .then(async () => {
        try {
          const label = (JSON.parse(raw) as { from?: { label?: unknown } }).from?.label;
          if (typeof label === "string" && label !== state.fromLabel) setState({ fromLabel: label });
        } catch {
          /* 坏帧交给 Rust 侧丢弃 */
        }
        const t0 = performance.now();
        const replies = await bridgeMessage(raw);
        const ms = performance.now() - t0;
        if (ms > 100) bridgeTrace(`bridgeMessage slow ${Math.round(ms)}ms`);
        if (ws === socket && socket.readyState === WebSocket.OPEN) {
          for (const r of replies) socket.send(r);
        }
      })
      .catch((e: unknown) => {
        // 单条失败不影响后续
        bridgeTrace(`bridgeMessage failed: ${e instanceof Error ? e.message : String(e)}`);
      });
  };
  socket.onclose = (ev) => {
    bridgeTrace(`ws close code=${ev.code} current=${ws === socket}`);
    if (ws !== socket) return;
    ws = null;
    setState({ connected: false });
    if (ev.code === 4001 || ev.code === 4009) {
      scheduleReconnect(RETRY_SLOW_MS);
      return;
    }
    scheduleReconnect(retryMs);
    retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
  };
}

function disconnect(): void {
  window.clearTimeout(retryTimer);
  const socket = ws;
  ws = null;
  socket?.close();
  setState({ connected: false });
}

/** 开/关接收(设置页调用);持久化为本机偏好。 */
/** 重启系统输入法让它加载插件;失败写进 error(设置页展示)。插件连上后由 voice://state 推新状态。 */
export async function restartIme(): Promise<void> {
  try {
    await bridgeRestartIme();
  } catch (e) {
    setState({ error: e instanceof Error ? e.message : String(e) });
  }
}

/**
 * 开 / 关接收。`fromUser`:设置页里用户亲手打开时,若插件已随安装包装好但在跑的输入法还没加载它
 * (首次安装 / 升级后),顺手重启一次输入法——用户不用知道还有这一步。启动时按偏好恢复则不动输入法。
 */
export async function setVoiceReceiveEnabled(enabled: boolean, fromUser = false): Promise<void> {
  try {
    const bridge = await bridgeSetEnabled(enabled);
    if (enabled && fromUser && bridge.imeSetup === "restart") void restartIme();
    try {
      if (enabled) window.localStorage.setItem(ENABLED_KEY, "1");
      else window.localStorage.removeItem(ENABLED_KEY);
    } catch {
      /* 存不下只是下次启动不自动开启 */
    }
    setState({ enabled, bridge, error: null, fromLabel: enabled ? state.fromLabel : null });
    if (enabled) connect();
    else disconnect();
  } catch (e) {
    disconnect();
    setState({ enabled: false, error: e instanceof Error ? e.message : String(e) });
  }
}

let installed = false;

/** App 启动时调用一次(仅桌面壳生效):订阅 Rust 事件,按本机偏好恢复接收。 */
export function installVoiceReceiver(): void {
  if (installed || !isDesktopTauri()) return;
  installed = true;
  void onBridgeState((bridge) => setState({ bridge }));
  void onBridgeUpstream((json) => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(json);
  });
  let wanted = false;
  try {
    wanted = window.localStorage.getItem(ENABLED_KEY) === "1";
  } catch {
    /* 忽略 */
  }
  if (wanted) void setVoiceReceiveEnabled(true);
}

export function useVoiceReceiver(): VoiceReceiverState {
  return useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    () => state
  );
}

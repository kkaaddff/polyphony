// 服务器连通性(全局单例)。HTTP 成败、协同 WS 连上、浏览器 online/offline 事件都汇总到这里,
// 各端的「离线」标签只读它——不再各页面自己猜。离线期间每 5s 探测 /health,恢复后通知订阅者
// (首页刷新列表;协同 WS 由 y-websocket 自行重连,IndexedDB 里的离线修改随之合并上行)。
import { useEffect, useState, useSyncExternalStore } from "react";
import { getServerBase } from "@/lib/serverConfig";

/** 普通 API 请求超时:服务器 IP 不可达(换网/服务宕机)时 fetch 会挂上几十秒乃至数分钟。 */
export const REQUEST_TIMEOUT_MS = 8000;
const PROBE_INTERVAL_MS = 5000;
const PROBE_TIMEOUT_MS = 4000;
/** 协同 WS 连续未连上多久才算离线(避免每次打开文档握手的几百毫秒里闪一下「离线」)。 */
const WS_GRACE_MS = 3000;

// null = 尚未判定(启动后首个请求返回前)
let reachable: boolean | null = null;
const listeners = new Set<() => void>();
let probeTimer: number | null = null;

function setReachable(next: boolean): void {
  if (reachable === next) return;
  reachable = next;
  if (next) stopProbe();
  else startProbe();
  for (const l of listeners) l();
}

export function markServerReachable(): void {
  setReachable(true);
}

export function markServerUnreachable(): void {
  setReachable(false);
}

/** 超时信号(AbortSignal.timeout 在较老的 WebView 上缺失时手动兜底)。 */
export function timeoutSignal(ms: number): AbortSignal {
  if (typeof AbortSignal.timeout === "function") return AbortSignal.timeout(ms);
  const ctl = new AbortController();
  window.setTimeout(() => ctl.abort(), ms);
  return ctl.signal;
}

async function probe(): Promise<void> {
  try {
    const res = await fetch(`${getServerBase()}/health`, { signal: timeoutSignal(PROBE_TIMEOUT_MS) });
    if (res.ok) markServerReachable();
    else markServerUnreachable();
  } catch {
    markServerUnreachable();
  }
}

function startProbe(): void {
  if (probeTimer !== null || typeof window === "undefined") return;
  probeTimer = window.setInterval(() => void probe(), PROBE_INTERVAL_MS);
}

function stopProbe(): void {
  if (probeTimer === null) return;
  window.clearInterval(probeTimer);
  probeTimer = null;
}

if (typeof window !== "undefined") {
  window.addEventListener("offline", markServerUnreachable);
  window.addEventListener("online", () => void probe());
  // 已登录才在启动时探一次:不可达时 ~4s 出「离线」,不必等业务请求 8s 超时
  if (navigator.onLine === false) markServerUnreachable();
  else if (localStorage.getItem("polyphony.token")) void probe();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** 服务器是否可达:true / false / null(尚未判定)。 */
export function useServerReachable(): boolean | null {
  return useSyncExternalStore(subscribe, () => reachable, () => null);
}

/**
 * 当前是否该显示「离线」。传入协同连接状态时(文档页),WS 连续 WS_GRACE_MS 没连上也算离线;
 * 列表页不传,只看 HTTP 可达性。
 */
export function useIsOffline(wsConnected?: boolean): boolean {
  const server = useServerReachable();
  const [wsStale, setWsStale] = useState(false);
  useEffect(() => {
    if (wsConnected) markServerReachable();
    if (wsConnected !== false) {
      setWsStale(false);
      return;
    }
    const id = window.setTimeout(() => setWsStale(true), WS_GRACE_MS);
    return () => window.clearTimeout(id);
  }, [wsConnected]);
  if (wsConnected) return false;
  return server === false || wsStale;
}

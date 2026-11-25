// 运行时服务器地址解析（CS 直连的核心）。
// 优先级：URL 参数 ?server=（扫码/分享链接进入）> 本机已保存配置（设置页/扫码写入）
//        > 环境变量 VITE_SERVER_URL（仅 dev）> 内置默认服务器（App 壳）> Web 同源 location.origin。
// 内置默认 VITE_DEFAULT_SERVER 来自构建机上不入库的 client/.env.production.local / CI secret
// (ADR #21:公开仓库不出现部署域名);未配置时 App 仍需用户自己填服务器。
// Tauri 侧持久化后续接 plugin-store（platform/store 适配器），Web 侧 localStorage。

const SERVER_KEY = "polyphony.server";

function normalize(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

export function getSavedServer(): string {
  try {
    return window.localStorage.getItem(SERVER_KEY) ?? "";
  } catch {
    return "";
  }
}

export function saveServer(url: string): string {
  const normalized = normalize(url);
  try {
    if (normalized) {
      window.localStorage.setItem(SERVER_KEY, normalized);
    } else {
      window.localStorage.removeItem(SERVER_KEY);
    }
  } catch {
    /* 忽略写入失败（隐私模式等） */
  }
  return normalized;
}

export function getServerBase(): string {
  // 1. URL 参数（扫码进入时 ?server= 直连地址）
  const fromUrl = new URLSearchParams(window.location.search).get("server");
  if (fromUrl) return normalize(fromUrl);
  // 2. 已保存配置
  const saved = getSavedServer();
  if (saved) return saved;
  // 3. dev 环境变量
  const env = import.meta.env.VITE_SERVER_URL;
  if (env) return normalize(env);
  // 4. App 壳(Tauri)没有「同源」:用内置默认服务器,开箱即用
  if (isAppShell()) {
    const builtin = getDefaultServer();
    if (builtin) return builtin;
  }
  // 5. Web 同源（nginx/OpenResty 反代同源部署）
  return window.location.origin;
}

/** 构建时内置的默认服务器(可能为空)。 */
export function getDefaultServer(): string {
  const v = import.meta.env.VITE_DEFAULT_SERVER;
  return v ? normalize(v) : "";
}

function isAppShell(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** 是否已配置显式服务器（用于 App/Web 首页引导提示）。 */
export function hasExplicitServer(): boolean {
  return !!(getSavedServer() || import.meta.env.VITE_SERVER_URL || (isAppShell() && getDefaultServer()));
}

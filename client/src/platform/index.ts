// 平台能力封装：Tauri 与 Web 的差异全部收敛到这个目录。
// P2 仅做环境探测（黄条引导强度、后续 store/scan/tray 按此分流）；
// plugin-store 持久化、扫码、托盘分别在 P3/P4/P5 接入。

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** 桌面 App（托盘等桌面专属能力仅在桌面壳存在）。 */
export function isDesktopTauri(): boolean {
  return isTauri() && !/android|ios|iphone|ipad/i.test(navigator.userAgent);
}

/** Android App（配对登录的扫码方）。 */
export function isAndroidTauri(): boolean {
  return isTauri() && /android/i.test(navigator.userAgent);
}

/**
 * 平台枚举上报(V15:设备名的唯一来源,服务端拼名,不接受自由文本)。
 * client: App 壳 or 浏览器;os 由 UA 推断,落在固定枚举内。
 */
export type PlatformInfo = { client: "app" | "web"; os: "android" | "ios" | "macos" | "windows" | "linux" | "other" };

export function platformInfo(): PlatformInfo {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  const os: PlatformInfo["os"] = /android/i.test(ua)
    ? "android"
    : /iphone|ipad|ios/i.test(ua)
      ? "ios"
      : /mac os x/i.test(ua)
        ? "macos"
        : /windows/i.test(ua)
          ? "windows"
          : /linux/i.test(ua)
            ? "linux"
            : "other";
  return { client: isTauri() ? "app" : "web", os };
}

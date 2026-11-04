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

/** Android App（配对登录的扫码方,隐藏「登录新设备」出码入口）。 */
export function isAndroidTauri(): boolean {
  return isTauri() && /android/i.test(navigator.userAgent);
}

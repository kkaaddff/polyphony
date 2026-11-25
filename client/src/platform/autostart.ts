// 桌面开机自启(仅 isDesktopTauri):系统自启项由 Rust 侧 tauri-plugin-autostart 管理,
// 自启拉起时带 --autostart 只驻留托盘(语音接收端照常工作)。
// 首次启动默认开启一次;之后完全以用户在设置页的选择为准(关掉不会被再次打开)。
import { invoke } from "@tauri-apps/api/core";

const DEFAULTED_KEY = "polyphony.autostartDefaulted";

export function getAutostart(): Promise<boolean> {
  return invoke<boolean>("autostart_get");
}

export function setAutostart(enabled: boolean): Promise<boolean> {
  return invoke<boolean>("autostart_set", { enabled });
}

/** 首次启动把开机自启默认打开(只做一次)。 */
export async function ensureAutostartDefault(): Promise<void> {
  try {
    if (window.localStorage.getItem(DEFAULTED_KEY)) return;
    if (!(await getAutostart())) await setAutostart(true);
    window.localStorage.setItem(DEFAULTED_KEY, "1");
  } catch (e) {
    console.error("autostart default failed", e);
  }
}

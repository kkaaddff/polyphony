// iOS App:键盘弹起时钉住 webview 的原生滚动视图(src-tauri/src/ios_scroll_pin.rs)。
// WebKit 弹键盘时会滚动整页来露出输入框,全屏页(便签 / 首页 / 文档页)已按可视区定高,这次滚动
// 只会让页头先被推走再补回来。全屏页挂载期间打开开关,卸载时关掉;其它平台为空操作。
import { useEffect } from "react";
import { isIosTauri } from "./index";

let holders = 0;

async function sync(pinned: boolean): Promise<void> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("ios_set_scroll_pinned", { pinned });
  } catch {
    // 旧壳没有这个命令:退回前端的 --vv-top 补偿(lib/viewport.ts)
  }
}

/** 全屏钉住页调用;active=false(如桌面布局)时不占用。 */
export function useIosScrollPin(active = true): void {
  useEffect(() => {
    if (!active || !isIosTauri()) return;
    if (holders++ === 0) void sync(true);
    return () => {
      if (--holders === 0) void sync(false);
    };
  }, [active]);
}

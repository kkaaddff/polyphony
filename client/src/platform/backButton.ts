// Android 返回键 / 侧滑返回(v4 真机联调实踩「没有侧滑返回、没法退出」):
// TauriActivity 生成代码 handleBackNavigation=false,返回事件交给 app 插件 → 前端
// 不监听就什么都不发生。这里做成一个后进先出的处理栈:
//   弹层/扫码等「可关闭的东西」打开时压栈,返回先关它;
//   栈空时:WebView 能后退就 history.back(),否则退出 App(到桌面)。
// 非 Android Tauri 环境(Web/桌面)全部为空操作。
import { useEffect, useRef } from "react";
import { isAndroidTauri } from "./index";

type Handler = () => void;
const stack: Handler[] = [];

/** 注册一个返回处理(后注册的先处理);返回注销函数。 */
export function pushBackHandler(h: Handler): () => void {
  stack.push(h);
  return () => {
    const i = stack.lastIndexOf(h);
    if (i >= 0) stack.splice(i, 1);
  };
}

let installed = false;

/** App 启动时调用一次。 */
export async function installBackButton(): Promise<void> {
  if (installed || !isAndroidTauri()) return;
  installed = true;
  const { onBackButtonPress, exit } = await import("@tauri-apps/api/app");
  await onBackButtonPress(({ canGoBack }) => {
    const top = stack[stack.length - 1];
    if (top) {
      top();
      return;
    }
    // 首页/欢迎页是导航根:不再 history.back 回到别的根页面,直接退出
    const atRoot = ["/", "/welcome"].includes(window.location.pathname);
    if (canGoBack && !atRoot) {
      window.history.back();
      return;
    }
    void exit(0);
  });
}

/** React:active 为真期间,返回键调用 onBack(用 ref 取最新回调,避免反复压栈)。 */
export function useBackHandler(active: boolean, onBack: () => void): void {
  const ref = useRef(onBack);
  ref.current = onBack;
  useEffect(() => {
    if (!active) return;
    return pushBackHandler(() => ref.current());
  }, [active]);
}

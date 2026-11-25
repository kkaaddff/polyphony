// Android 返回键 / 侧滑返回(v4 真机联调实踩「没有侧滑返回、没法退出」):
// TauriActivity 生成代码 handleBackNavigation=false,返回事件交给 app 插件 → 前端
// 不监听就什么都不发生。这里做成一个后进先出的处理栈:
//   弹层/扫码等「可关闭的东西」打开时压栈,返回先关它;
//   栈空时:WebView 能后退就 history.back(),否则把 App 退到后台(进程保留)。
// 不用 app.exit():Tauri Android 的 exit 会让进程在析构阶段原生崩溃(FORTIFY destroyed mutex),
// 系统随后拉起再崩一次 → 用户看到「再启动闪退一次」。详见 src-tauri/src/lib.rs move_task_to_back。
// 非 Android Tauri 环境(Web/桌面)全部为空操作。
import { useEffect, useRef } from "react";
import { isAndroidTauri, isIosTauri } from "./index";

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
  const { onBackButtonPress } = await import("@tauri-apps/api/app");
  const { invoke } = await import("@tauri-apps/api/core");
  await onBackButtonPress(({ canGoBack }) => {
    const top = stack[stack.length - 1];
    if (top) {
      top();
      return;
    }
    // 首页/欢迎页是导航根:不再 history.back 回到别的根页面,直接退到后台
    const atRoot = ["/", "/welcome"].includes(window.location.pathname);
    if (canGoBack && !atRoot) {
      window.history.back();
      return;
    }
    void invoke("move_task_to_back");
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

let overlaySeq = 0;

/** iOS App:让「不是路由的全屏层」(移动文档页)也能用屏幕左缘右滑返回。
 *  iOS 的滑动返回是 WKWebView 的历史导航手势,只认浏览历史;文档页是首页上的状态层、没有历史记录,
 *  右滑就没反应。这里在它打开时压一条同地址的历史记录,右滑(popstate 离开这条记录)时调用 onBack;
 *  用页内按钮关闭时把这条记录退掉,保持历史栈干净。其它平台为空操作。 */
export function useIosSwipeBack(onBack: () => void): void {
  const ref = useRef(onBack);
  ref.current = onBack;
  useEffect(() => {
    if (!isIosTauri()) return;
    const id = `overlay-${++overlaySeq}`;
    const isOurs = () => (window.history.state as { polyOverlay?: string } | null)?.polyOverlay === id;
    // 沿用路由器写在 state 里的字段(key / idx),只多打一个标记
    window.history.pushState({ ...(window.history.state ?? {}), polyOverlay: id }, "");
    let popped = false;
    const onPop = () => {
      if (popped || isOurs()) return;
      popped = true;
      ref.current();
    };
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
      // 还停在自己压的那条记录上(页内按钮关闭)才退;已经跳去别的页面就不动它
      if (!popped && isOurs()) window.history.back();
    };
  }, []);
}

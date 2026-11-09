// 软键盘适配:把 visualViewport 的可见高度/偏移写成 CSS 变量(--vvh / --vv-top)。
// 背景(v4.1 真机联调实测):Android WebView 在 edge-to-edge 下 adjustResize 不生效、
// 也不认 viewport meta 的 interactive-widget——键盘弹出时布局视口不缩(innerHeight 不变),
// 只有 visualViewport 变矮并把整页往上平移:顶栏被推出屏幕、底部工具栏压在键盘下。
// 需要「贴键盘」的全屏层(移动文档页、底部输入面板)用这两个变量定高定位,始终落在可见区。
//
// 键盘收起即失焦(仅触屏):Android 返回手势先被输入法吃掉用来收键盘,但焦点还留在输入框/正文里,
// 页面仍处于「编辑态」——用户得再划一次才退出编辑、再一次才回列表(真机实测编辑中退到后台要划 4 次)。
// 键盘一收就 blur,编辑态(MobileDocView 以焦点判定)随之结束、标题改名照常在 blur 时提交。
export function installViewportVars(): void {
  const vv = window.visualViewport;
  if (!vv) return;
  const root = document.documentElement;
  const touch = window.matchMedia("(pointer: coarse)").matches;
  let wasOpen = false;
  const update = () => {
    root.style.setProperty("--vvh", `${vv.height}px`);
    root.style.setProperty("--vv-top", `${vv.offsetTop}px`);
    // 键盘弹起时底部手势条安全区被键盘盖住,贴键盘的工具栏不该再留这段空白
    const keyboardOpen = window.innerHeight - vv.height > 120;
    root.style.setProperty("--kb-safe-bottom", keyboardOpen ? "0px" : "env(safe-area-inset-bottom)");
    if (touch && wasOpen && !keyboardOpen) {
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.isContentEditable || el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) el.blur();
    }
    wasOpen = keyboardOpen;
  };
  vv.addEventListener("resize", update);
  vv.addEventListener("scroll", update);
  update();
}

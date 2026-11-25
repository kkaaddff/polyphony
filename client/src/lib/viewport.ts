// 软键盘适配:把 visualViewport 的可见高度/偏移写成 CSS 变量(--vvh / --vv-top)。
// 背景(v4.1 真机联调实测):Android WebView 在 edge-to-edge 下 adjustResize 不生效、
// 也不认 viewport meta 的 interactive-widget——键盘弹出时布局视口不缩(innerHeight 不变),
// 只有 visualViewport 变矮并把整页往上平移:顶栏被推出屏幕、底部工具栏压在键盘下。
// 需要「贴键盘」的全屏层(移动文档页、底部输入面板)用这两个变量定高定位,始终落在可见区。
//
// --vv-top 按平台取值(见 update 里的注释):Android 用 vv.offsetTop;iOS 放一个 position:fixed;top:0 的
// 隐藏探针,实测它离可视区顶部多远再取反——iOS 模拟器与真机里 fixed 的锚点不一致、offsetTop 也不可信。
// iOS App 另有原生层把 webview 滚动视图钉住(platform/iosScroll.ts),正常情况下探针量到的就是 0。
//
// 键盘收起即失焦(仅 Android 触屏):Android 返回手势先被输入法吃掉用来收键盘,但焦点还留在输入框/正文里,
// 页面仍处于「编辑态」——用户得再划一次才退出编辑、再一次才回列表(真机实测编辑中退到后台要划 4 次)。
// 键盘一收就 blur,编辑态(MobileDocView 以焦点判定)随之结束、标题改名照常在 blur 时提交。
export function installViewportVars(): void {
  const vv = window.visualViewport;
  if (!vv) return;
  const root = document.documentElement;
  // 「键盘收起即失焦」只给 Android(返回手势先被输入法吃掉);iOS 收键盘本来就会失焦,不需要——
  // 而且 iOS 真机键盘弹起过程中 innerHeight 会瞬时跟着缩,被误判成「键盘收了」会把刚弹起的键盘 blur 掉。
  const android = /Android/i.test(navigator.userAgent);
  const blurOnClose = android && window.matchMedia("(pointer: coarse)").matches;
  let wasOpen = false;
  // 键盘是否弹起:拿「见过的最大 innerHeight」当满屏基准(iOS 的 innerHeight 在键盘动画中不稳定);转屏(宽度变)时重置
  let baseH = window.innerHeight;
  let baseW = window.innerWidth;

  // 键盘动画期间 iOS 只在结束时发 resize,过程中的偏移变化靠 scroll / 逐帧采样才跟得上。
  let probe: HTMLElement | null = null;
  const getProbe = (): HTMLElement | null => {
    if (probe && probe.isConnected) return probe;
    if (!document.body) return null;
    probe = document.createElement("div");
    probe.setAttribute("aria-hidden", "true");
    probe.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;visibility:hidden;pointer-events:none";
    document.body.appendChild(probe);
    return probe;
  };

  const last: Record<string, string> = {};
  const setVar = (name: string, value: string) => {
    if (last[name] === value) return;
    last[name] = value;
    root.style.setProperty(name, value);
  };

  let pendingH = "";
  let transientSince = 0;
  let needKick = false;
  const update = () => {
    const p = getProbe();
    // 取不到探针(body 未就绪)时退回 offsetTop——与旧行为一致
    // Android WebView:键盘把可视区在布局视口里下移 offsetTop,fixed 仍锚在布局视口,探针量到的是 0——
    // 必须直接用 offsetTop(v4.1 真机验证过的做法;v4.2 一度全平台改用探针,安卓文档页顶栏被推出屏幕)。
    // iOS:offsetTop 在真机上不可信(fixed 实际已贴着可视区时它仍报几百),用探针实测。
    const top = android || !p ? vv.offsetTop : -p.getBoundingClientRect().top;
    // 高度要连续两次采样一致才生效:iOS 真机键盘弹起过程中 vv.height 会冒出只存在一帧的中间值
    // (第三方输入法尤其明显),直接跟会让贴底的输入框先跳到错的位置再跳回来。
    const h = `${vv.height}px`;
    // 过渡态:布局视口(innerHeight)自己缩了、可视高度却比它还小——iOS 真机键盘弹起途中的假值
    // (实测 innerH=431 vvH=203,真实可视高度是 431),跟了它贴底的输入框会被甩到页头下面再弹回来。
    // 正常只有两种:布局视口不缩(innerH 仍是满屏)或者布局视口跟着缩到可视高度(vvH≈innerH)。
    // 超过 500ms 还是这样就当它是真的(避免基准过期时卡死)。
    const transient = window.innerHeight < baseH - 1 && vv.height < window.innerHeight - 1;
    const now = performance.now();
    if (!transient) transientSince = 0;
    else if (!transientSince) transientSince = now;
    if (transient && now - transientSince < 500) {
      needKick = true;
    } else if (h === last["--vvh"] || h === pendingH || last["--vvh"] === undefined) {
      setVar("--vvh", h);
      pendingH = "";
    } else {
      pendingH = h;
      needKick = true;
    }
    setVar("--vv-top", `${Math.round(top * 2) / 2}px`);
    // 键盘弹起时底部手势条安全区被键盘盖住,贴键盘的工具栏不该再留这段空白
    if (window.innerWidth !== baseW) { baseW = window.innerWidth; baseH = window.innerHeight; }
    else if (window.innerHeight > baseH) baseH = window.innerHeight;
    const keyboardOpen = baseH - vv.height > 120;
    setVar("--kb-safe-bottom", keyboardOpen ? "0px" : "env(safe-area-inset-bottom)");
    if (blurOnClose && wasOpen && !keyboardOpen) {
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.isContentEditable || el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) el.blur();
    }
    wasOpen = keyboardOpen;
  };

  // 焦点切换 / 视口变化后的 ~1.2s 内逐帧重算,覆盖键盘滑入滑出的整个动画;
  // 输入框保持焦点期间持续逐帧(iOS 键盘出来之后还会再调视口,例如第三方输入法的候选栏,期间不一定有事件)
  const editableFocused = () => {
    const el = document.activeElement as HTMLElement | null;
    return !!el && (el.isContentEditable || el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement);
  };
  let rafUntil = 0;
  let rafId = 0;
  const tick = () => {
    rafId = 0;
    update();
    if (performance.now() < rafUntil || editableFocused() || pendingH || transientSince) rafId = requestAnimationFrame(tick);
  };
  const kick = () => {
    rafUntil = performance.now() + 1200;
    if (!rafId) rafId = requestAnimationFrame(tick);
  };

  // 待确认的高度要有下一帧来复核
  const sample = () => {
    update();
    if (needKick) { needKick = false; kick(); }
  };
  vv.addEventListener("resize", () => { update(); needKick = false; kick(); });
  vv.addEventListener("scroll", sample);
  window.addEventListener("scroll", sample, { passive: true });
  window.addEventListener("focusin", kick);
  window.addEventListener("focusout", kick);
  update();

  // 仅构建时 VITE_VV_DEBUG=1 才存在(默认构建整段被删除):屏幕上叠一块实时数值,真机排查键盘布局用。
  if (import.meta.env.VITE_VV_DEBUG === "1") installDebugOverlay(vv, root);
}

function installDebugOverlay(vv: VisualViewport, root: HTMLElement): void {
  const box = document.createElement("div");
  box.style.cssText =
    "position:fixed;left:4px;top:96px;z-index:2147483647;pointer-events:none;background:rgba(255,255,255,.92);" +
    "color:#000;border:2px solid #f00;padding:4px 6px;font:11px/1.35 ui-monospace,Menlo,monospace;white-space:pre";
  box.setAttribute("aria-hidden", "true");
  const abs = document.createElement("div");
  abs.style.cssText = "position:absolute;top:0;left:0;width:1px;height:1px;visibility:hidden";
  const fix = document.createElement("div");
  fix.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;visibility:hidden";
  const mount = () => {
    document.body.append(box, abs, fix);
    const draw = () => {
      box.textContent =
        `innerH=${window.innerHeight} vvH=${Math.round(vv.height)} vvTop=${Math.round(vv.offsetTop)}\n` +
        `scrollY=${Math.round(window.scrollY)} fixedTop=${Math.round(fix.getBoundingClientRect().top)} absTop=${Math.round(abs.getBoundingClientRect().top)}\n` +
        `--vv-top=${root.style.getPropertyValue("--vv-top")} --vvh=${root.style.getPropertyValue("--vvh")}`;
      requestAnimationFrame(draw);
    };
    draw();
  };
  if (document.body) mount();
  else window.addEventListener("DOMContentLoaded", mount, { once: true });
}

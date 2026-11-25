// 移动布局判定:与 Tailwind md 断点(768px)对齐。
// 移动端走单独的原生化界面(components/mobile/),桌面保留双栏;窗口跨断点时即时切换。
import { useSyncExternalStore } from "react";

const QUERY = "(max-width: 767px)";

function subscribe(onChange: () => void) {
  const mql = window.matchMedia(QUERY);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

export function useIsMobile(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(QUERY).matches,
    () => false
  );
}

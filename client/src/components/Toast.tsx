// 轻量 toast:手写 Provider,3s 自动消失;替代复制反馈等场景的阻塞式 alert()。
// 墨色胶囊(纸面上最稳的浮层),图标区分成功 / 失败 / 提示。
// 容器 pointer-events-none —— toast 永不拦截点击(也避免遮挡 Playwright 的下一步操作)。
import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactNode,
} from "react";
import { Icon, type IconName } from "./icons";
import { cx } from "./ui";

type ToastVariant = "success" | "error" | "info";

interface ToastItem {
  id: number;
  message: string;
  variant: ToastVariant;
}

interface ToastContextValue {
  show: (message: string, variant?: ToastVariant) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast 必须在 <ToastProvider> 内使用");
  return ctx;
}

const VARIANT_ICON: Record<ToastVariant, IconName> = {
  success: "check",
  error: "alert",
  info: "info",
};
const VARIANT_TINT: Record<ToastVariant, string> = {
  success: "text-[#6ee7b7]",
  error: "text-[#fda4af]",
  info: "text-accent-200",
};

let nextId = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const show = useCallback((message: string, variant: ToastVariant = "info") => {
    const id = nextId;
    nextId += 1;
    setItems((prev) => [...prev, { id, message, variant }]);
    setTimeout(() => {
      setItems((prev) => prev.filter((it) => it.id !== id));
    }, 3000);
  }, []);

  return (
    <ToastContext.Provider value={{ show }}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 top-[calc(env(safe-area-inset-top)+0.75rem)] z-[70] flex flex-col items-center gap-2 px-4"
      >
        {items.map((it) => (
          <div
            key={it.id}
            role="status"
            className="inline-flex h-10 max-w-sm animate-rise-in items-center gap-2 rounded-full bg-ink py-2 pr-4 pl-3.5 text-13 font-medium text-white shadow-float"
          >
            <Icon name={VARIANT_ICON[it.variant]} className={cx("size-4 shrink-0", VARIANT_TINT[it.variant])} />
            {it.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

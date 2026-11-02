// 轻量 toast:手写 Provider,3s 自动消失;替代复制反馈等场景的阻塞式 alert()。
// 容器 pointer-events-none —— toast 永不拦截点击(也避免遮挡 Playwright 的下一步操作)。
import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactNode,
} from "react";

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

const VARIANT_CLASS: Record<ToastVariant, string> = {
  success: "text-green-700 border-green-200",
  error: "text-red-700 border-red-200",
  info: "text-gray-900 border-gray-200",
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
        className="fixed inset-x-0 bottom-[calc(env(safe-area-inset-bottom)+1.5rem)] z-[70] flex flex-col items-center gap-2 px-4 pointer-events-none"
      >
        {items.map((it) => (
          <div
            key={it.id}
            role="status"
            className={`max-w-sm rounded-lg border bg-white px-4 py-2.5 text-sm font-medium shadow-lg ${VARIANT_CLASS[it.variant]}`}
          >
            {it.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

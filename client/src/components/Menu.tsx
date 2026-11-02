// 通用下拉菜单:触发按钮 + role=menu 面板;pointerdown 外部 / ESC 关闭。
// MenuItem 先关菜单再执行回调 —— 避免与弹层(QrModal/底部面板,同为 z-50)叠层互挡。
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

interface MenuProps {
  buttonTitle: string;
  buttonContent: ReactNode;
  buttonClassName?: string;
  children: ReactNode;
}

const MenuCloseContext = createContext<{ close: () => void } | null>(null);

export function Menu({
  buttonTitle,
  buttonContent,
  buttonClassName = "",
  children,
}: MenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    // pointerdown(而非 click):在外部按钮的点击到达前先收起,避免开合竞争。
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        title={buttonTitle}
        aria-haspopup="menu"
        aria-expanded={open}
        className={buttonClassName}
        onClick={() => setOpen((v) => !v)}
      >
        {buttonContent}
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-50 mt-2 min-w-44 rounded-lg border border-gray-100 bg-white py-1 shadow-lg"
        >
          <MenuCloseContext.Provider value={{ close: () => setOpen(false) }}>
            {children}
          </MenuCloseContext.Provider>
        </div>
      )}
    </div>
  );
}

export function MenuItem({
  onClick,
  children,
  className = "",
}: {
  onClick: () => void;
  children: ReactNode;
  className?: string;
}) {
  const ctx = useContext(MenuCloseContext);
  return (
    <button
      type="button"
      role="menuitem"
      className={`min-h-tap-40 w-full px-4 py-2.5 text-left text-sm text-gray-700 hover:bg-gray-50 ${className}`}
      onClick={() => {
        ctx?.close();
        onClick();
      }}
    >
      {children}
    </button>
  );
}

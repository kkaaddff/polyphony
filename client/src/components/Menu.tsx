// 通用浮层:触发按钮 + 绝对定位面板;pointerdown 外部 / ESC / Android 返回键关闭。
// - Menu    = role=menu 面板(菜单语义完整)。MenuItem 先关菜单再执行回调——
//             避免与弹层(Dialog,同为 z-50)叠层互挡;
// - Popover = 任意内容的轻面板(在线列表、加入文档),不带 menu 语义,
//             以免干扰按 role=menu 的查询(e2e 与读屏都依赖「一屏一个菜单」)。
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { useBackHandler } from "@/platform/backButton";
import { Icon, type IconName } from "./icons";
import { cx } from "./ui";

type Align = "left" | "right";

/** 打开期间:外部 pointerdown / ESC 关闭(回调走 ref,取最新值)。 */
function useDismiss(open: boolean, close: () => void, rootRef: RefObject<HTMLElement | null>) {
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!open) return;
    // pointerdown(而非 click):在外部按钮的点击到达前先收起,避免开合竞争。
    const onPointerDown = (e: PointerEvent) => {
      // 点在本浮层之上叠放的弹层里(扫码、对话框:portal 到 body,不在 root 内)不算「外部」
      const target = e.target as Element | null;
      if (target?.closest?.("[data-floating]")) return;
      if (rootRef.current && !rootRef.current.contains(target as Node)) closeRef.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeRef.current();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, rootRef]);
}

const PANEL = "absolute z-50 min-w-52 max-w-[calc(100vw-2rem)] rounded-14 bg-sheet p-1.5 shadow-md animate-pop-in";
// 浮层标记:叠在其上的弹层(扫码/对话框)里的点击不算「外部」,不触发收起
const FLOATING = { "data-floating": true } as const;

interface MenuProps {
  buttonTitle: string;
  buttonContent: ReactNode;
  buttonClassName?: string;
  children: ReactNode;
  /** 面板相对触发按钮的对齐边(默认右对齐:触发器多在角落) */
  align?: Align;
  /** 触发器贴近视口底部时向上展开 */
  up?: boolean;
  disabled?: boolean;
}

const MenuCloseContext = createContext<{ close: () => void } | null>(null);

export function Menu({
  buttonTitle,
  buttonContent,
  buttonClassName,
  children,
  align = "right",
  up = false,
  disabled = false,
}: MenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const close = () => setOpen(false);
  // Android 返回键:先收起菜单
  useBackHandler(open, close);
  useDismiss(open, close, rootRef);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        title={buttonTitle}
        aria-label={buttonTitle}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        className={buttonClassName}
        onClick={() => setOpen((v) => !v)}
      >
        {buttonContent}
      </button>
      {open && (
        <div role="menu" {...FLOATING} className={cx(PANEL, up ? "bottom-full mb-1.5" : "top-full mt-1.5", align === "right" ? "right-0" : "left-0")}>
          <MenuCloseContext.Provider value={{ close }}>{children}</MenuCloseContext.Provider>
        </div>
      )}
    </div>
  );
}

export function MenuItem({
  onClick,
  children,
  className,
  icon,
  danger = false,
  disabled = false,
}: {
  onClick: () => void;
  children: ReactNode;
  className?: string;
  icon?: IconName;
  /** 危险项:红字 + 红底悬停 */
  danger?: boolean;
  disabled?: boolean;
}) {
  const ctx = useContext(MenuCloseContext);
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      className={cx(
        "flex min-h-tap-40 w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 text-left text-sm whitespace-nowrap text-ink transition-colors duration-100 ease-swift hover:bg-fill-1 focus-visible:bg-fill-1 focus-visible:-outline-offset-2 focus-visible:outline-2 focus-visible:outline-accent-600 disabled:cursor-not-allowed disabled:opacity-45",
        danger && "text-danger hover:bg-danger-bg focus-visible:bg-danger-bg",
        className
      )}
      onClick={() => {
        ctx?.close();
        onClick();
      }}
    >
      {icon && <Icon name={icon} className={cx("size-4 shrink-0", danger ? "text-danger" : "text-ink-3")} />}
      {children}
    </button>
  );
}

export function MenuSeparator() {
  return <div role="separator" className="mx-2 my-1 h-px bg-line" />;
}

interface PopoverProps {
  buttonTitle: string;
  buttonContent: ReactNode;
  buttonClassName?: string;
  children: ReactNode;
  align?: Align;
  up?: boolean;
  /** 面板宽度等额外类名 */
  className?: string;
  /** 受控开合(如 ?join= 自动展开「加入文档」);不传则内部自管理 */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function Popover({
  buttonTitle,
  buttonContent,
  buttonClassName,
  children,
  align = "right",
  up = false,
  className,
  open: openProp,
  onOpenChange,
}: PopoverProps) {
  const [openState, setOpenState] = useState(false);
  const controlled = openProp !== undefined;
  const open = controlled ? openProp : openState;
  const rootRef = useRef<HTMLDivElement>(null);
  const close = () => (controlled ? onOpenChange?.(false) : setOpenState(false));
  const toggle = () => (controlled ? onOpenChange?.(!open) : setOpenState((v) => !v));
  useBackHandler(open, close);
  useDismiss(open, close, rootRef);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        title={buttonTitle}
        aria-label={buttonTitle}
        aria-expanded={open}
        className={buttonClassName}
        onClick={toggle}
      >
        {buttonContent}
      </button>
      {open && (
        <div
          {...FLOATING}
          className={cx(
            PANEL,
            "w-72 p-2",
            up ? "bottom-full mb-1.5" : "top-full mt-1.5",
            align === "right" ? "right-0" : "left-0",
            className
          )}
        >
          {children}
        </div>
      )}
    </div>
  );
}

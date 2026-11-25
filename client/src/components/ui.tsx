// 基础控件(v5):按钮 / 图标按钮 / 分段控件 / 开关 / 提示条 / 标签 / 输入 / 对话框。
// 全部只由 @theme 令牌拼成——实心 = 主操作,描边 = 次操作,幽灵 = 第三级;危险操作用红色实心或红色幽灵。
// 触屏(移动端断点以下)按钮自动抬到 ≥40px,图标按钮由调用方选 size="touch"(44px)。
import {
  useEffect,
  type ButtonHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
} from "react";
import { createPortal } from "react-dom";
import { useT } from "@/i18n";
import { useBackHandler } from "@/platform/backButton";
import { Icon, type IconName } from "./icons";

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/* ---------- 按钮 ---------- */
type Variant = "primary" | "secondary" | "ghost" | "danger" | "dangerGhost";
type Size = "sm" | "md" | "lg";

const BTN_BASE =
  "inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap font-medium select-none transition-[background-color,color,box-shadow,transform] duration-100 ease-swift active:scale-[0.975] disabled:cursor-not-allowed disabled:opacity-45 disabled:active:scale-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-600";
const BTN_VARIANT: Record<Variant, string> = {
  primary:
    "bg-accent text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.16),0_1px_2px_rgb(27_28_38/0.16)] hover:bg-accent-700",
  secondary: "bg-sheet text-ink shadow-[inset_0_0_0_1px_var(--color-line-strong)] hover:bg-sheet-tint",
  ghost: "text-ink-2 hover:bg-fill-2 hover:text-ink",
  danger: "bg-danger text-white hover:bg-[#ad2833]",
  dangerGhost: "text-danger hover:bg-danger-bg",
};
const BTN_SIZE: Record<Size, string> = {
  sm: "h-[30px] rounded-lg px-2.5 text-13 max-md:h-9",
  md: "h-9 rounded-10 px-3.5 text-sm max-md:min-h-tap-40",
  lg: "min-h-tap-44 rounded-xl px-5 text-15",
};

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: Size;
  icon?: IconName;
};

export function Button({
  variant = "secondary",
  size = "md",
  icon,
  className,
  children,
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <button type={type} className={cx(BTN_BASE, BTN_VARIANT[variant], BTN_SIZE[size], className)} {...rest}>
      {icon && <Icon name={icon} className="size-4 shrink-0" />}
      {children}
    </button>
  );
}

/** md 是默认档,触屏断点以下自动抬到 40px;touch = 移动端统一 44px;sm = 行内悬停操作(列表行、便签卡)。 */
type IconSize = "sm" | "md" | "lg" | "touch";

const ICONBTN: Record<IconSize, string> = {
  sm: "size-7 rounded-[7px]",
  md: "size-9 rounded-10 max-md:size-10",
  lg: "size-10 rounded-10",
  touch: "size-tap-44 rounded-full",
};
const ICON: Record<IconSize, string> = {
  sm: "size-[15px]",
  md: "size-[18px]",
  lg: "size-5",
  touch: "size-[22px]",
};

export function IconButton({
  icon,
  label,
  size = "md",
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { icon?: IconName; label: string; size?: IconSize }) {
  return (
    <button
      type="button"
      title={rest.title ?? label}
      aria-label={label}
      className={cx(
        "inline-flex shrink-0 cursor-pointer items-center justify-center text-ink-2 transition-colors duration-100 ease-swift hover:bg-fill-2 hover:text-ink active:bg-fill-3 focus-visible:outline-2 focus-visible:outline-accent-600 disabled:cursor-not-allowed disabled:opacity-45",
        ICONBTN[size],
        className
      )}
      {...rest}
    >
      {icon ? <Icon name={icon} className={ICON[size]} /> : children}
    </button>
  );
}

/* ---------- 分段控件(按钮 + aria-pressed,保持 role=button 语义) ---------- */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  className,
  label,
  size = "sm",
}: {
  value: T;
  onChange: (value: T) => void;
  options: Array<{ value: T; label: ReactNode }>;
  className?: string;
  /** 无障碍名称(分组) */
  label?: string;
  size?: "sm" | "md";
}) {
  return (
    <div className={cx("inline-flex gap-0.5 rounded-10 bg-fill-2 p-[3px]", className)} role="group" aria-label={label}>
      {options.map((opt) => {
        const on = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(opt.value)}
            className={cx(
              "inline-flex cursor-pointer items-center justify-center gap-1 whitespace-nowrap rounded-lg px-3 text-13 font-medium transition-colors duration-100 ease-swift focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-600",
              size === "sm" ? "h-7 max-md:h-9" : "min-h-tap-40 flex-1 px-1.5",
              on ? "bg-sheet text-ink shadow-[0_1px_2px_rgb(27_28_38/0.12)]" : "text-ink-2 hover:text-ink"
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

/* ---------- 开关 ---------- */
export function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  /** 无障碍名称(开关旁可见文字的复述) */
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx(
        "relative h-[26px] w-11 shrink-0 cursor-pointer rounded-full transition-colors duration-200 ease-swift disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-600",
        checked ? "bg-accent-600" : "bg-fill-3"
      )}
    >
      <span
        className={cx(
          "absolute left-[3px] top-[3px] size-5 rounded-full bg-white shadow-[0_1px_3px_rgb(0_0_0/0.25)] transition-transform duration-200 ease-swift",
          checked && "translate-x-[18px]"
        )}
      />
    </button>
  );
}

/* ---------- 提示条 / 标签 ---------- */
const CALLOUT: Record<"warn" | "danger" | "ok" | "info", string> = {
  warn: "bg-warn-bg text-warn shadow-[inset_0_0_0_1px_var(--color-warn-line)]",
  danger: "bg-danger-bg text-danger shadow-[inset_0_0_0_1px_var(--color-danger-line)]",
  ok: "bg-ok-bg text-ok shadow-[inset_0_0_0_1px_var(--color-ok-line)]",
  info: "bg-accent-50 text-accent-800 shadow-[inset_0_0_0_1px_var(--color-accent-100)]",
};
const CALLOUT_ICON = { warn: "alert", danger: "alert", ok: "check", info: "info" } as const;

export function Callout({
  tone = "warn",
  icon,
  children,
  className,
}: {
  tone?: keyof typeof CALLOUT;
  /** 覆盖默认图标;传 null 可去掉 */
  icon?: IconName | null;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx("flex gap-2.5 rounded-xl px-3.5 py-3 text-13 leading-normal", CALLOUT[tone], className)}>
      {icon !== null && <Icon name={icon ?? CALLOUT_ICON[tone]} className="mt-px size-4 shrink-0" />}
      <span className="min-w-0">{children}</span>
    </div>
  );
}

const TAG: Record<"neutral" | "accent" | "ok" | "warn" | "danger", string> = {
  neutral: "bg-fill-2 text-ink-3",
  accent: "bg-accent-50 text-accent-800",
  ok: "bg-ok-bg text-ok",
  warn: "bg-warn-bg text-warn",
  danger: "bg-danger-bg text-danger",
};

export function Tag({
  tone = "neutral",
  icon,
  children,
  className,
}: {
  tone?: keyof typeof TAG;
  icon?: IconName;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cx(
        "inline-flex h-5 shrink-0 items-center gap-1 rounded-md px-[7px] text-[11px] leading-none font-medium whitespace-nowrap",
        TAG[tone],
        className
      )}
    >
      {icon && <Icon name={icon} className="size-3" />}
      {children}
    </span>
  );
}

/* ---------- 输入 ---------- */
const INPUT =
  "w-full rounded-10 bg-sheet px-3 text-sm text-ink shadow-[inset_0_0_0_1px_var(--color-line-strong)] transition-[background-color,box-shadow] duration-100 ease-swift placeholder:text-ink-4 hover:shadow-[inset_0_0_0_1px_rgb(27_28_38/0.26)] focus:outline-none focus:shadow-[inset_0_0_0_1.5px_var(--color-accent),0_0_0_3px_var(--color-accent-ring)] disabled:cursor-not-allowed disabled:opacity-50";
const INPUT_FILL =
  "bg-fill-1 shadow-none hover:bg-fill-2 hover:shadow-none focus:bg-sheet focus:shadow-[inset_0_0_0_1.5px_var(--color-accent)]";

/** 文本输入的类名。fill = 填充式(搜索框、侧栏筛选):无描边、浅灰底,聚焦时回到白底;sm = 36px 高的紧凑档。 */
export function inputClass({
  fill = false,
  size = "md",
  className,
}: { fill?: boolean; size?: "sm" | "md"; className?: string } = {}): string {
  return cx(INPUT, size === "sm" ? "h-9" : "h-10", fill && INPUT_FILL, className);
}

/** 原生 select(手机上弹系统选择器):去掉系统外观,统一右侧箭头。children 是 <option>。
 *  宽度由 className 显式给定(如 w-[160px]);内部 select 撑满该宽度,避免在行式布局里挤压标题。 */
export function Select({
  className,
  children,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement> & { children: ReactNode }) {
  return (
    <span className={cx("relative inline-flex shrink-0", className)}>
      <select className={cx(inputClass(), "cursor-pointer appearance-none pr-9")} {...rest}>
        {children}
      </select>
      <Icon
        name="down"
        className="pointer-events-none absolute top-1/2 right-3 size-3.5 -translate-y-1/2 text-ink-3"
      />
    </span>
  );
}

/* ---------- 对话框:桌面居中,移动端底部面板 ---------- */
export function Dialog({
  onClose,
  title,
  desc,
  children,
  footer,
  className,
  testId,
}: {
  onClose: () => void;
  title: string;
  desc?: ReactNode;
  children?: ReactNode;
  /** 真正的操作区(每层只放一个主操作);关闭按钮由 Dialog 自己给 */
  footer?: ReactNode;
  className?: string;
  testId?: string;
}) {
  const { t } = useT();
  // Android 返回键/侧滑返回:先关弹层
  useBackHandler(true, onClose);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div
      data-floating
      className="fixed inset-0 z-50 flex animate-fade-in items-end bg-[rgb(27_28_38/0.42)] backdrop-blur-[3px] md:items-center md:justify-center md:p-5"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-label={title}
        data-testid={testId}
        className={cx(
          "flex max-h-[88dvh] w-full flex-col overflow-y-auto rounded-t-[26px] bg-sheet px-5 pt-2 pb-[calc(env(safe-area-inset-bottom)+16px)] shadow-lg animate-sheet-up md:max-w-[400px] md:animate-rise-in md:rounded-20 md:p-6",
          className
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mx-auto mb-3.5 h-1 w-9 shrink-0 rounded-full bg-ink-5 md:hidden" />
        <div className="mb-4 flex shrink-0 items-start gap-3">
          <div className="min-w-0 flex-1">
            <h3 className="text-lg leading-snug font-semibold tracking-[-0.01em]">{title}</h3>
            {desc && <p className="mt-1 text-13 leading-normal text-ink-3">{desc}</p>}
          </div>
          {/* 关闭只在一种形态里出现:桌面右上角,触屏底部幽灵按钮——每个弹层恒有一个「关闭」 */}
          <IconButton
            label={t("common.close")}
            icon="close"
            onClick={onClose}
            className="-mr-1.5 -mt-1.5 hidden md:inline-flex"
          />
        </div>
        {children}
        <div className={cx("mt-4 flex shrink-0 gap-2", !footer && "md:hidden")}>
          {footer}
          <Button variant="ghost" onClick={onClose} className="flex-1 md:hidden">
            {t("common.close")}
          </Button>
        </div>
      </div>
    </div>,
    document.body
  );
}

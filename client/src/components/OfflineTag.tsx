// 「离线」标签(全端统一):连不上服务器时出现——侧栏是一条横条(bar),文档头与移动端顶栏是小胶囊(pill)。
// 点开是一张小说明卡:修改存在本机、联网后自动同步,附「检查服务器地址」入口。
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { useT } from "@/i18n";
import { useBackHandler } from "@/platform/backButton";
import { Icon } from "./icons";
import { cx } from "./ui";

export function OfflineTag({
  align = "left",
  className,
  variant = "pill",
}: {
  /** 说明卡相对标签的对齐边(标签靠右放时用 right,避免卡片出屏) */
  align?: "left" | "right";
  className?: string;
  /** pill = 胶囊小标签;bar = 铺满一行的横条(侧栏) */
  variant?: "pill" | "bar";
}) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  useBackHandler(open, () => setOpen(false));
  const rootRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const bar = variant === "bar";
  return (
    <span ref={rootRef} className={cx("relative inline-flex shrink-0", bar && "w-full", className)}>
      <button
        type="button"
        data-testid="offline-tag"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={t("offline.title")}
        className={cx(
          "inline-flex cursor-pointer items-center bg-danger-bg font-medium text-danger transition-[background-color,box-shadow] duration-100 ease-swift hover:bg-[#f7e1e3] focus-visible:outline-2 focus-visible:outline-accent-600",
          bar
            ? "h-8 w-full gap-2 rounded-10 px-2.5 text-xs shadow-[inset_0_0_0_1px_var(--color-danger-line)] hover:shadow-[inset_0_0_0_1px_var(--color-danger)]"
            : "gap-1.5 rounded-full pr-2 pl-[7px] text-xs leading-[22px] shadow-[inset_0_0_0_1px_var(--color-danger-line)] hover:shadow-[inset_0_0_0_1px_var(--color-danger)]",
          open && "shadow-[inset_0_0_0_1px_var(--color-danger)]"
        )}
      >
        {bar ? (
          <>
            <Icon name="alert" className="size-3.5 shrink-0" />
            <span className="truncate">{t("offline.bar")}</span>
          </>
        ) : (
          <>
            <span className="size-1.5 shrink-0 rounded-full bg-danger" />
            {t("offline.tag")}
          </>
        )}
      </button>
      {open && (
        <span
          role="dialog"
          className={cx(
            "absolute top-full z-50 mt-1.5 block w-[min(16rem,calc(100vw-2rem))] rounded-12 bg-sheet p-3.5 text-left animate-pop-in",
            align === "right" ? "right-0" : "left-0"
          )}
        >
          <span className="block text-sm font-semibold text-ink">{t("offline.title")}</span>
          <span className="mt-1 block text-xs leading-relaxed text-ink-2">{t("offline.desc")}</span>
          <Link
            to="/settings"
            className="mt-2 inline-flex items-center gap-0.5 text-xs font-medium text-accent-800 hover:underline"
          >
            {t("offline.checkServer")}
            <Icon name="right" className="size-3" />
          </Link>
        </span>
      )}
    </span>
  );
}

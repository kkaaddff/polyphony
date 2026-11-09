// 「离线」红色小标签(全端统一):连不上服务器时出现在列表标题旁 / 文档顶栏。
// 点开是一张小说明卡:修改存在本机、联网后自动同步,附「检查服务器地址」入口。
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { useT } from "@/i18n";
import { useBackHandler } from "@/platform/backButton";

export function OfflineTag({
  align = "left",
  className = "",
}: {
  /** 说明卡相对标签的对齐边(标签靠右放时用 right,避免卡片出屏) */
  align?: "left" | "right";
  className?: string;
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

  return (
    <span ref={rootRef} className={`relative inline-flex shrink-0 ${className}`}>
      <button
        type="button"
        data-testid="offline-tag"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={t("offline.title")}
        className="inline-flex items-center gap-1 rounded-full bg-red-50 px-2 py-0.5 text-xs font-medium leading-5 text-red-600 ring-1 ring-inset ring-red-200 dark:bg-red-500/10 dark:text-red-400 dark:ring-red-500/30"
      >
        <span className="size-1.5 rounded-full bg-red-500" />
        {t("offline.tag")}
      </button>
      {open && (
        <span
          role="dialog"
          className={`absolute top-full z-50 mt-2 w-64 rounded-xl bg-white p-3 text-left shadow-lg ring-1 ring-black/5 dark:bg-gray-800 ${
            align === "right" ? "right-0" : "left-0"
          }`}
        >
          <span className="block text-sm font-semibold text-gray-900 dark:text-gray-100">
            {t("offline.title")}
          </span>
          <span className="mt-1 block text-xs leading-relaxed text-gray-500 dark:text-gray-400">
            {t("offline.desc")}
          </span>
          <Link
            to="/settings"
            className="mt-2 inline-block text-xs font-medium text-blue-600 dark:text-blue-400"
          >
            {t("offline.checkServer")} →
          </Link>
        </span>
      )}
    </span>
  );
}

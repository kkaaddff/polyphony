// 回收站弹窗(docs/document-lifecycle.md §4.8):所有者视角,恢复/立即清除/导出。
import { useEffect, useState } from "react";
import { fetchTrash, restoreDoc, purgeDoc, exportDoc, type TrashEntry } from "@/lib/docs";
import { getServerBase } from "@/lib/serverConfig";
import { useT } from "@/i18n";
import { useBackHandler } from "@/platform/backButton";

interface TrashModalProps {
  onClose: () => void;
  onChanged: () => void; // 恢复/清除后刷新房间列表
}

export function TrashModal({ onClose, onChanged }: TrashModalProps) {
  // Android 返回键/侧滑返回:先关弹层
  useBackHandler(true, onClose);
  const { t } = useT();
  const [docs, setDocs] = useState<TrashEntry[]>([]);
  const [busy, setBusy] = useState("");

  const reload = () => {
    fetchTrash()
      .then(setDocs)
      .catch(() => setDocs([]));
  };

  useEffect(reload, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const daysLeft = (purgeAt: number) => Math.max(0, Math.ceil((purgeAt - Date.now()) / 86400000));

  const doRestore = async (code: string) => {
    setBusy(code);
    try {
      await restoreDoc(code);
      reload();
      onChanged();
    } catch {
      reload();
    } finally {
      setBusy("");
    }
  };

  const doPurge = async (code: string) => {
    if (!window.confirm(t("trash.purgeConfirm", { code }))) return;
    setBusy(code);
    try {
      await purgeDoc(code);
      reload();
      onChanged();
    } catch {
      reload();
    } finally {
      setBusy("");
    }
  };

  const doExport = async (code: string) => {
    setBusy(code);
    try {
      const url = await exportDoc(code);
      window.location.assign(`${getServerBase()}${url}`);
    } catch {
      /* 忽略 */
    } finally {
      setBusy("");
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl shadow-2xl p-6 max-w-md w-full max-h-[85vh] overflow-y-auto space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="font-semibold text-gray-900">{t("trash.title")}</h3>
        {docs.length === 0 ? (
          <p className="text-sm text-gray-500 py-6 text-center">{t("trash.empty")}</p>
        ) : (
          <ul className="space-y-2">
            {docs.map((d) => (
              <li key={d.code} className="rounded-lg border border-gray-200 px-3 py-2 space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm text-gray-900 font-medium truncate">
                    {d.name || t("common.unnamedDoc")}
                  </span>
                </div>
                <p className="text-xs text-gray-500">
                  {d.trashReason === "inactive"
                    ? t("trash.reasonInactive")
                    : d.trashReason === "account_deleted"
                      ? t("trash.reasonAccount")
                      : t("trash.reasonOwner")}{" "}
                  · {t("trash.daysLeft", { n: daysLeft(d.purgeAt) })}
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={() => void doRestore(d.code)}
                    disabled={busy === d.code}
                    className="px-3 py-1 rounded-lg bg-blue-600 text-white text-xs font-medium hover:bg-blue-700 disabled:opacity-50"
                  >
                    {t("trash.restoreBtn")}
                  </button>
                  <button
                    onClick={() => void doExport(d.code)}
                    disabled={busy === d.code}
                    className="px-3 py-1 rounded-lg border border-gray-300 text-gray-600 text-xs font-medium hover:bg-gray-50 disabled:opacity-50"
                  >
                    {t("editor.exportBtn")}
                  </button>
                  <button
                    onClick={() => void doPurge(d.code)}
                    disabled={busy === d.code}
                    className="px-3 py-1 rounded-lg border border-red-200 text-red-600 text-xs font-medium hover:bg-red-50 disabled:opacity-50"
                  >
                    {t("trash.purgeBtn")}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-gray-400">{t("trash.note")}</p>
        <button
          onClick={onClose}
          className="w-full py-2 rounded-lg bg-gray-900 text-white text-sm font-medium hover:bg-gray-700 transition-colors"
        >
          {t("common.close")}
        </button>
      </div>
    </div>
  );
}

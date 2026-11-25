// 回收站弹窗(docs/document-lifecycle.md §4.8):所有者视角,恢复/立即清除/导出。
import { useEffect, useState } from "react";
import { fetchTrash, restoreDoc, purgeDoc, exportDoc, type TrashEntry } from "@/lib/docs";
import { getServerBase } from "@/lib/serverConfig";
import { useT } from "@/i18n";
import { docTitle } from "@/lib/docTitle";
import { Dialog, IconButton } from "./ui";
import { Icon } from "./icons";

interface TrashModalProps {
  onClose: () => void;
  onChanged: () => void; // 恢复/清除后刷新房间列表
}

export function TrashModal({ onClose, onChanged }: TrashModalProps) {
  const { t } = useT();
  const [docs, setDocs] = useState<TrashEntry[]>([]);
  const [busy, setBusy] = useState("");

  const reload = () => {
    fetchTrash()
      .then(setDocs)
      .catch(() => setDocs([]));
  };

  useEffect(reload, []);

  const daysLeft = (purgeAt: number) => Math.max(0, Math.ceil((purgeAt - Date.now()) / 86400000));

  // 恢复/清除:成功后刷新弹窗与首页列表,失败也重读(以服务端为准)
  const run = async (code: string, action: () => Promise<void>) => {
    setBusy(code);
    try {
      await action();
      onChanged();
    } catch {
      /* 以重读结果为准 */
    } finally {
      reload();
      setBusy("");
    }
  };

  const doPurge = async (code: string) => {
    if (!window.confirm(t("trash.purgeConfirm", { code }))) return;
    await run(code, () => purgeDoc(code));
  };

  const doExport = async (code: string) => {
    try {
      const url = await exportDoc(code);
      window.location.assign(`${getServerBase()}${url}`);
    } catch {
      /* 忽略 */
    }
  };

  return (
    <Dialog onClose={onClose} title={t("trash.title")} desc={t("trash.note")} className="md:max-w-[460px]">
      {docs.length === 0 ? (
        <p className="py-6 text-center text-sm text-ink-3">{t("trash.empty")}</p>
      ) : (
        <ul>
          {docs.map((d) => (
            <li
              key={d.code}
              className="flex items-center gap-3 border-t border-line py-2.5 first:border-t-0"
            >
              <span className="inline-flex size-[34px] shrink-0 items-center justify-center rounded-10 bg-fill-1 text-ink-2">
                <Icon name="file" className="size-4" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-ink">
                  {docTitle(d, t("common.unnamedDoc"))}
                </p>
                <p className="mt-0.5 text-xs text-ink-3">
                  <span className="font-medium text-warn">
                    {t("trash.daysLeft", { n: daysLeft(d.purgeAt) })}
                  </span>
                  {" · "}
                  {d.trashReason === "inactive"
                    ? t("trash.reasonInactive")
                    : d.trashReason === "account_deleted"
                      ? t("trash.reasonAccount")
                      : t("trash.reasonOwner")}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-0.5">
                <IconButton
                  icon="restore"
                  label={t("trash.restoreBtn")}
                  disabled={busy === d.code}
                  onClick={() => void run(d.code, () => restoreDoc(d.code))}
                  className="text-accent-700 hover:bg-accent-50 hover:text-accent-800"
                />
                <IconButton
                  icon="download"
                  label={t("editor.exportBtn")}
                  disabled={busy === d.code}
                  onClick={() => void doExport(d.code)}
                />
                <IconButton
                  icon="trash"
                  label={t("trash.purgeBtn")}
                  disabled={busy === d.code}
                  onClick={() => void doPurge(d.code)}
                  className="hover:bg-danger-bg hover:text-danger"
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}

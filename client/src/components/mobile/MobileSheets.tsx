// 移动端浮层:左侧分类抽屉(参考小米笔记的文件夹抽屉)与「输入文档码加入」底部面板。
import { useState } from "react";
import { Avatar } from "@/components/Avatar";
import { Icon, type IconName } from "@/components/icons";
import { useT } from "@/i18n";
import { useBackHandler } from "@/platform/backButton";
import { cx, inputClass } from "@/components/ui";

export type DocFilter = "all" | "mine" | "shared";

interface DrawerProps {
  filter: DocFilter;
  counts: Record<DocFilter, number>;
  accountName: string;
  accountId?: string;
  pairNeedsConfirm: boolean;
  onFilter: (f: DocFilter) => void;
  onTrash: () => void;
  onPair: () => void;
  onSettings: () => void;
  onJoin: () => void;
  /** 语音输入(Android App 原生页)或语音便签页 */
  onVoice: () => void;
  voiceLabel: string;
  onShareSite: () => void;
  onLogout: () => void;
  onClose: () => void;
}

function DrawerRow({
  icon,
  label,
  count,
  active = false,
  dot = false,
  danger = false,
  onClick,
}: {
  icon: IconName;
  label: string;
  count?: number;
  active?: boolean;
  dot?: boolean;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx(
        "flex w-full min-h-tap-44 items-center gap-3 rounded-2xl px-4 text-15 transition-colors",
        danger ? "text-danger" : "text-ink",
        active ? "bg-fill-2" : "active:bg-fill-1"
      )}
    >
      <Icon name={icon} className={cx("size-[18px] shrink-0", danger ? "text-danger" : "text-ink-2")} />
      <span className="flex-1 truncate text-left">{label}</span>
      {dot && <span className="size-2 rounded-full bg-danger" />}
      {count !== undefined && <span className="text-sm text-ink-4">{count}</span>}
    </button>
  );
}

export function CategoryDrawer({
  filter,
  counts,
  accountName,
  accountId,
  pairNeedsConfirm,
  onFilter,
  onTrash,
  onPair,
  onSettings,
  onJoin,
  onVoice,
  voiceLabel,
  onShareSite,
  onLogout,
  onClose,
}: DrawerProps) {
  const { t } = useT();
  useBackHandler(true, onClose);
  const pick = (f: DocFilter) => {
    onFilter(f);
    onClose();
  };
  // 先关抽屉再开下一层,避免两层浮层叠在一起
  const then = (fn: () => void) => () => {
    onClose();
    fn();
  };

  // 头像抽屉 = 移动端唯一的账号/功能入口(原右上「更多」菜单已并入)
  return (
    <div className="fixed inset-0 z-50 animate-fade-in bg-[rgb(27_28_38/0.42)]" onClick={onClose}>
      <aside
        role="dialog"
        aria-label={t("mobile.categories")}
        className="absolute top-[calc(env(safe-area-inset-top)+8px)] bottom-[calc(env(safe-area-inset-bottom)+8px)] left-2 flex w-[80%] max-w-xs animate-drawer-in flex-col rounded-3xl bg-sheet"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center gap-3 px-4 pt-4 pb-2">
          <Avatar name={accountName} id={accountId} className="size-11 text-base" />
          <span className="min-w-0 flex-1 truncate text-base font-semibold text-ink">{accountName}</span>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("common.close")}
            className="-mr-2 grid size-tap-44 shrink-0 cursor-pointer place-items-center rounded-full text-ink-2 active:bg-fill-2"
          >
            <Icon name="close" className="size-5" />
          </button>
        </div>

        <nav className="flex-1 space-y-0.5 overflow-y-auto px-2 py-2">
          <DrawerRow icon="file" label={t("mobile.drawerAll")} count={counts.all} active={filter === "all"} onClick={() => pick("all")} />
          <DrawerRow icon="user" label={t("mobile.tabMine")} count={counts.mine} active={filter === "mine"} onClick={() => pick("mine")} />
          <DrawerRow icon="users" label={t("mobile.tabShared")} count={counts.shared} active={filter === "shared"} onClick={() => pick("shared")} />
          <DrawerRow icon="trash" label={t("trash.entry")} onClick={then(onTrash)} />
          <div className="mx-4 my-2 h-px bg-line" />
          <DrawerRow icon="mic" label={voiceLabel} onClick={then(onVoice)} />
          <DrawerRow icon="link" label={t("mobile.joinByCode")} onClick={then(onJoin)} />
          <DrawerRow icon="laptop" label={t("pair.entry")} dot={pairNeedsConfirm} onClick={then(onPair)} />
          <DrawerRow icon="share" label={t("home.shareSite")} onClick={then(onShareSite)} />
          <DrawerRow icon="settings" label={t("home.settingsLink")} onClick={then(onSettings)} />
        </nav>

        <div className="shrink-0 border-t border-line px-2 py-2">
          <DrawerRow icon="logout" label={t("topbar.logout")} danger onClick={then(onLogout)} />
        </div>
      </aside>
    </div>
  );
}

export function JoinSheet({
  initialCode,
  onJoin,
  onScan,
  onClose,
}: {
  initialCode: string;
  onJoin: (code: string) => void;
  onScan: () => void;
  onClose: () => void;
}) {
  const { t } = useT();
  useBackHandler(true, onClose);
  const [code, setCode] = useState(initialCode);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const c = code.trim().toUpperCase();
    if (!c) {
      alert(t("home.alertNeedRoomCode"));
      return;
    }
    onJoin(c);
  };

  return (
    <div
      className="fixed inset-x-0 top-[var(--vv-top,0px)] z-50 flex h-[var(--vvh,100dvh)] animate-fade-in items-end bg-[rgb(27_28_38/0.42)]"
      onClick={onClose}
    >
      <form
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
        className="w-full animate-sheet-up space-y-4 rounded-t-3xl bg-sheet px-5 pt-3 pb-[calc(var(--kb-safe-bottom,env(safe-area-inset-bottom))+20px)]"
      >
        <div className="mx-auto h-1 w-10 rounded-full bg-ink-5" />
        <h2 className="text-lg font-semibold text-ink">{t("home.joinBtn")}</h2>
        <div className="relative">
          <input
            id="roomCode"
            autoFocus
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder={t("home.roomCodePlaceholder")}
            aria-label={t("home.roomCodePlaceholder")}
            maxLength={8}
            className={inputClass({ className: "h-12 rounded-2xl pr-12 font-mono text-base tracking-widest" })}
          />
          <button
            type="button"
            onClick={onScan}
            aria-label={t("home.scanBtn")}
            className="absolute top-1/2 right-1 grid size-tap-44 -translate-y-1/2 cursor-pointer place-items-center rounded-full text-ink-3 active:bg-fill-2"
          >
            <Icon name="scan" className="size-5" />
          </button>
        </div>
        <button
          type="submit"
          className="w-full min-h-tap-44 cursor-pointer rounded-2xl bg-accent text-15 font-semibold text-white transition-colors active:bg-accent-700"
        >
          {t("home.joinBtn")}
        </button>
      </form>
    </div>
  );
}

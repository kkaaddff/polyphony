// 移动端浮层:左侧分类抽屉(参考小米笔记的文件夹抽屉)与「输入文档码加入」底部面板。
import { useState } from "react";
import {
  CloseOutlined,
  DeleteOutlined,
  FileTextOutlined,
  LaptopOutlined,
  ScanOutlined,
  SettingOutlined,
  TeamOutlined,
  UserOutlined,
} from "@ant-design/icons";
import { Avatar } from "@/components/Avatar";
import { useT } from "@/i18n";
import { useBackHandler } from "@/platform/backButton";

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
  onClose: () => void;
}

function DrawerRow({
  icon,
  label,
  count,
  active = false,
  dot = false,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  count?: number;
  active?: boolean;
  dot?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full min-h-tap-44 flex items-center gap-3 px-4 rounded-2xl text-[15px] text-gray-900 transition-colors ${
        active ? "bg-gray-100" : "active:bg-gray-50"
      }`}
    >
      <span className="text-lg text-gray-700 flex">{icon}</span>
      <span className="flex-1 text-left truncate">{label}</span>
      {dot && <span className="size-2 rounded-full bg-red-500" />}
      {count !== undefined && <span className="text-sm text-gray-400">{count}</span>}
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

  return (
    <div className="fixed inset-0 z-50 bg-black/40 animate-fade-in" onClick={onClose}>
      <aside
        role="dialog"
        aria-label={t("mobile.categories")}
        className="absolute left-2 top-[calc(env(safe-area-inset-top)+8px)] bottom-[calc(env(safe-area-inset-bottom)+8px)] w-[78%] max-w-xs rounded-3xl bg-white flex flex-col animate-drawer-in"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-2 pt-2 shrink-0">
          <button
            type="button"
            onClick={onClose}
            aria-label={t("common.close")}
            className="size-tap-44 flex items-center justify-center rounded-full text-lg text-gray-800 active:bg-gray-100"
          >
            <CloseOutlined />
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto px-2 py-2 space-y-0.5">
          <DrawerRow
            icon={<FileTextOutlined />}
            label={t("mobile.drawerAll")}
            count={counts.all}
            active={filter === "all"}
            onClick={() => pick("all")}
          />
          <DrawerRow
            icon={<UserOutlined />}
            label={t("mobile.tabMine")}
            count={counts.mine}
            active={filter === "mine"}
            onClick={() => pick("mine")}
          />
          <DrawerRow
            icon={<TeamOutlined />}
            label={t("mobile.tabShared")}
            count={counts.shared}
            active={filter === "shared"}
            onClick={() => pick("shared")}
          />
          <DrawerRow icon={<DeleteOutlined />} label={t("trash.entry")} onClick={then(onTrash)} />
          <div className="mx-4 my-2 h-px bg-gray-100" />
          <DrawerRow
            icon={<LaptopOutlined />}
            label={t("pair.entry")}
            dot={pairNeedsConfirm}
            onClick={then(onPair)}
          />
          <DrawerRow icon={<SettingOutlined />} label={t("home.settingsLink")} onClick={then(onSettings)} />
        </nav>

        <div className="shrink-0 flex items-center gap-3 px-4 py-4 border-t border-gray-100">
          <Avatar name={accountName} id={accountId} />
          <span className="text-sm font-medium text-gray-800 truncate">{accountName}</span>
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
      className="fixed inset-x-0 top-[var(--vv-top,0px)] h-[var(--vvh,100dvh)] z-50 bg-black/40 flex items-end animate-fade-in"
      onClick={onClose}
    >
      <form
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
        className="w-full rounded-t-3xl bg-white px-5 pt-3 pb-[calc(var(--kb-safe-bottom,env(safe-area-inset-bottom))+20px)] space-y-4 animate-sheet-up"
      >
        <div className="mx-auto h-1 w-10 rounded-full bg-gray-200" />
        <h2 className="text-lg font-semibold text-gray-900">{t("home.joinBtn")}</h2>
        <div className="relative">
          <input
            id="roomCode"
            autoFocus
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder={t("home.roomCodePlaceholder")}
            aria-label={t("home.roomCodePlaceholder")}
            maxLength={8}
            className="w-full h-12 rounded-2xl bg-gray-100 pl-4 pr-12 font-mono text-base tracking-widest focus:outline-none focus:ring-2 focus:ring-accent"
          />
          <button
            type="button"
            onClick={onScan}
            aria-label={t("home.scanBtn")}
            className="absolute right-1 top-1/2 -translate-y-1/2 size-tap-44 flex items-center justify-center rounded-full text-lg text-gray-500 active:bg-gray-200"
          >
            <ScanOutlined />
          </button>
        </div>
        <button
          type="submit"
          className="w-full min-h-tap-44 rounded-2xl bg-gray-900 text-white text-[15px] font-semibold active:bg-gray-800"
        >
          {t("home.joinBtn")}
        </button>
      </form>
    </div>
  );
}

// 顶栏:房间名(就地重命名)+ 房间码(点击复制,toast 反馈)+ 连接状态 + 「👥 n」菜单
// (发送邀请 / 退出房间;移动端首项「在线用户」开底部面板)。v3.5.0 起独立按钮全部收敛进菜单。
// 响应式:flex-wrap 两行式——移动端不再挤压;曾因元素重叠导致「退出房间」点不动。
import { useState } from "react";
import { QrModal } from "@/components/QrModal";
import { Menu, MenuItem } from "@/components/Menu";
import { ChevronDownIcon } from "@/components/icons";
import { useToast } from "@/components/Toast";
import { getServerBase } from "@/lib/serverConfig";
import { buildJoinUrl } from "@/lib/qr";
import { useT } from "@/i18n";

interface RoomHeaderProps {
  roomCode: string;
  roomName: string;
  isConnected: boolean;
  userCount: number;
  onRename: (name: string) => void;
  onLeave: () => void;
}

export function RoomHeader({
  roomCode,
  roomName,
  isConnected,
  userCount,
  onRename,
  onLeave,
}: RoomHeaderProps) {
  const { t } = useT();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [showQr, setShowQr] = useState(false);

  const startRename = () => {
    setDraft(roomName);
    setEditing(true);
  };
  const commitRename = () => {
    const next = draft.trim();
    if (next) onRename(next);
    setEditing(false);
  };

  const copyRoomCode = async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(roomCode);
      } else {
        // 非安全上下文（http://IP 直连）无 Async Clipboard：execCommand 降级
        const ta = document.createElement("textarea");
        ta.value = roomCode;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        ta.remove();
      }
      toast.show(t("roomHeader.copyOk"), "success");
    } catch {
      toast.show(t("roomHeader.copyFail", { code: roomCode }), "error");
    }
  };

  return (
    <div className="bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 px-4 md:px-6 py-3 flex flex-wrap items-center gap-x-4 gap-y-2">
      {/* 左组:品牌 + 房间名/码(可收缩,长名 truncate) */}
      <div className="flex items-center gap-3 min-w-0 flex-1">
        {/* 品牌:桌面显示;移动端隐藏(顶栏空间留给房间名/码,品牌在 welcome 页呈现) */}
        <h1 className="hidden md:block text-lg md:text-xl font-bold text-gray-900 dark:text-white shrink-0">
          {t("common.appName")}
        </h1>
        <span className="text-sm text-gray-600 dark:text-gray-400 shrink-0 hidden sm:inline">
          {t("roomHeader.room")}
        </span>
        <div className="flex items-center gap-2 min-w-0">
          {editing ? (
            <input
              autoFocus
              type="text"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitRename();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  setEditing(false);
                }
              }}
              onBlur={commitRename}
              maxLength={40}
              placeholder={t("roomHeader.roomNamePlaceholder")}
              className="px-2 py-1.5 rounded text-sm border border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-400 text-gray-900 dark:text-white bg-white dark:bg-gray-700 w-full max-w-[12rem]"
            />
          ) : (
            <button
              onClick={startRename}
              title={t("roomHeader.renameTitle")}
              className="text-sm font-semibold text-gray-900 dark:text-white hover:text-blue-600 dark:hover:text-blue-400 hover:underline truncate max-w-[10rem] md:max-w-[12rem] py-1.5"
            >
              {roomName || t("common.unnamedDoc")}
            </button>
          )}
          {/* 房间码即复制按钮:点一下 → toast「房间号已复制」(不再设独立复制按钮) */}
          <button
            onClick={copyRoomCode}
            title={t("roomHeader.copyCodeTitle")}
            className="bg-gray-100 dark:bg-gray-700 px-2 rounded text-xs md:text-sm font-mono text-gray-900 dark:text-white shrink-0 hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors min-h-tap-38 flex items-center"
          >
            {roomCode}
          </button>
        </div>
      </div>

      {/* 右组:连接状态 + 人数菜单(不收缩,独立成行也不重叠) */}
      <div className="flex items-center gap-1.5 md:gap-2 shrink-0">
        <div className="flex items-center gap-1.5 px-1">
          <div
            className={`w-2 h-2 rounded-full ${
              isConnected ? "bg-green-500" : "bg-red-500"
            }`}
          />
          <span className="text-xs md:text-sm text-gray-600 dark:text-gray-400 whitespace-nowrap">
            {isConnected
              ? t("roomHeader.connected")
              : t("roomHeader.disconnected")}
          </span>
        </div>
        <Menu
          buttonTitle={t("roomHeader.countBtnTitle")}
          buttonClassName="text-xs bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200 px-3 py-2 rounded hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors min-h-tap-40 flex items-center gap-1"
          buttonContent={
            <>
              👥 {userCount} <ChevronDownIcon className="size-3.5" />
            </>
          }
        >
          {/* 移动端:在线用户列表收进底部面板;桌面常驻侧栏无需此项 */}
          <MenuItem
            className="md:hidden"
            onClick={() =>
              window.dispatchEvent(new CustomEvent("polyphony:open-users"))
            }
          >
            {t("usersPanel.online", { n: userCount })}
          </MenuItem>
          <MenuItem onClick={() => setShowQr(true)}>
            {t("roomHeader.invite")}
          </MenuItem>
          <MenuItem onClick={onLeave} className="text-red-600">
            {t("roomHeader.leave")}
          </MenuItem>
        </Menu>
      </div>

      {showQr && (
        <QrModal
          url={buildJoinUrl(getServerBase(), roomCode)}
          title={t("qrModal.title")}
          desc={t("qrModal.desc", { code: roomCode })}
          onClose={() => setShowQr(false)}
        />
      )}
    </div>
  );
}

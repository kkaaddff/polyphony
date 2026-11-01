// 顶栏:房间名(就地重命名)+ 房间码复制 + 二维码 + 在线用户 + 连接状态 + 退出。
// 响应式:flex-wrap 两行式——移动端不再挤压;曾因元素重叠导致「退出房间」点不动。
import { useState } from "react";
import { QrModal } from "@/components/QrModal";
import { getServerBase } from "@/lib/serverConfig";
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
      alert(t("roomHeader.copyOk"));
    } catch {
      alert(t("roomHeader.copyFail", { code: roomCode }));
    }
  };

  return (
    <div className="bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 px-4 md:px-6 py-3 flex flex-wrap items-center gap-x-4 gap-y-2">
      {/* 左组:品牌 + 房间名/码/复制(可收缩,长名 truncate) */}
      <div className="flex items-center gap-3 min-w-0 flex-1">
        <h1 className="text-lg md:text-xl font-bold text-gray-900 dark:text-white shrink-0">
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
          <code className="bg-gray-100 dark:bg-gray-700 px-2 py-1 rounded text-xs md:text-sm font-mono text-gray-900 dark:text-white shrink-0">
            {roomCode}
          </code>
        </div>
      </div>

      {/* 右组:操作(不收缩,独立成行也不重叠) */}
      <div className="flex items-center gap-1.5 md:gap-2 shrink-0">
        <button
          onClick={copyRoomCode}
          title={t("roomHeader.copy")}
          className="text-xs bg-blue-500 text-white px-3 py-2 rounded hover:bg-blue-600 transition-colors min-h-tap-40"
        >
          {t("roomHeader.copy")}
        </button>
        <button
          onClick={() => setShowQr(true)}
          title={t("roomHeader.qrBtnTitle")}
          className="text-xs bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200 px-3 py-2 rounded hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors min-h-tap-40"
        >
          {t("roomHeader.qrBtn")}
        </button>
        {/* 在线用户(移动端点开抽屉;桌面纯指示) */}
        <button
          onClick={() =>
            window.dispatchEvent(new CustomEvent("polyphony:open-users"))
          }
          title={t("usersPanel.online", { n: userCount })}
          className="md:hidden text-xs bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200 px-3 py-2 rounded hover:bg-gray-200 transition-colors min-h-tap-40 flex items-center gap-1"
        >
          👥 {userCount}
        </button>
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
        <button
          onClick={onLeave}
          className="text-xs md:text-sm px-3 md:px-4 py-2 bg-gray-600 text-white rounded-lg hover:bg-gray-700 transition-colors min-h-tap-40 whitespace-nowrap"
        >
          {t("roomHeader.leave")}
        </button>
      </div>

      {showQr && (
        <QrModal
          code={roomCode}
          server={getServerBase()}
          onClose={() => setShowQr(false)}
        />
      )}
    </div>
  );
}

// 顶栏:品牌(点击回首页)+ 房间名(就地重命名)+ 分享按钮(复制邀请链接)+ 连接状态 +
// 自定义操作区(字数/导出/删除由 Editor 注入) + 「👥 n」菜单(发送邀请 / 退出房间)。
// 文档码不在界面上展示(联调反馈):分享即入口,码只存在于链接里。
// 响应式:flex-wrap 两行式——移动端不再挤压;曾因元素重叠导致「退出房间」点不动。
import { useState } from "react";
import { useNavigate } from "react-router";
import { QrModal } from "@/components/QrModal";
import { Menu, MenuItem } from "@/components/Menu";
import { ChevronDownIcon } from "@/components/icons";
import { ShareAltOutlined } from "@ant-design/icons";
import { useToast } from "@/components/Toast";
import { copyText } from "@/lib/clipboard";
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
  /** 顶栏右侧自定义操作(字数/导出/删除),渲染在连接状态左边 */
  actions?: React.ReactNode;
}

export function RoomHeader({
  roomCode,
  roomName,
  isConnected,
  userCount,
  onRename,
  onLeave,
  actions,
}: RoomHeaderProps) {
  const { t } = useT();
  const toast = useToast();
  const navigate = useNavigate();
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

  // 点击文档码 → 复制**邀请链接**(对方点开/扫码直接进本文档,而非裸码)
  const copyInviteLink = async () => {
    const url = buildJoinUrl(getServerBase(), roomCode);
    if (await copyText(url)) {
      toast.show(t("roomHeader.copyLinkOk"), "success");
    } else {
      toast.show(t("roomHeader.copyFail"), "error");
    }
  };

  return (
    <div className="bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 px-4 md:px-6 py-3 flex flex-wrap items-center gap-x-4 gap-y-2">
      {/* 左组:品牌 + 房间名/码(可收缩,长名 truncate) */}
      <div className="flex items-center gap-3 min-w-0 flex-1">
        {/* 品牌:点击回首页;桌面显示,移动端隐藏(顶栏空间留给房间名/码) */}
        <button
          onClick={() => navigate("/")}
          title={t("roomHeader.brandHomeTitle")}
          className="hidden md:block text-lg md:text-xl font-bold text-gray-900 dark:text-white shrink-0 hover:text-blue-600 dark:hover:text-blue-400 cursor-pointer transition-colors"
        >
          {t("common.appName")}
        </button>
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
          {/* 分享:复制邀请链接(不再展示文档码;反馈 toast 在顶部) */}
          <button
            onClick={() => void copyInviteLink()}
            title={t("roomHeader.shareTitle")}
            className="bg-gray-100 dark:bg-gray-700 px-2.5 py-1 rounded text-xs md:text-sm text-gray-700 dark:text-gray-200 shrink-0 hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors min-h-tap-38 flex items-center gap-1"
          >
            <ShareAltOutlined />
            <span>{t("roomHeader.shareBtn")}</span>
          </button>
        </div>
      </div>

      {/* 右组:自定义操作(字数/导出/删除) + 连接状态 + 人数菜单(不收缩) */}
      <div className="flex items-center gap-1.5 md:gap-2 shrink-0">
        {actions}
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
          {/* 在线用户列表:移动端编辑器为底部抽屉、首页文档面板为弹层 */}
          <MenuItem
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

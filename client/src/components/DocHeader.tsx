// 文档头(v5,首页面板与完整编辑器共用):标题就地重命名 + 字数 + 连接状态 + 分享 +
// 「更多操作」菜单 + 在场头像(点开是在线列表)。文档码不上界面——分享即入口,码只在链接里。
import { useState } from "react";
import { useT } from "@/i18n";
import { useIsOffline } from "@/lib/connectivity";
import { copyText } from "@/lib/clipboard";
import { getServerBase } from "@/lib/serverConfig";
import { buildJoinUrl } from "@/lib/qr";
import type { User } from "@/types";
import { AvatarStack } from "./Avatar";
import { Icon } from "./icons";
import { Menu, MenuItem, MenuSeparator, Popover } from "./Menu";
import { OfflineTag } from "./OfflineTag";
import { QrModal } from "./QrModal";
import { useToast } from "./Toast";
import { UsersPanel } from "./UsersPanel";
import { Button, cx, inputClass } from "./ui";

interface DocHeaderProps {
  roomCode: string;
  roomName: string;
  isConnected: boolean;
  users: User[];
  charCount: number;
  onRename: (name: string) => void;
  /** pane = 首页右栏(关闭=回列表,另有「完整编辑器」);editor = 独立编辑页(关闭=回首页) */
  variant: "pane" | "editor";
  isOwner: boolean;
  busy?: boolean;
  onExport: () => void;
  onDelete: () => void;
  onLeave: () => void;
  onOpenFull?: () => void;
}

export function DocHeader({
  roomCode,
  roomName,
  isConnected,
  users,
  charCount,
  onRename,
  variant,
  isOwner,
  busy = false,
  onExport,
  onDelete,
  onLeave,
  onOpenFull,
}: DocHeaderProps) {
  const { t } = useT();
  const toast = useToast();
  const offline = useIsOffline(isConnected);
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

  // 分享 = 复制邀请链接(对方点开/扫码直接进本文档);二维码走「发送邀请」
  const copyInviteLink = async () => {
    const url = buildJoinUrl(getServerBase(), roomCode);
    if (await copyText(url)) toast.show(t("roomHeader.copyLinkOk"), "success");
    else toast.show(t("roomHeader.copyFail"), "error");
  };

  const iconBtn =
    "grid size-9 shrink-0 cursor-pointer place-items-center rounded-10 text-ink-2 transition-colors duration-100 ease-swift hover:bg-fill-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-accent-600";

  return (
    <div className="flex h-14 shrink-0 items-center gap-1.5 px-4 md:px-5">
      {/* 标题:就地重命名(Enter 提交 / Escape 放弃 / 失焦提交) */}
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
          aria-label={t("roomHeader.roomNamePlaceholder")}
          className={inputClass({ size: "sm", className: "w-full max-w-[220px] font-semibold" })}
        />
      ) : (
        <button
          type="button"
          onClick={startRename}
          title={t("roomHeader.renameTitle")}
          className="group flex h-8 min-w-0 max-w-[320px] cursor-pointer items-center gap-1.5 rounded-lg px-2 text-base font-semibold tracking-[-0.005em] text-ink transition-colors duration-100 ease-swift hover:bg-fill-1 focus-visible:outline-2 focus-visible:outline-accent-600"
        >
          <span className="truncate">{roomName || t("common.unnamedDoc")}</span>
          <Icon name="pen" className="size-3.5 shrink-0 text-ink-4 opacity-0 transition-opacity group-hover:opacity-100" />
        </button>
      )}

      <div className="min-w-2 flex-1" />

      {/* 字数 */}
      <span className="hidden shrink-0 px-2 text-13 text-ink-3 tabular-nums sm:inline">
        {t("editor.charCount", { n: charCount })}
      </span>

      {/* 连接状态:已连接(绿点)/ 握手中 / 离线标签 */}
      {offline ? (
        <OfflineTag align="right" />
      ) : (
        <span className="flex shrink-0 items-center gap-1.5 px-2 text-13 text-ink-3">
          <span className={cx("size-[7px] rounded-full", isConnected ? "bg-ok shadow-[0_0_0_3px_rgb(23_138_91/0.16)]" : "bg-ink-5")} />
          <span className="whitespace-nowrap">{isConnected ? t("roomHeader.connected") : t("roomHeader.connecting")}</span>
        </span>
      )}

      <Button variant="secondary" size="sm" icon="share" onClick={() => void copyInviteLink()} className="shrink-0">
        {t("roomHeader.shareBtn")}
      </Button>

      {/* 更多操作 */}
      <Menu
        buttonTitle={t("roomHeader.moreTitle")}
        buttonClassName={iconBtn}
        buttonContent={<Icon name="more" className="size-[18px]" />}
      >
        <MenuItem icon="download" disabled={busy} onClick={onExport}>
          <span className="flex-1">{t("editor.exportBtn")}</span>
          <span className="text-xs text-ink-4">.zip</span>
        </MenuItem>
        <MenuItem icon="link" onClick={() => void copyInviteLink()}>{t("roomHeader.copyInvite")}</MenuItem>
        <MenuItem icon="qr" onClick={() => setShowQr(true)}>{t("roomHeader.invite")}</MenuItem>
        {variant === "pane" && onOpenFull && (
          <MenuItem icon="file" onClick={onOpenFull}>{t("docPane.openFull")}</MenuItem>
        )}
        <MenuSeparator />
        <MenuItem icon="left" onClick={onLeave}>
          {variant === "pane" ? t("roomHeader.backToList") : t("roomHeader.leave")}
        </MenuItem>
        {isOwner && (
          <MenuItem icon="trash" danger disabled={busy} onClick={onDelete}>{t("editor.deleteBtn")}</MenuItem>
        )}
      </Menu>

      {/* 在场:头像堆叠,点开是在线列表 */}
      <Popover
        buttonTitle={t("roomHeader.presenceTitle")}
        buttonClassName="flex h-9 shrink-0 cursor-pointer items-center gap-1.5 rounded-10 px-2 text-ink-2 transition-colors duration-100 ease-swift hover:bg-fill-2 focus-visible:outline-2 focus-visible:outline-accent-600"
        buttonContent={
          <>
            <AvatarStack users={users} />
            <Icon name="down" className="size-3 text-ink-4" />
          </>
        }
      >
        <UsersPanel users={users} />
      </Popover>

      {showQr && (
        <QrModal
          url={buildJoinUrl(getServerBase(), roomCode)}
          title={t("qrModal.title")}
          desc={t("qrModal.desc")}
          onClose={() => setShowQr(false)}
        />
      )}
    </div>
  );
}

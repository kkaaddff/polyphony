// 桌面全高侧栏(v5):品牌 + 新建/加入 + 搜索 + 分区导航 + 文档列表 + 回收站/账号。
// 它是「目录」,主区只剩一张稿纸。文档行整行可点(覆盖层按钮),悬停才露出行内操作。
import { useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { useShell } from "./shellContext";
import { useT } from "@/i18n";
import { docTitle } from "@/lib/docTitle";
import { formatRelative } from "@/lib/roomCode";
import { clientLabel } from "@/platform";
import { Avatar } from "./Avatar";
import { Icon, LogoMark, type IconName } from "./icons";
import { Menu, MenuItem, MenuSeparator, Popover } from "./Menu";
import { OfflineTag } from "./OfflineTag";
import { Button, Tag, cx, inputClass } from "./ui";
import type { MyRoom } from "@/types";

export function Sidebar() {
  const store = useShell();
  const { t, locale } = useT();
  const navigate = useNavigate();
  const location = useLocation();
  const [query, setQuery] = useState("");

  const {
    account, serverOk, activeRooms, activeCode, openDoc, createNew,
    joinCode, setJoinCode, joinOpen, setJoinOpen, submitJoin,
    setScanOpen, showQr, deleteSingle, leaveSingle,
    setTrashOpen, setPairOpen, pairNeedsConfirm, setShareSite, logout,
  } = store;

  const unnamed = t("common.unnamedDoc");
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return activeRooms;
    return activeRooms.filter((r) => docTitle(r, unnamed).toLowerCase().includes(q));
  }, [activeRooms, query, unnamed]);

  const onDocs = location.pathname === "/";
  const onNotes = location.pathname === "/notes";

  return (
    <aside className="flex min-h-0 flex-col border-r border-line bg-paper-deep">
      {/* 品牌:词标用 Newsreader 衬线(拉丁),是页面第一个 h1 */}
      <div className="flex h-14 shrink-0 items-center gap-2.5 px-4">
        <LogoMark className="size-[26px] shrink-0 rounded-[7px] shadow-[0_4px_10px_rgb(30_27_75/0.28)]" />
        <h1 className="font-display text-[21px] leading-none font-medium tracking-[-0.02em] text-ink">
          {t("common.appName")}
        </h1>
      </div>

      {/* 新建 + 加入 */}
      <div className="flex shrink-0 flex-col gap-2 px-3 pb-2.5">
        <div className="flex gap-1.5">
          <Button variant="primary" icon="plus" onClick={() => void createNew()} className="flex-1 justify-start pl-3">
            {t("home.createBtn")}
          </Button>
          <Popover
            buttonTitle={t("home.joinBtn")}
            align="left"
            open={joinOpen}
            onOpenChange={setJoinOpen}
            buttonClassName="grid size-9 shrink-0 cursor-pointer place-items-center rounded-10 bg-sheet text-ink-2 shadow-[inset_0_0_0_1px_var(--color-line-strong)] transition-colors duration-100 ease-swift hover:bg-sheet-tint hover:text-ink focus-visible:outline-2 focus-visible:outline-accent-600"
            buttonContent={<Icon name="link" className="size-[18px]" />}
            className="w-[292px]"
          >
            <div className="p-1">
              <p className="px-1 pt-0.5 text-15 font-semibold text-ink">{t("home.joinBtn")}</p>
              <p className="mt-0.5 mb-2.5 px-1 text-xs leading-normal text-ink-3">{t("home.joinHint")}</p>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  submitJoin();
                }}
              >
                <div className="relative">
                  <input
                    id="roomCode"
                    type="text"
                    value={joinCode}
                    onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
                    maxLength={8}
                    placeholder={t("home.roomCodePlaceholder")}
                    aria-label={t("home.roomCodePlaceholder")}
                    spellCheck={false}
                    autoComplete="off"
                    className={inputClass({ className: "pr-11 font-mono text-base tracking-[0.2em] uppercase" })}
                  />
                  <button
                    type="button"
                    onClick={() => setScanOpen(true)}
                    title={t("home.scanBtnTitle")}
                    aria-label={t("home.scanBtn")}
                    className="absolute top-1/2 right-1 grid size-8 -translate-y-1/2 cursor-pointer place-items-center rounded-lg text-ink-3 transition-colors hover:bg-fill-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-accent-600"
                  >
                    <Icon name="scan" className="size-4" />
                  </button>
                </div>
                <Button type="submit" variant="primary" className="mt-2.5 w-full">
                  {t("home.joinBtn")}
                </Button>
              </form>
            </div>
          </Popover>
        </div>
        <div className="relative">
          <Icon name="search" className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-3" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("home.searchPlaceholder")}
            aria-label={t("home.searchPlaceholder")}
            className={inputClass({ fill: true, size: "sm", className: "pl-9" })}
          />
        </div>
      </div>

      {/* 分区导航 */}
      <nav className="flex shrink-0 flex-col gap-px px-3 pb-1.5">
        <NavItem icon="file" label={t("home.navDocs")} active={onDocs} badge={activeRooms.length} onClick={() => navigate("/")} />
        <NavItem icon="wave" label={t("notes.entry")} active={onNotes} onClick={() => navigate("/notes")} />
      </nav>

      {/* 列表标题 */}
      <div className="flex shrink-0 items-center justify-between px-6 pt-2.5 pb-1.5">
        <span className="text-xs font-semibold text-ink-3">{t("home.myRooms")}</span>
      </div>

      {/* 离线横条:不弹不打断 */}
      {serverOk === false && (
        <div className="shrink-0 px-3 pb-2">
          <OfflineTag variant="bar" />
        </div>
      )}

      {/* 文档列表(内部滚动,一屏无外滚) */}
      <div className="thin-scroll min-h-0 flex-1 overflow-y-auto px-3 pb-2">
        {filtered.length === 0 ? (
          <p className="px-2 py-10 text-center text-13 leading-relaxed text-ink-3">
            {query.trim() ? t("home.listEmptySearch") : t("home.recentEmpty")}
          </p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {filtered.map((room) => (
              <DocRow
                key={room.code}
                room={room}
                active={activeCode === room.code}
                locale={locale}
                onOpen={() => openDoc(room.code)}
                onQr={() => showQr(room.code)}
                onDelete={() => void deleteSingle(room.code)}
                onLeave={() => leaveSingle(room.code)}
              />
            ))}
          </ul>
        )}
      </div>

      {/* 底部:回收站 + 账号 */}
      <div className="flex shrink-0 flex-col gap-0.5 border-t border-line px-3 pt-2 pb-3">
        <NavItem icon="trash" label={t("trash.entry")} onClick={() => setTrashOpen(true)} />
        <Menu
          buttonTitle={t("home.accountMenuTitle")}
          align="left"
          up
          buttonClassName="mt-1 flex w-full cursor-pointer items-center gap-2.5 rounded-xl px-1.5 py-1.5 text-left transition-colors duration-100 ease-swift hover:bg-white/70 focus-visible:outline-2 focus-visible:outline-accent-600"
          buttonContent={
            <>
              <span className="relative shrink-0">
                <Avatar name={account?.name ?? t("common.anonymous")} id={account?.id} size="lg" />
                {pairNeedsConfirm && (
                  <span className="absolute -top-0.5 -right-0.5 size-2.5 rounded-full bg-danger ring-2 ring-paper-deep" />
                )}
              </span>
              <span className="min-w-0 flex-1 leading-tight">
                <span className="block truncate text-sm font-semibold text-ink">
                  {account?.name ?? t("common.anonymous")}
                </span>
                <span className="block truncate text-xs text-ink-3">{clientLabel()}</span>
              </span>
              <Icon name="down" className="size-3.5 shrink-0 text-ink-4" />
            </>
          }
        >
          <MenuItem icon="settings" onClick={() => navigate("/settings")}>{t("home.settingsLink")}</MenuItem>
          <MenuItem icon="userPlus" onClick={() => setPairOpen(true)}>
            <span className="flex-1">{t("pair.entry")}</span>
            {pairNeedsConfirm && <Tag tone="accent">{t("pair.pendingTag")}</Tag>}
          </MenuItem>
          <MenuItem icon="globe" onClick={() => setShareSite(true)}>{t("home.shareSite")}</MenuItem>
          <MenuSeparator />
          <MenuItem icon="logout" danger onClick={() => void logout()}>{t("topbar.logout")}</MenuItem>
        </Menu>
      </div>
    </aside>
  );
}

function NavItem({
  icon,
  label,
  active = false,
  badge,
  onClick,
}: {
  icon: IconName;
  label: string;
  active?: boolean;
  badge?: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={cx(
        "flex h-[34px] cursor-pointer items-center gap-2.5 rounded-lg px-2.5 text-sm font-medium text-ink-2 transition-colors duration-100 ease-swift hover:bg-white/65 hover:text-ink focus-visible:outline-2 focus-visible:outline-accent-600",
        active && "bg-sheet font-semibold text-ink shadow-sm"
      )}
    >
      <Icon name={icon} className={cx("size-[17px] shrink-0", active ? "text-accent" : "opacity-80")} />
      <span className="min-w-0 flex-1 truncate text-left">{label}</span>
      {badge !== undefined && badge > 0 && (
        <span className="inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-accent px-1.5 text-[11px] font-semibold text-white">
          {badge}
        </span>
      )}
    </button>
  );
}

function DocRow({
  room,
  active,
  locale,
  onOpen,
  onQr,
  onDelete,
  onLeave,
}: {
  room: MyRoom;
  active: boolean;
  locale: string;
  onOpen: () => void;
  onQr: () => void;
  onDelete: () => void;
  onLeave: () => void;
}) {
  const { t } = useT();
  const title = docTitle(room, t("common.unnamedDoc"));
  return (
    <li>
      <div
        aria-current={active ? "true" : undefined}
        className={cx(
          "group relative flex h-[54px] items-center gap-2 rounded-10 px-3 transition-colors duration-100 ease-swift",
          active ? "bg-sheet shadow-sm" : "hover:bg-white/60"
        )}
      >
        {/* 选中态左侧强调条 */}
        {active && <span aria-hidden className="absolute top-3.5 bottom-3.5 -left-px w-[3px] rounded-full bg-accent" />}
        {/* 整行可点:覆盖层按钮铺满行,行内操作置于其上 */}
        <button
          type="button"
          onClick={onOpen}
          aria-label={title}
          className="absolute inset-0 z-0 cursor-pointer rounded-10 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-600"
        />
        <div className="pointer-events-none relative z-[1] min-w-0 flex-1">
          <p className={cx("truncate text-sm font-medium", active ? "text-ink" : "text-ink")}>{title}</p>
          <p className="mt-0.5 flex items-center gap-1.5 truncate text-xs text-ink-3">
            {!room.isOwner && <Tag tone="neutral">{t("mobile.tabShared")}</Tag>}
            <span className="shrink-0">{formatRelative(room.lastUsed, locale)}</span>
            {room.userCount > 0 && (
              <span className="inline-flex shrink-0 items-center gap-1 font-medium text-ok">
                <span className="size-1.5 rounded-full bg-ok" />
                {t("home.nOnline", { n: room.userCount })}
              </span>
            )}
          </p>
        </div>
        <div
          className={cx(
            "relative z-[2] flex shrink-0 items-center transition-opacity duration-100 ease-swift",
            active ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-within:opacity-100 hover-none:opacity-100"
          )}
        >
          <RowAction icon="qr" label={t("home.showQrTitle")} onClick={onQr} />
          {room.isOwner ? (
            <RowAction icon="trash" label={t("docs.deleteBtnTitle")} onClick={onDelete} danger />
          ) : (
            <RowAction icon="close" label={t("home.leaveSingleTitle")} onClick={onLeave} danger />
          )}
        </div>
      </div>
    </li>
  );
}

function RowAction({
  icon,
  label,
  onClick,
  danger = false,
}: {
  icon: IconName;
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className={cx(
        "grid size-7 cursor-pointer place-items-center rounded-[7px] text-ink-3 transition-colors duration-100 ease-swift focus-visible:outline-2 focus-visible:outline-accent-600",
        danger ? "hover:bg-danger-bg hover:text-danger" : "hover:bg-fill-2 hover:text-ink"
      )}
    >
      <Icon name={icon} className="size-[15px]" />
    </button>
  );
}

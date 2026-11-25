// 移动端首页(参考小米笔记列表页):
// - 大标题随滚动收起为顶栏居中小标题;搜索胶囊;分类按钮 + 分类标签(吸顶)
// - 白色卡片列表:文档名 / 置顶·时间·共享·在线;置顶文档排最前(本机偏好)
// - 底部悬浮胶囊:扫码 / 新建;左上:用户头像 = 唯一的账号/功能入口(抽屉:分类 + 全部功能);右上:多选 ☑
// - 长按卡片或点 ☑ 进入多选:顶栏「已选中 N 项 / 请选择」+ 全选,底部悬浮操作条(置顶/分享/删除)
import { useMemo, useRef, useState } from "react";
import { Icon } from "@/components/icons";
import { OfflineTag } from "@/components/OfflineTag";
import { Avatar } from "@/components/Avatar";
import { CategoryDrawer, JoinSheet, type DocFilter } from "@/components/mobile/MobileSheets";
import { docTitle } from "@/lib/docTitle";
import { formatRelative } from "@/lib/roomCode";
import { usePinned } from "@/lib/pins";
import { useT } from "@/i18n";
import { useBackHandler } from "@/platform/backButton";
import { useIosScrollPin } from "@/platform/iosScroll";
import type { MyRoom } from "@/types";

interface MobileHomeProps {
  /** 文档页打开时:列表留在下层保持滚动位置,但移出可访问树、不可聚焦 */
  covered?: boolean;
  rooms: MyRoom[];
  serverOk: boolean | null;
  accountName: string;
  accountId?: string;
  pairNeedsConfirm: boolean;
  /** ?join=CODE 落地:自动弹出加入面板并预填 */
  initialJoinCode: string;
  onOpen: (code: string) => void;
  onCreate: () => void;
  onScan: () => void;
  onShare: (code: string) => void;
  /** 批量删除(所有者文档进回收站)/退出(共享文档);确认已在本组件完成 */
  onRemove: (own: string[], joined: string[]) => void;
  onPair: () => void;
  onTrash: () => void;
  onSettings: () => void;
  /** 语音便签页(全端) */
  onNotes: () => void;
  /** 打开原生语音输入页(自带同一份便签);仅 Android App 提供,提供时取代便签页入口 */
  onVoiceInput?: () => void;
  onShareSite: () => void;
  onLogout: () => void;
}

const LONG_PRESS_MS = 450;

export function MobileHome({
  covered = false,
  rooms,
  serverOk,
  accountName,
  accountId,
  pairNeedsConfirm,
  initialJoinCode,
  onOpen,
  onCreate,
  onScan,
  onShare,
  onRemove,
  onPair,
  onTrash,
  onSettings,
  onNotes,
  onVoiceInput,
  onShareSite,
  onLogout,
}: MobileHomeProps) {
  const { t, locale } = useT();
  const { pinned, setPins } = usePinned();
  useIosScrollPin();
  const [filter, setFilter] = useState<DocFilter>("all");
  const [query, setQuery] = useState("");
  const [scrolled, setScrolled] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [joinOpen, setJoinOpen] = useState(initialJoinCode !== "");

  // 多选:null = 非多选态;Set = 多选态(可能为空,即「请选择」)
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const selecting = selected !== null;
  useBackHandler(selecting, () => setSelected(null));

  const counts = useMemo(
    () => ({
      all: rooms.length,
      mine: rooms.filter((r) => r.isOwner).length,
      shared: rooms.filter((r) => !r.isOwner).length,
    }),
    [rooms]
  );

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const unnamed = t("common.unnamedDoc");
    const list = rooms.filter((r) => {
      if (filter === "mine" && !r.isOwner) return false;
      if (filter === "shared" && r.isOwner) return false;
      return !q || docTitle(r, unnamed).toLowerCase().includes(q);
    });
    // 置顶在前(按置顶先后),其余保持服务端稳定顺序
    const rank = (code: string) => {
      const i = pinned.indexOf(code);
      return i < 0 ? Number.MAX_SAFE_INTEGER : i;
    };
    return list
      .map((r, i) => ({ r, i }))
      .sort((a, b) => rank(a.r.code) - rank(b.r.code) || a.i - b.i)
      .map(({ r }) => r);
  }, [rooms, filter, query, pinned, t]);

  const toggle = (code: string) =>
    setSelected((prev) => {
      const next = new Set(prev ?? []);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });

  // 长按进入多选(并选中该项);随后的 click 吞掉,避免立刻又被反选/打开
  const pressTimer = useRef<number | null>(null);
  const pressStart = useRef<{ x: number; y: number } | null>(null);
  const suppressClick = useRef(false);
  const cancelPress = () => {
    if (pressTimer.current !== null) window.clearTimeout(pressTimer.current);
    pressTimer.current = null;
    pressStart.current = null;
  };
  const startPress = (code: string, e: React.PointerEvent) => {
    cancelPress();
    // 真机长按后系统不再派发 click(桌面仿真会):标记若不在新一次按下时清掉,
    // 会吞掉用户下一次正常点击(v4.1 真机联调实测:多选时第一下点卡片没反应)
    suppressClick.current = false;
    pressStart.current = { x: e.clientX, y: e.clientY };
    pressTimer.current = window.setTimeout(() => {
      pressTimer.current = null;
      suppressClick.current = true;
      navigator.vibrate?.(12);
      setSelected((prev) => new Set(prev ?? []).add(code));
    }, LONG_PRESS_MS);
  };
  const movePress = (e: React.PointerEvent) => {
    const s = pressStart.current;
    if (s && Math.hypot(e.clientX - s.x, e.clientY - s.y) > 8) cancelPress();
  };
  const clickCard = (code: string) => {
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    if (selecting) toggle(code);
    else onOpen(code);
  };

  const selectedList = selected ? rooms.filter((r) => selected.has(r.code)) : [];
  const allSelected = visible.length > 0 && visible.every((r) => selected?.has(r.code));
  const allPinned = selectedList.length > 0 && selectedList.every((r) => pinned.includes(r.code));

  const doPin = () => {
    setPins(
      selectedList.map((r) => r.code),
      !allPinned
    );
    setSelected(null);
  };
  const doShare = () => {
    if (selectedList.length !== 1) return;
    onShare(selectedList[0].code);
    setSelected(null);
  };
  const doRemove = () => {
    const own = selectedList.filter((r) => r.isOwner).map((r) => r.code);
    const joined = selectedList.filter((r) => !r.isOwner).map((r) => r.code);
    if (own.length + joined.length === 0) return;
    const msg =
      own.length && joined.length
        ? t("mobile.removeMixedConfirm", { own: own.length, joined: joined.length })
        : own.length
          ? t("mobile.removeOwnConfirm", { n: own.length })
          : t("mobile.removeJoinedConfirm", { n: joined.length });
    if (!window.confirm(msg)) return;
    onRemove(own, joined);
    setSelected(null);
  };

  const bigTitle = selecting
    ? selected.size > 0
      ? t("mobile.selectedN", { n: selected.size })
      : t("mobile.selectNone")
    : t("mobile.title");

  const iconBtn =
    "size-tap-44 shrink-0 flex items-center justify-center rounded-full text-ink-2 active:bg-fill-2 transition-colors cursor-pointer";

  const tabs: { key: DocFilter; label: string }[] = [
    { key: "all", label: t("mobile.tabAll") },
    { key: "mine", label: t("mobile.tabMine") },
    { key: "shared", label: t("mobile.tabShared") },
  ];

  // 同 Notes/MobileDocView:fixed + visualViewport 变量,避免 iOS 键盘把顶栏推到刘海下
  return (
    <div
      inert={covered}
      aria-hidden={covered || undefined}
      className="fixed inset-x-0 top-[var(--vv-top,0px)] z-40 h-[var(--vvh,100dvh)] flex flex-col bg-paper pt-[env(safe-area-inset-top)] box-border"
    >
      {/* 顶栏:多选态 ✕ / 标题 / 全选;常态 ☑ / ⋮。小标题在大标题滚出后淡入 */}
      <header className="relative h-14 shrink-0 flex items-center px-2 gap-1">
        {selecting ? (
          <button
            type="button"
            className={iconBtn}
            onClick={() => setSelected(null)}
            aria-label={t("mobile.exitSelect")}
          >
            <Icon name="close" className="size-5" />
          </button>
        ) : (
          // 左上角用户头像:点开账号/分类抽屉(抽屉底部是账号名,含登录新设备/设置等入口)
          <button
            type="button"
            className="relative grid size-12 shrink-0 cursor-pointer place-items-center rounded-full transition-colors active:bg-fill-2"
            onClick={() => setDrawerOpen(true)}
            aria-label={t("mobile.account", { name: accountName })}
            title={accountName}
          >
            <Avatar name={accountName} id={accountId} className="size-10 text-base" />
            {pairNeedsConfirm && (
              <span className="absolute top-1.5 right-1.5 size-2.5 rounded-full bg-danger ring-2 ring-paper" />
            )}
          </button>
        )}
        <div
          className={`absolute left-16 right-16 text-center text-[17px] font-semibold text-ink truncate pointer-events-none transition-opacity duration-200 ${
            scrolled ? "opacity-100" : "opacity-0"
          }`}
        >
          {bigTitle}
          {serverOk === false && (
            <span className="ml-1.5 text-xs font-medium text-danger">· {t("offline.tag")}</span>
          )}
        </div>
        <div className="ml-auto flex items-center gap-1">
          {selecting ? (
            <button
              type="button"
              className={iconBtn}
              aria-label={allSelected ? t("mobile.unselectAll") : t("mobile.selectAll")}
              onClick={() =>
                setSelected(allSelected ? new Set() : new Set(visible.map((r) => r.code)))
              }
            >
              {allSelected ? (
                <span className="grid size-6 place-items-center rounded-full bg-accent text-white">
                  <Icon name="check" className="size-4" />
                </span>
              ) : (
                <span className="size-6 rounded-full border-2 border-ink-5" />
              )}
            </button>
          ) : (
            <>
              <button
                type="button"
                className={iconBtn}
                aria-label={t("mobile.selectMode")}
                title={t("mobile.selectMode")}
                onClick={() => setSelected(new Set())}
              >
                <Icon name="checkSq" className="size-5" />
              </button>
            </>
          )}
        </div>
      </header>

      <div
        className="flex-1 min-h-0 overflow-y-auto overscroll-contain"
        onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 36)}
      >
        <div className="px-5 pt-1 pb-3 flex items-center gap-2.5">
          <h1 className="text-[30px] leading-tight font-semibold text-ink">{bigTitle}</h1>
          {serverOk === false && <OfflineTag />}
        </div>

        <div className="px-3">
          <label className="flex items-center gap-2 h-10 rounded-full bg-fill-2 px-4 text-ink-3">
            <Icon name="search" className="size-4" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("mobile.search")}
              aria-label={t("mobile.search")}
              className="flex-1 min-w-0 bg-transparent text-15 text-ink placeholder:text-ink-4 focus:outline-none"
            />
          </label>
        </div>

        {/* 分类:吸顶 */}
        <div className="sticky top-0 z-10 bg-paper px-3 py-3 flex items-center gap-2 overflow-x-auto">
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            aria-label={t("mobile.categories")}
            title={t("mobile.categories")}
            className="shrink-0 h-9 w-12 flex items-center justify-center rounded-full bg-sheet text-ink-2 shadow-sm active:bg-fill-1 cursor-pointer"
          >
            <Icon name="folder" className="size-[18px]" />
          </button>
          {tabs.map((tab) => (
            <button
              key={tab.key}
              type="button"
              onClick={() => setFilter(tab.key)}
              aria-pressed={filter === tab.key}
              className={`shrink-0 h-9 px-4 rounded-full text-sm transition-colors cursor-pointer ${
                filter === tab.key
                  ? "bg-accent text-white font-semibold"
                  : "bg-sheet text-ink-2 shadow-sm active:bg-fill-1"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {visible.length === 0 ? (
          <p className="py-20 text-center text-sm text-ink-3">
            {query.trim() ? t("mobile.emptySearch") : t("home.recentEmpty")}
          </p>
        ) : (
          <ul className="px-3 pb-32 space-y-2.5">
            {visible.map((room) => {
              const isSel = selected?.has(room.code) ?? false;
              const isPinned = pinned.includes(room.code);
              return (
                <li key={room.code}>
                  <button
                    type="button"
                    onClick={() => clickCard(room.code)}
                    onPointerDown={(e) => startPress(room.code, e)}
                    onPointerMove={movePress}
                    onPointerUp={cancelPress}
                    onPointerCancel={cancelPress}
                    onPointerLeave={cancelPress}
                    onContextMenu={(e) => e.preventDefault()}
                    aria-pressed={selecting ? isSel : undefined}
                    className={`w-full flex items-center gap-3 rounded-2xl px-4 py-3.5 text-left transition-colors cursor-pointer ${
                      isSel ? "bg-fill-3" : "bg-sheet shadow-sm active:bg-fill-1"
                    }`}
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-[16px] font-medium text-ink truncate">
                        {docTitle(room, t("common.unnamedDoc"))}
                      </p>
                      <p className="mt-1 flex items-center gap-1.5 text-xs text-ink-3 min-w-0">
                        {isPinned && <Icon name="pin" className="size-3.5 text-accent" aria-label={t("mobile.pinned")} />}
                        <span className="shrink-0">{formatRelative(room.lastUsed, locale)}</span>
                        {!room.isOwner && <span className="shrink-0">· {t("mobile.tabShared")}</span>}
                        {room.userCount > 0 && (
                          <span className="shrink-0 text-ok">
                            · ● {t("home.nOnline", { n: room.userCount })}
                          </span>
                        )}
                      </p>
                    </div>
                    {selecting && (
                      <span
                        className={`size-[22px] shrink-0 flex items-center justify-center rounded-full text-xs ${
                          isSel ? "bg-accent text-white" : "border-2 border-ink-5"
                        }`}
                      >
                        {isSel && <Icon name="check" className="size-3.5" />}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* 底部悬浮:多选态=操作条;常态=扫码/新建胶囊 */}
      <div className="pointer-events-none fixed inset-x-0 bottom-0 flex justify-center pb-[calc(env(safe-area-inset-bottom)+16px)]">
        {selecting ? (
          <div className="pointer-events-auto flex items-stretch gap-1 rounded-3xl bg-sheet/95 px-3 py-1.5 shadow-float backdrop-blur animate-sheet-up">
            {[
              {
                key: "pin",
                label: allPinned ? t("mobile.unpin") : t("mobile.pin"),
                icon: "pin" as const,
                disabled: selectedList.length === 0,
                onClick: doPin,
              },
              {
                key: "share",
                label: t("mobile.share"),
                icon: "share" as const,
                disabled: selectedList.length !== 1,
                onClick: doShare,
              },
              {
                key: "remove",
                label: t("mobile.remove"),
                icon: "trash" as const,
                disabled: selectedList.length === 0,
                onClick: doRemove,
              },
            ].map((a) => (
              <button
                key={a.key}
                type="button"
                disabled={a.disabled}
                onClick={a.onClick}
                className="min-w-[72px] min-h-tap-44 flex flex-col items-center justify-center gap-0.5 rounded-2xl px-2 text-ink active:bg-fill-2 disabled:text-ink-5 cursor-pointer"
              >
                <Icon name={a.icon} className="size-[22px]" />
                <span className="text-[11px]">{a.label}</span>
              </button>
            ))}
          </div>
        ) : (
          <div className="pointer-events-auto flex items-center gap-1 rounded-full bg-sheet px-2 py-1 shadow-float">
            <button
              type="button"
              onClick={onScan}
              aria-label={t("home.scanBtn")}
              title={t("home.scanBtn")}
              className="size-12 flex items-center justify-center rounded-full text-ink-2 active:bg-fill-2 cursor-pointer"
            >
              <Icon name="scan" className="size-[22px]" />
            </button>
            <button
              type="button"
              onClick={onVoiceInput ?? onNotes}
              aria-label={t("notes.entry")}
              title={t("notes.entry")}
              className="size-12 flex items-center justify-center rounded-full text-accent active:bg-fill-2 cursor-pointer"
            >
              <Icon name="wave" className="size-[22px]" />
            </button>
            <button
              type="button"
              onClick={onCreate}
              aria-label={t("mobile.create")}
              title={t("mobile.create")}
              className="size-12 flex items-center justify-center rounded-full text-ink active:bg-fill-2 cursor-pointer"
            >
              <Icon name="plus" className="size-[22px]" />
            </button>
          </div>
        )}
      </div>

      {drawerOpen && (
        <CategoryDrawer
          filter={filter}
          counts={counts}
          accountName={accountName}
          accountId={accountId}
          pairNeedsConfirm={pairNeedsConfirm}
          onFilter={setFilter}
          onTrash={onTrash}
          onPair={onPair}
          onSettings={onSettings}
          onJoin={() => setJoinOpen(true)}
          onVoice={onVoiceInput ?? onNotes}
          voiceLabel={onVoiceInput ? t("mobile.voiceInput") : t("notes.entry")}
          onShareSite={onShareSite}
          onLogout={onLogout}
          onClose={() => setDrawerOpen(false)}
        />
      )}
      {joinOpen && (
        <JoinSheet
          initialCode={initialJoinCode}
          onJoin={(code) => {
            setJoinOpen(false);
            onOpen(code);
          }}
          onScan={() => {
            setJoinOpen(false);
            onScan();
          }}
          onClose={() => setJoinOpen(false)}
        />
      )}
    </div>
  );
}

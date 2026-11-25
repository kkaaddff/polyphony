// 语音便签(v5):账号下的便签流,旧 → 新向下追加。桌面留在应用壳内;移动为独立页。
// 手机 App 原生语音输入页每次「发送」追加一条;这里可查看、搜索、手动追加、删除、设保留天数。
// 卡片固定高度,正文最多两行(省略号);手势参照 iOS 信息:往右滑 = 发送到电脑(免确认),
// 往左滑 = 删除(需确认);长按 / 轻点 = 预览全文(可滚动)+ 删除 / 转文档 / 发送。桌面另有行内按钮。
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router";
import { useIosScrollPin } from "@/platform/iosScroll";
import { createVoiceSender, type SenderState, type VoiceSender } from "@/lib/voiceSender";
import {
  createNote,
  fetchNotes,
  fetchRetentionDays,
  NOTE_MAX_CHARS,
  removeNote,
  subscribeNotesChanged,
  RETENTION_CHOICES,
  saveRetentionDays,
  type Note,
} from "@/lib/notes";
import { createDoc } from "@/lib/docs";
import { copyText } from "@/lib/clipboard";
import { useT } from "@/i18n";
import { useIsMobile } from "@/lib/useIsMobile";
import { useShell } from "@/components/shellContext";
import { useToast } from "@/components/Toast";
import { Icon } from "@/components/icons";
import { Button, Dialog, IconButton, Select, cx, inputClass } from "@/components/ui";

const PAGE = 100;
/** 越过即触发(松手发送 / 弹删除确认) */
const SWIPE_TRIGGER = 120;
/** 左滑松手后停留露出「删除」的宽度 */
const SWIPE_OPEN = 88;
const LONG_PRESS_MS = 450;

export default function Notes() {
  const navigate = useNavigate();
  const location = useLocation();
  const { t, locale } = useT();
  const toast = useToast();
  const isMobile = useIsMobile();
  useIosScrollPin(isMobile);
  const { openDocWithSeed } = useShell();
  /** 升序(旧 → 新);服务端按新 → 旧分页,入列时反转 */
  const [notes, setNotes] = useState<Note[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [retention, setRetention] = useState<number | null>(null);
  const [copiedId, setCopiedId] = useState("");
  const [preview, setPreview] = useState<Note | null>(null);

  // 手机上这一页同时是「语音输入到电脑」的发送端(与 Android 原生语音页同一套协议,见 lib/voiceSender.ts):
  // 输入框里的文字实时出现在电脑当前光标处,点「发送」提交并存成一条便签。桌面布局不启用(电脑是接收端)。
  const voice = isMobile;
  const senderRef = useRef<VoiceSender | null>(null);
  const [sender, setSender] = useState<SenderState | null>(null);
  const [pickTarget, setPickTarget] = useState(false);
  useEffect(() => {
    if (!voice) return;
    const s = createVoiceSender(setSender);
    senderRef.current = s;
    s.start();
    return () => {
      s.stop();
      senderRef.current = null;
      setSender(null);
    };
  }, [voice]);

  const listRef = useRef<HTMLDivElement>(null);
  /** 下一次渲染后是否滚到底(首屏/追加/搜索);加载更早的一页时保持位置 */
  const stickBottom = useRef(true);
  const requestSeq = useRef(0);

  const load = useCallback(async (q: string, live = false) => {
    const seq = ++requestSeq.current;
    const el = listRef.current;
    const nearBottom = !el || el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    try {
      const page = await fetchNotes({ q, limit: PAGE });
      if (seq !== requestSeq.current) return;
      stickBottom.current = !live || nearBottom;
      setNotes(page.notes.slice().reverse());
      setHasMore(page.hasMore);
      setError("");
    } catch {
      if (seq === requestSeq.current) setError(t("notes.loadFail"));
    } finally {
      if (seq === requestSeq.current) setLoaded(true);
    }
  }, [t]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(query), query ? 250 : 0);
    return () => window.clearTimeout(timer);
  }, [query, load]);

  useEffect(() => {
    const onFocus = () => void load(query);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [query, load]);

  useEffect(() => {
    fetchRetentionDays().then(setRetention).catch(() => setRetention(null));
  }, []);

  // 实时:别的设备新增/删除便签时自动刷新
  const queryRef = useRef(query);
  queryRef.current = query;
  useEffect(
    () =>
      subscribeNotesChanged(() => {
        void load(queryRef.current, true);
        fetchRetentionDays().then(setRetention).catch(() => {});
      }),
    [load]
  );

  useLayoutEffect(() => {
    if (!stickBottom.current) return;
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [notes]);

  const loadEarlier = async () => {
    const oldest = notes[0];
    if (!oldest) return;
    try {
      const page = await fetchNotes({ q: query, limit: PAGE, before: oldest.createdAt });
      stickBottom.current = false;
      setNotes((cur) => [...page.notes.slice().reverse(), ...cur]);
      setHasMore(page.hasMore);
    } catch {
      setError(t("notes.loadFail"));
    }
  };

  const submit = async () => {
    const text = draft.trim();
    if (!text || saving) return;
    setSaving(true);
    // 先把终稿交给电脑(不等便签落库:电脑上的提交不该被网络请求拖慢),再存便签
    senderRef.current?.finish(draft);
    try {
      const note = await createNote(text);
      setDraft("");
      setError("");
      if (query) {
        setQuery("");
      } else {
        stickBottom.current = true;
        setNotes((cur) => (cur.some((n) => n.id === note.id) ? cur : [...cur, note]));
      }
    } catch {
      setError(t("notes.saveFail"));
    } finally {
      setSaving(false);
    }
  };

  /** 删除;`confirmed` 为 false 时先弹确认。返回是否真的删了(滑动手势据此决定回弹还是收起)。 */
  const remove = async (note: Note, confirmed = false): Promise<boolean> => {
    if (!confirmed && !window.confirm(t("notes.deleteConfirm"))) return false;
    try {
      await removeNote(note.id);
      stickBottom.current = false;
      setNotes((cur) => cur.filter((n) => n.id !== note.id));
      return true;
    } catch {
      setError(t("notes.saveFail"));
      return false;
    }
  };

  // 便签 → 电脑:一次性会话,直接输入到电脑当前光标处(手机端;桌面布局本身是接收端,不发)
  const send = (note: Note) => {
    const s = senderRef.current;
    if (!s) {
      toast.show(t("notes.sendFail"), "error");
      return;
    }
    if (s.resend(note.text)) toast.show(t("notes.sent"), "success");
    else toast.show(t("voiceSend.noReceiver"), "error");
  };

  // 状态栏(同原生页 renderStatus):连接 / 目标电脑 / 当前会话提示
  const targetLabel = sender?.receivers.find((r) => r.deviceId === sender.target)?.label ?? null;
  const senderReady = sender?.conn === "connected" && targetLabel !== null;
  const senderText = !sender
    ? ""
    : sender.needsResume
      ? t("voiceSend.unknownSession")
      : sender.conn === "connecting"
        ? t("voiceSend.connecting")
        : sender.conn === "offline"
          ? t("voiceSend.offline")
          : sender.conn === "unauthorized"
            ? t("voiceSend.unauthorized")
            : sender.receivers.length === 0
              ? t("voiceSend.noReceiver")
              : targetLabel === null
                ? t("voiceSend.pickTarget")
                : sender.hint
                  ? t(`voiceSend.${sender.hint}`, { label: targetLabel })
                  : t("voiceSend.readyFor", { label: targetLabel });
  const onStatusClick = () => {
    if (!sender) return;
    if (sender.needsResume) senderRef.current?.resume();
    else if (sender.receivers.length > 1) setPickTarget(true);
  };

  // 转成文档:以这条便签为正文新建一篇文档(首行作文档名),便签本身保留
  const convert = async (note: Note) => {
    try {
      const name = note.text.split("\n")[0].trim().slice(0, 40);
      const { code } = await createDoc(name || undefined);
      toast.show(t("notes.toDocDone"), "success");
      openDocWithSeed(code, note.text);
    } catch {
      toast.show(t("notes.toDocFail"), "error");
    }
  };

  const changeRetention = async (days: number) => {
    const prev = retention;
    setRetention(days);
    try {
      setRetention(await saveRetentionDays(days));
      void load(query);
    } catch {
      setRetention(prev);
      setError(t("notes.saveFail"));
    }
  };

  const formatTime = (ts: number) =>
    new Date(ts).toLocaleString(locale === "zh" ? "zh-CN" : "en", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });

  // 返回:有上一页就真的后退(iOS 边缘右滑返回走的也是历史栈,压一条新的「/」会让首页再右滑又回到便签);
  // 直接打开 /notes(没有上一页)时才替换成首页。
  const goBack = () => {
    if (location.key !== "default") void navigate(-1);
    else void navigate("/", { replace: true });
  };

  // 移动端用 visualViewport 变量定高定位(同 MobileDocView):iOS WKWebView 键盘弹起时布局视口不缩、
  // 只把整页上移,h-dvh 会让页头被推到刘海下;fixed + --vv-top/--vvh 始终落在可见区。
  return (
    <div className={cx("flex flex-col", isMobile ? "fixed inset-x-0 top-[var(--vv-top,0px)] z-40 h-[var(--vvh,100dvh)] bg-paper box-border pt-[env(safe-area-inset-top)]" : "min-h-0 flex-1")}>
      {/* 页头:标题 + 条数 + 保留天数 + 搜索 */}
      <header className="mx-auto flex w-full max-w-3xl shrink-0 flex-wrap items-center gap-2 px-3 py-3 sm:px-6">
        {isMobile && (
          <IconButton icon="left" size="touch" label={t("mobile.back")} onClick={goBack} className="-ml-2" />
        )}
        <h1 className="text-lg font-bold text-ink">{t("notes.title")}</h1>
        <span className="text-13 text-ink-3 tabular-nums">{t("notes.count", { n: notes.length })}</span>
        <span className="flex-1" />
        <label className="flex shrink-0 items-center gap-2 whitespace-nowrap text-xs text-ink-3">
          {t("notes.retentionLabel")}
          <Select
            aria-label={t("notes.retentionLabel")}
            value={retention ?? ""}
            disabled={retention === null}
            onChange={(e) => void changeRetention(Number(e.target.value))}
            className="w-[120px]"
          >
            {retention === null && <option value="">…</option>}
            {RETENTION_CHOICES.map((d) => (
              <option key={d} value={d}>{d === 0 ? t("notes.forever") : t("notes.days", { n: d })}</option>
            ))}
            {retention !== null && !RETENTION_CHOICES.some((d) => d === retention) && (
              <option value={retention}>{t("notes.days", { n: retention })}</option>
            )}
          </Select>
        </label>
        <div className="relative w-full">
          <Icon name="search" className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-3" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("notes.searchPlaceholder")}
            aria-label={t("notes.searchPlaceholder")}
            className={inputClass({ fill: true, className: "rounded-full pl-9" })}
          />
        </div>
      </header>

      {/* 便签流 */}
      <div ref={listRef} className="thin-scroll min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl space-y-2.5 px-3 py-2 sm:px-6">
          {hasMore && (
            <button onClick={() => void loadEarlier()} className="mx-auto block py-2 text-xs text-accent-800 hover:underline">
              {t("notes.loadEarlier")}
            </button>
          )}
          {loaded && notes.length === 0 && (
            <p className="px-6 py-16 text-center text-sm leading-relaxed text-ink-3">
              {query.trim() ? t("notes.emptySearch") : t("notes.empty")}
            </p>
          )}
          {notes.map((n) => (
            <SwipeableNote
              key={n.id}
              onDelete={() => remove(n)}
              onSend={() => send(n)}
              onPreview={() => setPreview(n)}
              deleteLabel={t("notes.delete")}
              sendLabel={t("notes.send")}
            >
              <p className="line-clamp-2 text-15 leading-relaxed break-words text-ink">{n.text}</p>
              <div className="mt-auto flex items-center gap-0.5 text-xs text-ink-3">
                <span className="mr-auto truncate">
                  {formatTime(n.createdAt)}
                  {n.device ? ` · ${n.device}` : ""}
                </span>
                {/* 桌面(有悬停)行内操作;触屏用手势与预览 */}
                <span className="hidden shrink-0 items-center gap-0.5 whitespace-nowrap hover-hover:flex">
                  <NoteAction
                    icon="copy"
                    label={copiedId === n.id ? t("notes.copied") : t("notes.copy")}
                    onClick={async () => {
                      if (await copyText(n.text)) {
                        setCopiedId(n.id);
                        window.setTimeout(() => setCopiedId(""), 1500);
                      }
                    }}
                  />
                  <NoteAction icon="filePlus" label={t("notes.toDoc")} onClick={() => void convert(n)} />
                  <NoteAction icon="trash" label={t("notes.delete")} danger onClick={() => void remove(n)} />
                </span>
              </div>
            </SwipeableNote>
          ))}
        </div>
      </div>

      {/* 输入区 */}
      {/* 底部留白:键盘弹起时安全区被键盘盖住(--kb-safe-bottom=0),只留与上方对称的 12px;
          键盘收起时让输入框压进安全区一截(只避开 Home 指示条),不然下方空一大块、看着不居中 */}
      <footer className="shrink-0 border-t border-line bg-sheet pb-[max(12px,calc(var(--kb-safe-bottom,env(safe-area-inset-bottom))-14px))]">
        <div className="mx-auto w-full max-w-3xl px-3 pt-3 sm:px-6">
          {error && <p className="mb-2 text-xs text-danger">{error}</p>}
          {sender && (
            <button
              type="button"
              onClick={onStatusClick}
              data-testid="voice-status"
              className={cx("mb-2 block w-full truncate text-left text-xs", senderReady && !sender.needsResume ? "text-ok" : "text-warn")}
            >
              {senderText}
            </button>
          )}
          <div className="flex items-end gap-2">
            <textarea
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                senderRef.current?.update(e.target.value, e.target.selectionStart, e.target.selectionEnd);
              }}
              onSelect={(e) => {
                const el = e.currentTarget;
                senderRef.current?.update(el.value, el.selectionStart, el.selectionEnd);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void submit();
                }
              }}
              rows={2}
              maxLength={NOTE_MAX_CHARS}
              placeholder={voice ? t("voiceSend.inputHint") : t("notes.inputPlaceholder")}
              aria-label={voice ? t("voiceSend.inputHint") : t("notes.inputPlaceholder")}
              className={inputClass({ fill: true, className: "!h-auto min-h-[66px] max-h-40 flex-1 resize-none py-2.5 leading-relaxed field-sizing-content" })}
            />
            <Button variant="primary" onClick={() => void submit()} disabled={!draft.trim() || saving} className="h-11 rounded-full px-5">
              {voice ? t("voiceSend.sendBtn") : t("notes.add")}
            </Button>
          </div>
        </div>
      </footer>

      {pickTarget && sender && (
        <Dialog title={t("voiceSend.chooseTarget")} onClose={() => setPickTarget(false)} testId="voice-target">
          <div className="flex flex-col gap-2">
            {sender.receivers.map((r) => (
              <Button
                key={r.deviceId}
                variant={r.deviceId === sender.target ? "primary" : "secondary"}
                onClick={() => {
                  senderRef.current?.setTarget(r.deviceId);
                  setPickTarget(false);
                }}
              >
                {r.label}
              </Button>
            ))}
          </div>
        </Dialog>
      )}

      {preview && (
        <Dialog
          title={t("notes.preview")}
          desc={`${formatTime(preview.createdAt)}${preview.device ? ` · ${preview.device}` : ""}`}
          onClose={() => setPreview(null)}
          testId="note-preview"
          className="[&>div:last-child]:flex-col md:[&>div:last-child]:flex-row"
          footer={
            <div className="grid w-full grid-cols-3 gap-2">
              <Button
                variant="dangerGhost"
                onClick={async () => {
                  if (await remove(preview)) setPreview(null);
                }}
              >
                {t("notes.delete")}
              </Button>
              <Button
                variant="secondary"
                onClick={() => {
                  const n = preview;
                  setPreview(null);
                  void convert(n);
                }}
              >
                {t("notes.toDoc")}
              </Button>
              <Button
                variant="primary"
                onClick={() => {
                  const n = preview;
                  setPreview(null);
                  send(n);
                }}
              >
                {t("notes.send")}
              </Button>
            </div>
          }
        >
          <div className="thin-scroll max-h-[55dvh] overflow-y-auto">
            <p className="text-15 leading-relaxed whitespace-pre-wrap break-words text-ink select-text">{preview.text}</p>
          </div>
        </Dialog>
      )}
    </div>
  );
}

function NoteAction({
  icon,
  label,
  onClick,
  danger = false,
}: {
  icon: "copy" | "filePlus" | "trash";
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx(
        "flex shrink-0 cursor-pointer items-center gap-1 rounded-md px-2 py-1 whitespace-nowrap transition-colors duration-100 ease-swift focus-visible:outline-2 focus-visible:outline-accent-600",
        danger ? "hover:bg-danger-bg hover:text-danger" : "hover:bg-fill-2 hover:text-ink"
      )}
    >
      <Icon name={icon} className="size-3.5" />
      {label}
    </button>
  );
}

/**
 * 便签卡片手势(参照 iOS 信息列表):
 * - 往右滑:左侧露出「发送」胶囊,越拉越长;越过阈值松手 = 直接发送(不确认),卡片回弹;
 * - 往左滑:右侧露出红色「删除」胶囊;越过阈值松手 = 弹确认;没越过但过半 = 停在露出态,点胶囊再确认;
 *   确认后卡片滑出、行高收起,取消则回弹;
 * - 长按 / 轻点:预览全文。触屏与鼠标拖动都可用(pointer 事件);竖向滚动优先(touch-action: pan-y)。
 */
function SwipeableNote({
  children,
  onDelete,
  onSend,
  onPreview,
  deleteLabel,
  sendLabel,
}: {
  children: ReactNode;
  /** 弹确认并删除;返回是否真的删了 */
  onDelete: () => Promise<boolean>;
  onSend: () => void;
  onPreview: () => void;
  deleteLabel: string;
  sendLabel: string;
}) {
  const [dx, setDx] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const start = useRef<{ x: number; y: number; id: number; base: number } | null>(null);
  const moved = useRef(false);
  const pressTimer = useRef<number | null>(null);
  const longPressed = useRef(false);
  const armed = useRef(false);

  const clearPress = () => {
    if (pressTimer.current !== null) window.clearTimeout(pressTimer.current);
    pressTimer.current = null;
  };

  const askDelete = async () => {
    setDx(-SWIPE_OPEN);
    // 让「露出删除」先渲染出来,再弹系统确认框
    await new Promise((r) => window.setTimeout(r, 180));
    if (await onDelete()) {
      setLeaving(true);
    } else {
      setDx(0);
    }
  };

  const release = (cancelled: boolean) => {
    clearPress();
    const d = dx;
    const wasDragging = dragging;
    start.current = null;
    setDragging(false);
    if (longPressed.current) {
      setDx(0);
      return;
    }
    if (cancelled) {
      setDx(d <= -SWIPE_OPEN / 2 ? -SWIPE_OPEN : 0);
      return;
    }
    if (!wasDragging) {
      // 露出态轻点 = 收起;常态轻点 = 预览
      if (d !== 0) setDx(0);
      else onPreview();
      return;
    }
    if (d >= SWIPE_TRIGGER) {
      setDx(0);
      onSend();
    } else if (d <= -SWIPE_TRIGGER) {
      void askDelete();
    } else if (d <= -SWIPE_OPEN / 2) {
      setDx(-SWIPE_OPEN);
    } else {
      setDx(0);
    }
  };

  const ease = "cubic-bezier(.2,.8,.2,1)";

  return (
    <div
      className="relative grid overflow-hidden"
      style={{
        gridTemplateRows: leaving ? "0fr" : "1fr",
        opacity: leaving ? 0 : 1,
        transition: `grid-template-rows 220ms ${ease} 160ms, opacity 200ms ${ease} 160ms`,
      }}
    >
      <div className="relative min-h-0">
        <SwipePill
          side="left"
          reveal={Math.max(0, dx)}
          dragging={dragging}
          hot={dx >= SWIPE_TRIGGER}
          icon="upload"
          label={sendLabel}
          tone="accent"
          onClick={() => {
            setDx(0);
            onSend();
          }}
        />
        <SwipePill
          side="right"
          reveal={Math.max(0, -dx)}
          dragging={dragging}
          hot={-dx >= SWIPE_TRIGGER}
          icon="trash"
          label={deleteLabel}
          tone="danger"
          onClick={() => void askDelete()}
        />
        <article
          data-testid="note"
          onPointerDown={(e) => {
            if (e.pointerType === "mouse" && e.button !== 0) return;
            if ((e.target as HTMLElement).closest("button")) return;
            start.current = { x: e.clientX, y: e.clientY, id: e.pointerId, base: dx };
            moved.current = false;
            longPressed.current = false;
            armed.current = false;
            clearPress();
            pressTimer.current = window.setTimeout(() => {
              pressTimer.current = null;
              if (moved.current) return;
              longPressed.current = true;
              navigator.vibrate?.(12);
              onPreview();
            }, LONG_PRESS_MS);
          }}
          onPointerMove={(e) => {
            const s = start.current;
            if (!s || s.id !== e.pointerId || longPressed.current) return;
            const mx = e.clientX - s.x;
            const my = e.clientY - s.y;
            if (Math.hypot(mx, my) > 8) {
              moved.current = true;
              clearPress();
            }
            if (!dragging) {
              if (Math.abs(my) > 10 && Math.abs(my) > Math.abs(mx)) {
                start.current = null; // 竖向滚动
                return;
              }
              if (Math.abs(mx) < 12) return;
              setDragging(true);
              e.currentTarget.setPointerCapture(e.pointerId);
            }
            // 越过阈值后加阻尼
            let x = s.base + mx;
            const limit = SWIPE_TRIGGER * 1.4;
            if (Math.abs(x) > limit) x = Math.sign(x) * (limit + (Math.abs(x) - limit) * 0.3);
            const hot = Math.abs(x) >= SWIPE_TRIGGER;
            if (hot !== armed.current) {
              armed.current = hot;
              if (hot) navigator.vibrate?.(8);
            }
            setDx(x);
          }}
          onPointerUp={(e) => {
            // 预览/菜单里的按钮不算轻点
            if ((e.target as HTMLElement).closest("button")) return;
            release(false);
          }}
          onPointerCancel={() => release(true)}
          onContextMenu={(e) => e.preventDefault()}
          style={{
            transform: leaving ? "translateX(-110%)" : dx ? `translateX(${dx}px)` : undefined,
            transition: dragging ? "none" : `transform 220ms ${ease}`,
            touchAction: "pan-y",
          }}
          className={cx(
            "relative flex h-[92px] cursor-pointer flex-col rounded-14 bg-sheet px-4 py-3 shadow-sm select-none active:bg-fill-1",
            dragging && "cursor-grabbing"
          )}
        >
          {children}
        </article>
      </div>
    </div>
  );
}

/** 滑动露出的按钮尺寸:圆点 → 半高圆 → 固定半高拉长成胶囊(两端半圆、中间矩形)。 */
const PILL_H = 40;
const PILL_GAP = 10;
const PILL_DOT = 10;

/**
 * 跟手的滑动按钮(参照 iOS 信息):
 * 露出宽度 < 圆直径时是从小圆点长到半高圆;之后高度固定、两端半圆、中间矩形向外拉长。
 * 小的时候只显示图标,拉到放得下文字才出现文字;松手时(拖拽结束且仍露出)做一次「duang」回弹。
 */
function SwipePill({
  side,
  reveal,
  dragging,
  hot,
  icon,
  label,
  tone,
  onClick,
}: {
  side: "left" | "right";
  /** 卡片位移露出的宽度(px,>= 0) */
  reveal: number;
  dragging: boolean;
  hot: boolean;
  icon: "upload" | "trash";
  label: string;
  tone: "accent" | "danger";
  onClick: () => void;
}) {
  const room = Math.max(0, reveal - PILL_GAP * 2);
  // 阶段一:圆点 → 圆(直径随露出宽度长到 PILL_H);阶段二:高度固定、宽度继续拉长
  const size = Math.min(PILL_H, Math.max(PILL_DOT, room));
  const width = Math.max(size, room);
  const visible = room > 2;
  const showIcon = size >= 22;
  const showText = width >= 96;

  // 松手(dragging true → false)且还露着:duang 一下
  const [bounce, setBounce] = useState(0);
  const wasDragging = useRef(false);
  useEffect(() => {
    if (wasDragging.current && !dragging && reveal > PILL_H / 2) setBounce((n) => n + 1);
    wasDragging.current = dragging;
  }, [dragging, reveal]);

  const ease = "cubic-bezier(.2,.8,.2,1)";
  const bg =
    tone === "accent" ? (hot ? "bg-accent" : "bg-accent-400") : hot ? "bg-danger" : "bg-[#f08a8a]";

  return (
    <div
      aria-hidden
      className={cx(
        "pointer-events-none absolute inset-y-0 flex items-center",
        side === "left" ? "left-0 justify-start" : "right-0 justify-end"
      )}
      style={{ width: reveal, padding: `0 ${PILL_GAP}px` }}
    >
      <button
        key={bounce}
        type="button"
        tabIndex={-1}
        onClick={onClick}
        className={cx(
          "pointer-events-auto flex shrink-0 items-center justify-center gap-1.5 overflow-hidden rounded-full font-semibold whitespace-nowrap text-white",
          bg,
          bounce > 0 && "animate-duang",
          !visible && "invisible"
        )}
        style={{
          width,
          height: size,
          fontSize: 13,
          transformOrigin: side === "left" ? "left center" : "right center",
          transition: dragging
            ? "background-color 120ms"
            : `width 240ms ${ease}, height 240ms ${ease}, background-color 120ms`,
        }}
      >
        {showIcon && <Icon name={icon} className="size-[18px] shrink-0" />}
        {showText && <span>{label}</span>}
      </button>
    </div>
  );
}

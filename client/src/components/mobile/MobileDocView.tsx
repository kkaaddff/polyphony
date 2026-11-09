// 移动端文档页(参考小米笔记的阅读/编辑双态):
// - 阅读态顶栏:← | 分享 ⋮;点正文/标题即进入编辑态 → ← | 撤销 重做 ✓(✓ 收起键盘回阅读态)
// - 大标题即文档名(就地改名,回车跳到正文);其下一行元信息「N 字 | 连接/在线」
// - 编辑态在键盘上方悬浮格式工具栏(MobileEditorToolbar,经 portal 挂到底部槽位)
// 协同逻辑与桌面 Editor 一致:远端更新经 setMarkdown 推入,本地编辑走 applyLocalChange。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MDXEditor, type MDXEditorMethods } from "@mdxeditor/editor";
import { REDO_COMMAND, UNDO_COMMAND, type LexicalEditor } from "lexical";
import {
  CheckOutlined,
  LeftOutlined,
  MoreOutlined,
  ShareAltOutlined,
} from "@ant-design/icons";
import { RedoIcon, UndoIcon } from "@/components/icons";
import { createMobileEditorPlugins } from "@/components/editorConfig";
import { MobileEditorBridge, type HistoryState } from "@/components/mobile/MobileEditorToolbar";
import { Menu, MenuItem } from "@/components/Menu";
import { QrModal } from "@/components/QrModal";
import { UsersPanel } from "@/components/UsersPanel";
import { useCollaboration } from "@/lib/useCollaboration";
import { exportDoc, getDocStatus, uploadAttachment } from "@/lib/docs";
import { prepImageForUpload } from "@/lib/imagePrep";
import { getServerBase } from "@/lib/serverConfig";
import { buildJoinUrl } from "@/lib/qr";
import { useT } from "@/i18n";
import { useBackHandler } from "@/platform/backButton";
import type { User } from "@/types";

const COLLAB_ERROR_KEYS: Record<string, "editor.collabError" | "editor.connectionClosed"> = {
  ERR_COLLAB_CONNECT: "editor.collabError",
  ERR_CONNECTION_CLOSED: "editor.connectionClosed",
};

const UPLOAD_ERROR_KEYS: Record<string, "errors.E_NO_FILE" | "errors.E_FILE_TYPE" | "errors.E_FILE_SIZE" | "errors.E_UPLOAD"> = {
  E_NO_FILE: "errors.E_NO_FILE",
  E_FILE_TYPE: "errors.E_FILE_TYPE",
  E_FILE_SIZE: "errors.E_FILE_SIZE",
  E_UPLOAD: "errors.E_UPLOAD",
};

interface MobileDocViewProps {
  code: string;
  /** 列表里已知的文档名:Yjs meta 同步到达前先显示它,避免标题闪「未命名」 */
  initialName?: string;
  userName: string;
  userId: string;
  onClose: () => void;
  onUnavailable: (code: string, kind: "missing" | "trashed") => void;
  /** 删除(所有者)/退出(成员):由首页统一确认与刷新列表 */
  onDelete: (code: string) => void;
  onLeave: (code: string) => void;
  /** 共享名变化(本人或他人改名):首页据此即时更新列表,不等服务端落库 */
  onNameChange?: (code: string, name: string) => void;
}

// 编辑态顶栏按钮:pointerdown 阻止默认,点击时正文不失焦——
// 否则失焦先把顶栏切回阅读态,这次点击会落到同位置的「分享」上
const keepFocus = (e: React.PointerEvent | React.MouseEvent) => e.preventDefault();

function RoundButton({
  label,
  onClick,
  disabled = false,
  holdFocus = false,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  holdFocus?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onPointerDown={holdFocus ? keepFocus : undefined}
      onMouseDown={holdFocus ? keepFocus : undefined}
      onClick={onClick}
      className="size-tap-44 shrink-0 flex items-center justify-center rounded-full text-xl text-gray-800 active:bg-gray-100 disabled:text-gray-300 transition-colors"
    >
      {children}
    </button>
  );
}

export function MobileDocView({
  code,
  initialName = "",
  userName,
  userId,
  onClose,
  onUnavailable,
  onDelete,
  onLeave,
  onNameChange,
}: MobileDocViewProps) {
  const { t } = useT();
  const [content, setContent] = useState("");
  const [users, setUsers] = useState<User[]>([]);
  const [metaName, setMetaName] = useState("");
  const roomName = metaName || initialName;
  const [isOwner, setIsOwner] = useState(false);
  const [usersOpen, setUsersOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  // 编辑态:焦点在标题或正文内;工具栏只在正文聚焦时出现
  const rootRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [focusArea, setFocusArea] = useState<"none" | "title" | "body">("none");
  const editing = focusArea !== "none";
  const syncFocus = useCallback(() => {
    // 下一帧再读:Lexical 内部节点替换时会有一瞬间的 blur→focus
    requestAnimationFrame(() => {
      const el = document.activeElement;
      if (bodyRef.current?.contains(el)) setFocusArea("body");
      else if (el instanceof HTMLInputElement && el.dataset.docTitle !== undefined) setFocusArea("title");
      else setFocusArea("none");
    });
  }, []);
  const exitEditing = () => (document.activeElement as HTMLElement | null)?.blur();
  // Android 返回键:编辑态先收起键盘,再由首页的处理器关闭文档
  useBackHandler(editing, exitEditing);
  useBackHandler(usersOpen, () => setUsersOpen(false));
  useEffect(() => {
    if (!usersOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setUsersOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [usersOpen]);

  // 滚动后顶栏中间淡入小标题(大标题滚出视野时)
  const [scrolled, setScrolled] = useState(false);

  // 远端更新 → setMarkdown。fromRemote 只用来忽略 setMarkdown 自己触发的 onChange 回声
  const editorRef = useRef<MDXEditorMethods | null>(null);
  const contentRef = useRef("");
  const fromRemote = useRef(false);
  const remoteTimer = useRef<number | undefined>(undefined);

  const onDocUnavailable = useCallback(
    (kind: "missing" | "trashed") => {
      localStorage.removeItem(`polyphony-room-${code}`);
      onUnavailable(code, kind);
    },
    [code, onUnavailable]
  );

  const collab = useCollaboration({
    roomCode: code,
    userName,
    userId,
    onContentChange: (next) => {
      // 远端更新一律写入,不能因「上一次 setMarkdown 的回声窗口还没关」就丢掉:
      // 真机实测手机处理慢于 WS 消息间隔,丢弃会让对方连续输入的后半截停在屏幕外
      const text = next as string;
      if (text === contentRef.current) return;
      contentRef.current = text;
      setContent(text);
      fromRemote.current = true;
      editorRef.current?.setMarkdown(text);
      window.clearTimeout(remoteTimer.current);
      remoteTimer.current = window.setTimeout(() => {
        fromRemote.current = false;
      }, 0);
    },
    onUsersChange: setUsers,
    onRoomNameChange: (name) => {
      setMetaName(name);
      if (name) onNameChange?.(code, name);
    },
    onDocUnavailable,
  });
  const { applyLocalChange } = collab;

  // 标题:聚焦期间编辑本地草稿,失焦/回车才写共享 meta(避免逐字广播改名)
  const [titleDraft, setTitleDraft] = useState("");
  const commitTitle = () => {
    const next = titleDraft.trim();
    if (next && next !== roomName) collab.renameRoom(next);
  };

  const handleChange = useCallback(
    (markdown: string, initialNormalize: boolean) => {
      if (initialNormalize || fromRemote.current) return;
      contentRef.current = markdown;
      setContent(markdown);
      applyLocalChange(markdown);
    },
    [applyLocalChange]
  );

  useEffect(() => {
    getDocStatus(code)
      .then((s) => setIsOwner(s.status === "active" && s.isOwner))
      .catch(() => setIsOwner(false));
  }, [code]);

  const handleImageUpload = useCallback(
    async (file: File) => {
      try {
        const prep = await prepImageForUpload(file);
        if (!prep.ok) {
          throw new Error(
            prep.error === "gif-too-large" ? t("errors.E_FILE_SIZE") : t("editor.imagePrepFail")
          );
        }
        return await uploadAttachment(code, prep.blob, prep.filename);
      } catch (error) {
        const errCode = (error as { code?: string }).code;
        const key = errCode ? UPLOAD_ERROR_KEYS[errCode] : undefined;
        const msg =
          (key ? t(key) : undefined) ??
          (error instanceof Error ? error.message : t("editor.unknownError"));
        alert(t("editor.uploadFail", { msg }));
        throw error;
      }
    },
    [code, t]
  );
  const imagePreviewHandler = useCallback(
    (src: string) => Promise.resolve(src.startsWith("/uploads/") ? getServerBase() + src : src),
    []
  );
  const plugins = useMemo(
    () => createMobileEditorPlugins(handleImageUpload, imagePreviewHandler),
    [handleImageUpload, imagePreviewHandler]
  );

  // 工具栏桥:槽位 + 当前 Lexical 编辑器(撤销/重做)
  const [toolbarSlot, setToolbarSlot] = useState<HTMLDivElement | null>(null);
  const lexicalRef = useRef<LexicalEditor | null>(null);
  const [history, setHistory] = useState<HistoryState>({ canUndo: false, canRedo: false });
  const bridge = useMemo(
    () => ({
      slot: toolbarSlot,
      onEditor: (ed: LexicalEditor | null) => {
        lexicalRef.current = ed;
      },
      onHistory: setHistory,
    }),
    [toolbarSlot]
  );

  const doExport = async () => {
    setBusy(true);
    try {
      const url = await exportDoc(code);
      window.location.assign(`${getServerBase()}${url}`);
    } catch {
      /* 忽略 */
    } finally {
      setBusy(false);
    }
  };

  const displayName = roomName || t("common.unnamedDoc");

  return (
    <div
      ref={rootRef}
      className="fixed inset-x-0 top-[var(--vv-top,0px)] h-[var(--vvh,100dvh)] z-40 bg-white flex flex-col pt-[env(safe-area-inset-top)] box-border"
      onFocus={syncFocus}
      onBlur={syncFocus}
    >
      <header className="relative h-14 shrink-0 flex items-center gap-1 px-2">
        <RoundButton label={t("mobile.back")} onClick={onClose} holdFocus={editing}>
          <LeftOutlined />
        </RoundButton>
        <div
          className={`absolute left-16 right-36 text-center text-base font-medium text-gray-900 truncate pointer-events-none transition-opacity ${
            scrolled ? "opacity-100" : "opacity-0"
          }`}
        >
          {displayName}
        </div>
        <div className="ml-auto flex items-center gap-1">
          {editing ? (
            <>
              <RoundButton
                label={t("mobile.undo")}
                holdFocus
                disabled={!history.canUndo}
                onClick={() => lexicalRef.current?.dispatchCommand(UNDO_COMMAND, undefined)}
              >
                <UndoIcon className="size-6" />
              </RoundButton>
              <RoundButton
                label={t("mobile.redo")}
                holdFocus
                disabled={!history.canRedo}
                onClick={() => lexicalRef.current?.dispatchCommand(REDO_COMMAND, undefined)}
              >
                <RedoIcon className="size-6" />
              </RoundButton>
              <RoundButton label={t("mobile.done")} holdFocus onClick={exitEditing}>
                <CheckOutlined />
              </RoundButton>
            </>
          ) : (
            <>
              <RoundButton label={t("mobile.share")} onClick={() => setShareOpen(true)}>
                <ShareAltOutlined />
              </RoundButton>
              <Menu
                buttonTitle={t("mobile.more")}
                buttonClassName="size-tap-44 flex items-center justify-center rounded-full text-xl text-gray-800 active:bg-gray-100"
                buttonContent={<MoreOutlined />}
              >
                <MenuItem onClick={() => setUsersOpen(true)}>
                  {t("usersPanel.online", { n: users.length })}
                </MenuItem>
                <MenuItem onClick={() => setShareOpen(true)}>{t("roomHeader.invite")}</MenuItem>
                <MenuItem onClick={() => !busy && void doExport()}>{t("editor.exportBtn")}</MenuItem>
                {isOwner ? (
                  <MenuItem onClick={() => onDelete(code)} className="text-red-600">
                    {t("editor.deleteBtn")}
                  </MenuItem>
                ) : (
                  <MenuItem onClick={() => onLeave(code)} className="text-red-600">
                    {t("roomHeader.leave")}
                  </MenuItem>
                )}
              </Menu>
            </>
          )}
        </div>
      </header>

      {collab.error && (
        <div className="mx-4 mb-1 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700 shrink-0">
          {COLLAB_ERROR_KEYS[collab.error] ? t(COLLAB_ERROR_KEYS[collab.error]) : collab.error}
        </div>
      )}

      <div
        className="flex-1 min-h-0 overflow-y-auto overscroll-contain"
        onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 56)}
      >
        <div className="px-5 pb-24">
          <input
            data-doc-title=""
            value={focusArea === "title" ? titleDraft : roomName}
            onFocus={() => setTitleDraft(roomName)}
            onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={commitTitle}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitTitle();
                editorRef.current?.focus();
              }
            }}
            maxLength={40}
            placeholder={t("common.unnamedDoc")}
            aria-label={t("roomHeader.roomNamePlaceholder")}
            className="w-full bg-transparent pt-2 text-[26px] leading-tight font-semibold text-gray-900 placeholder:text-gray-300 focus:outline-none"
          />
          <div className="mt-2 flex items-center gap-2 text-xs text-gray-400">
            <span>{t("mobile.nChars", { n: content.length })}</span>
            <span className="h-3 w-px bg-gray-300" />
            <button
              type="button"
              onClick={() => setUsersOpen(true)}
              className="flex items-center gap-1 min-h-tap-38 -my-2"
            >
              <span
                className={`size-1.5 rounded-full ${collab.isConnected ? "bg-green-500" : "bg-gray-300"}`}
              />
              {collab.isConnected
                ? users.length > 1
                  ? t("home.nOnline", { n: users.length })
                  : t("roomHeader.connected")
                : t("mobile.offline")}
            </button>
          </div>

          <div ref={bodyRef} className="mt-3 mobile-doc-body">
            <MobileEditorBridge value={bridge}>
              <MDXEditor
                key={code}
                ref={editorRef}
                markdown={content}
                onChange={handleChange}
                plugins={plugins}
                contentEditableClassName="focus:outline-none min-h-[50vh] text-[17px] leading-relaxed text-gray-900"
                spellCheck={false}
              />
            </MobileEditorBridge>
          </div>
        </div>
      </div>

      {/* 工具栏槽位:布局底部,键盘弹出时随视口收缩(adjustResize / resizes-content)贴在键盘上方 */}
      <div
        ref={setToolbarSlot}
        className={`shrink-0 pb-[var(--kb-safe-bottom,env(safe-area-inset-bottom))] ${focusArea === "body" ? "" : "hidden"}`}
      />

      {usersOpen && (
        <div
          data-testid="users-sheet"
          className="fixed inset-0 z-50 bg-black/40 flex items-end animate-fade-in"
          onClick={() => setUsersOpen(false)}
        >
          <div
            className="w-full max-h-[60vh] overflow-y-auto rounded-t-3xl bg-white pb-[env(safe-area-inset-bottom)] animate-sheet-up"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mx-auto mt-2 h-1 w-10 rounded-full bg-gray-200" />
            <UsersPanel users={users} />
          </div>
        </div>
      )}
      {shareOpen && (
        <QrModal
          url={buildJoinUrl(getServerBase(), code)}
          title={t("qrModal.title")}
          desc={t("qrModal.desc")}
          onClose={() => setShareOpen(false)}
        />
      )}
    </div>
  );
}

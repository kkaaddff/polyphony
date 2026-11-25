// 完整编辑器(v5,独立页 /editor):文档头 + 一张居中的稿纸。在场列表收进文档头的头像浮层。
// 移动端没有独立编辑页:扫码落地等入口统一转首页 ?open=CODE,由移动文档页接管。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router";
import { MDXEditor, type MDXEditorMethods } from "@mdxeditor/editor";
import "@mdxeditor/editor/style.css";
import "@/lib/fixTableCopy"; // 修复表格无法拷贝(给 TableNode 补 exportDOM)
import { useCollaboration } from "@/lib/useCollaboration";
import { getServerBase } from "@/lib/serverConfig";
import { upsertRecentRoom } from "@/lib/storage";
import { authFetch, clearRoomCache, useAccount } from "@/lib/auth";
import { uploadAttachment, exportDoc, deleteDoc, getDocStatus } from "@/lib/docs";
import { prepImageForUpload } from "@/lib/imagePrep";
import { useT } from "@/i18n";
import { useServerReachable } from "@/lib/connectivity";
import { createEditorPlugins } from "@/components/editorConfig";
import { DocHeader } from "@/components/DocHeader";
import type { User } from "@/types";
import { useIsMobile } from "@/lib/useIsMobile";

const UPLOAD_ERROR_KEYS: Record<string, "errors.E_NO_FILE" | "errors.E_FILE_TYPE" | "errors.E_FILE_SIZE" | "errors.E_UPLOAD"> = {
  E_NO_FILE: "errors.E_NO_FILE",
  E_FILE_TYPE: "errors.E_FILE_TYPE",
  E_FILE_SIZE: "errors.E_FILE_SIZE",
  E_UPLOAD: "errors.E_UPLOAD",
};

export default function Editor() {
  const isMobile = useIsMobile();
  const [searchParams] = useSearchParams();
  const code = searchParams.get("code")?.toUpperCase() ?? "";
  if (isMobile && code) return <Navigate to={`/?open=${encodeURIComponent(code)}`} replace />;
  return <EditorPage />;
}

function EditorPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { t } = useT();
  const { account } = useAccount();

  const roomCode = useMemo(() => searchParams.get("code")?.toUpperCase() ?? "", [searchParams]);
  const userName = searchParams.get("name") || account?.name || t("common.anonymous");
  const [userId] = useState(() => `user-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`);

  useEffect(() => {
    if (!roomCode) navigate("/", { replace: true });
  }, [roomCode, navigate]);

  const [content, setContent] = useState("");
  const [users, setUsers] = useState<User[]>([]);
  const [roomName, setRoomName] = useState("");
  const editorRef = useRef<MDXEditorMethods | null>(null);
  const isUpdatingFromRemote = useRef(false);
  const remoteTimer = useRef<number | undefined>(undefined);
  const contentRef = useRef<string>("");

  const { isConnected, applyLocalChange, renameRoom } = useCollaboration({
    roomCode,
    userName,
    userId,
    onContentChange: (newContent) => {
      const text = newContent as string;
      if (text === contentRef.current) return;
      contentRef.current = text;
      setContent(text);
      isUpdatingFromRemote.current = true;
      editorRef.current?.setMarkdown(text);
      window.clearTimeout(remoteTimer.current);
      remoteTimer.current = window.setTimeout(() => {
        isUpdatingFromRemote.current = false;
      }, 0);
    },
    onUsersChange: setUsers,
    onRoomNameChange: setRoomName,
    onDocUnavailable: (kind) => {
      clearRoomCache(roomCode);
      alert(kind === "trashed" ? t("docs.trashedAlert") : t("docs.missingAlert"));
      navigate("/", { replace: true });
    },
  });

  // 共享房间名同步到本地「最近房间」快照与服务端房间簿,首页列表随之保鲜
  useEffect(() => {
    if (!roomCode) return;
    if (roomName) upsertRecentRoom({ code: roomCode, name: roomName });
    authFetch(`${getServerBase()}/rooms/enter`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: roomCode }),
    }).catch(() => {
      /* 登记失败不打断编辑 */
    });
  }, [roomCode, roomName]);

  const handleContentChange = useCallback(
    (markdown: string, initialMarkdownNormalize: boolean) => {
      if (!initialMarkdownNormalize && !isUpdatingFromRemote.current) {
        contentRef.current = markdown;
        setContent(markdown);
        applyLocalChange(markdown);
      }
    },
    [applyLocalChange]
  );

  const handleImageUpload = useCallback(
    async (file: File) => {
      try {
        const prep = await prepImageForUpload(file);
        if (!prep.ok) {
          throw new Error(prep.error === "gif-too-large" ? t("errors.E_FILE_SIZE") : t("editor.imagePrepFail"));
        }
        return await uploadAttachment(roomCode, prep.blob, prep.filename);
      } catch (error) {
        const code = (error as { code?: string }).code;
        const key = code ? UPLOAD_ERROR_KEYS[code] : undefined;
        const msg = (key ? t(key) : undefined) ?? (error instanceof Error ? error.message : t("editor.unknownError"));
        alert(t("editor.uploadFail", { msg }));
        throw error;
      }
    },
    [roomCode, t]
  );
  const imagePreviewHandler = useCallback(
    (src: string) => Promise.resolve(src.startsWith("/uploads/") ? getServerBase() + src : src),
    []
  );
  const plugins = useMemo(
    () => createEditorPlugins(handleImageUpload, imagePreviewHandler),
    [handleImageUpload, imagePreviewHandler]
  );

  // 所有权:进入时查一次;离线查不到就等恢复连接再查
  const [isOwner, setIsOwner] = useState(false);
  const reachable = useServerReachable();
  useEffect(() => {
    if (!roomCode || reachable === false) return;
    getDocStatus(roomCode)
      .then((st) => setIsOwner(st.status === "active" && st.isOwner))
      .catch(() => {
        /* 离线/超时:保持现值,恢复连接后重查 */
      });
  }, [roomCode, reachable]);

  const [docBusy, setDocBusy] = useState(false);
  const doExport = async () => {
    setDocBusy(true);
    try {
      const url = await exportDoc(roomCode);
      window.location.assign(`${getServerBase()}${url}`);
    } catch {
      alert(t("docs.createFail"));
    } finally {
      setDocBusy(false);
    }
  };
  const doDelete = async () => {
    if (!window.confirm(t("docs.deleteConfirm", { name: roomName || t("common.unnamedDoc") }))) return;
    setDocBusy(true);
    try {
      await deleteDoc(roomCode);
      clearRoomCache(roomCode);
      navigate("/", { replace: true });
    } catch {
      alert(t("docs.deleteFail"));
    } finally {
      setDocBusy(false);
    }
  };

  if (!roomCode) return null;

  return (
    <div className="flex h-dvh box-border flex-col bg-paper pt-[env(safe-area-inset-top)]">
      <DocHeader
        roomCode={roomCode}
        roomName={roomName}
        isConnected={isConnected}
        users={users}
        charCount={content.length}
        onRename={renameRoom}
        variant="editor"
        isOwner={isOwner}
        busy={docBusy}
        onExport={() => void doExport()}
        onDelete={() => void doDelete()}
        onLeave={() => navigate("/")}
      />
      <div className="flex min-h-0 flex-1 justify-center px-5 pb-5">
        <div className="flex min-h-0 w-full max-w-[920px] flex-col overflow-hidden rounded-14 bg-sheet shadow-md">
          <div className="doc-body mdx-theme thin-scroll min-h-0 flex-1 overflow-y-auto">
            <MDXEditor
              ref={editorRef}
              markdown={content}
              onChange={handleContentChange}
              plugins={plugins}
              contentEditableClassName="focus:outline-none"
              spellCheck={true}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

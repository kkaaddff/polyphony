// 首页右栏「稿纸」(v5):选中文档后原地展示可编辑内容。文档头(标题/分享/在场)+ 一张白色稿纸。
// 协同逻辑与完整编辑器一致:远端更新经 setMarkdown 推入,本地编辑走 applyLocalChange。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { MDXEditor, type MDXEditorMethods } from "@mdxeditor/editor";
import "@mdxeditor/editor/style.css";
import "@/lib/fixTableCopy";
import { DocHeader } from "@/components/DocHeader";
import { createEditorPlugins } from "@/components/editorConfig";
import { useShell } from "@/components/shellContext";
import { useCollaboration } from "@/lib/useCollaboration";
import { exportDoc, deleteDoc, getDocStatus, uploadAttachment } from "@/lib/docs";
import { getServerBase } from "@/lib/serverConfig";
import { prepImageForUpload } from "@/lib/imagePrep";
import { useT } from "@/i18n";
import { useServerReachable } from "@/lib/connectivity";
import type { User } from "@/types";

const UPLOAD_ERROR_KEYS: Record<string, "errors.E_NO_FILE" | "errors.E_FILE_TYPE" | "errors.E_FILE_SIZE" | "errors.E_UPLOAD"> = {
  E_NO_FILE: "errors.E_NO_FILE",
  E_FILE_TYPE: "errors.E_FILE_TYPE",
  E_FILE_SIZE: "errors.E_FILE_SIZE",
  E_UPLOAD: "errors.E_UPLOAD",
};

interface DocPaneProps {
  code: string;
  userName: string;
  userId: string;
  onClose: () => void;
  onUnavailable: (code: string, kind: "missing" | "trashed") => void;
}

export function DocPane({ code, userName, userId, onClose, onUnavailable }: DocPaneProps) {
  const { t } = useT();
  const navigate = useNavigate();
  const { seed, setSeed } = useShell();
  const [content, setContent] = useState("");
  const [users, setUsers] = useState<User[]>([]);
  const [roomName, setRoomName] = useState("");
  const [isOwner, setIsOwner] = useState(false);
  const [docBusy, setDocBusy] = useState(false);

  const handleImageUpload = useCallback(
    async (file: File) => {
      try {
        const prep = await prepImageForUpload(file);
        if (!prep.ok) {
          throw new Error(prep.error === "gif-too-large" ? t("errors.E_FILE_SIZE") : t("editor.imagePrepFail"));
        }
        return await uploadAttachment(code, prep.blob, prep.filename);
      } catch (error) {
        const errCode = (error as { code?: string }).code;
        const key = errCode ? UPLOAD_ERROR_KEYS[errCode] : undefined;
        const msg = (key ? t(key) : undefined) ?? (error instanceof Error ? error.message : t("editor.unknownError"));
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
    () => createEditorPlugins(handleImageUpload, imagePreviewHandler),
    [handleImageUpload, imagePreviewHandler]
  );

  // 所有权:进入时查一次;离线查不到就等恢复连接再查
  const reachable = useServerReachable();
  useEffect(() => {
    if (reachable === false) return;
    getDocStatus(code)
      .then((s) => setIsOwner(s.status === "active" && s.isOwner))
      .catch(() => {
        /* 离线/超时:保持现值,恢复连接后重查 */
      });
  }, [code, reachable]);

  const onDocUnavailable = useCallback(
    (kind: "missing" | "trashed") => {
      localStorage.removeItem(`polyphony-room-${code}`);
      onUnavailable(code, kind);
    },
    [code, onUnavailable]
  );

  // MDXEditor 的 markdown 属性只在挂载时读一次:之后的内容必须经 ref.setMarkdown 写进编辑器,
  // 否则在空白/过期的编辑器里敲一个字就会按 diff 把全文删掉。与 Editor / MobileDocView 同一套写法。
  const editorRef = useRef<MDXEditorMethods | null>(null);
  const contentRef = useRef("");
  const fromRemote = useRef(false);
  const remoteTimer = useRef<number | undefined>(undefined);

  const collab = useCollaboration({
    roomCode: code,
    userName,
    userId,
    onContentChange: (next) => {
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
    onRoomNameChange: setRoomName,
    onDocUnavailable,
  });
  const { applyLocalChange } = collab;

  const handleChange = useCallback(
    (markdown: string, initialNormalize: boolean) => {
      if (initialNormalize || fromRemote.current) return;
      contentRef.current = markdown;
      setContent(markdown);
      applyLocalChange(markdown);
    },
    [applyLocalChange]
  );

  // 便签转文档:新建的空白稿纸首次同步时写入初始正文(只一次),随后清掉 seed
  const seedApplied = useRef(false);
  useEffect(() => {
    if (!seed || seed.code !== code) return;
    if (!seedApplied.current && content === "") {
      seedApplied.current = true;
      const text = seed.text;
      fromRemote.current = true;
      editorRef.current?.setMarkdown(text);
      window.clearTimeout(remoteTimer.current);
      remoteTimer.current = window.setTimeout(() => {
        fromRemote.current = false;
      }, 0);
      applyLocalChange(text);
      contentRef.current = text;
      setContent(text);
    }
    setSeed(null);
  }, [seed, code, content, applyLocalChange, setSeed]);

  const doExport = async () => {
    setDocBusy(true);
    try {
      const url = await exportDoc(code);
      window.location.assign(`${getServerBase()}${url}`);
    } catch {
      /* 忽略 */
    } finally {
      setDocBusy(false);
    }
  };

  const doDelete = async () => {
    if (!window.confirm(t("docs.deleteConfirm", { name: roomName || t("common.unnamedDoc") }))) return;
    setDocBusy(true);
    try {
      await deleteDoc(code);
      onUnavailable(code, "missing");
    } catch {
      alert(t("docs.deleteFail"));
    } finally {
      setDocBusy(false);
    }
  };

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col">
      <DocHeader
        roomCode={code}
        roomName={roomName}
        isConnected={collab.isConnected}
        users={users}
        charCount={content.length}
        onRename={collab.renameRoom}
        variant="pane"
        isOwner={isOwner}
        busy={docBusy}
        onExport={() => void doExport()}
        onDelete={() => void doDelete()}
        onLeave={onClose}
        onOpenFull={() => navigate(`/editor?code=${code}&name=${encodeURIComponent(userName)}`)}
      />
      {/* 稿纸:居中、限宽,工具栏吸顶,正文内滚 */}
      <div className="flex min-h-0 flex-1 justify-center px-5 pb-5">
        <div className="flex min-h-0 w-full max-w-[920px] flex-col overflow-hidden rounded-14 bg-sheet shadow-md">
          <div className="doc-body mdx-theme thin-scroll min-h-0 flex-1 overflow-y-auto">
            <MDXEditor
              ref={editorRef}
              markdown={content}
              onChange={handleChange}
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

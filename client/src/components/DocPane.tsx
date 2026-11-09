// 首页右栏「轻量文档面板」(v4.0 联调反馈图9):
// 选中列表项后原地展示文档内容,可编辑、可改名、可邀请/导出——完整编辑器的精简版。
// 用户列表做成右上角可展开/折叠的悬浮徽标。WS 连接随 code 动态建立/销毁。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { MDXEditor, type MDXEditorMethods } from "@mdxeditor/editor";
import { RoomHeader } from "@/components/RoomHeader";
import { UsersPanel } from "@/components/UsersPanel";
import { createEditorPlugins } from "@/components/editorConfig";
import { useCollaboration } from "@/lib/useCollaboration";
import { exportDoc, deleteDoc, getDocStatus } from "@/lib/docs";
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
  const [content, setContent] = useState("");
  const [users, setUsers] = useState<User[]>([]);
  const [roomName, setRoomName] = useState("");
  const [usersOpen, setUsersOpen] = useState(false);
  const [isOwner, setIsOwner] = useState(false);
  const [docBusy, setDocBusy] = useState(false);

  const handleImageUpload = useCallback(
    async (image: File) => {
      const prep = await prepImageForUpload(image);
      if (!prep.ok) throw new Error(t("editor.imagePrepFail"));
      const resp = await fetch(`${getServerBase()}/docs/${code}/attachments`, {
        method: "POST",
        headers: { Authorization: `Bearer ${localStorage.getItem("polyphony.token") ?? ""}` },
        body: prep.blob,
      });
      const data = (await resp.json().catch(() => ({}))) as {
        url?: string;
        error?: string;
        code?: string;
      };
      if (!resp.ok) {
        const key = data.code ? UPLOAD_ERROR_KEYS[data.code] : undefined;
        throw new Error(key ? t(key) : (data.error ?? t("editor.uploadFail", { msg: resp.status })));
      }
      return data.url ?? "";
    },
    [code, t]
  );

  const imagePreviewHandler = useCallback(
    (src: string) =>
      Promise.resolve(src.startsWith("/uploads/") ? getServerBase() + src : src),
    []
  );

  const plugins = useMemo(
    () => createEditorPlugins(handleImageUpload, imagePreviewHandler),
    [handleImageUpload, imagePreviewHandler]
  );

  // 顶栏 👥 菜单的「在线用户」→ 打开用户面板(此前 DocPane 另有一套悬浮徽标,重复,已合并)
  useEffect(() => {
    const open = () => setUsersOpen(true);
    window.addEventListener("polyphony:open-users", open);
    return () => window.removeEventListener("polyphony:open-users", open);
  }, []);

  // 所有权:进入时查一次;离线查不到就等恢复连接再查(否则离线打开的文档一直缺「删除」入口)
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

  // MDXEditor 的 markdown 属性只在挂载时读一次:之后的内容(服务端首次同步、他人输入)必须经
  // ref.setMarkdown 写进编辑器。此前直接 onContentChange: setContent,面板打开后就再也看不到
  // 新内容——而 applyLocalChange 按「真实正文 vs 编辑器内容」做 diff,在空白/过期的编辑器里
  // 敲一个字就会把全文删掉,对所有人生效。与 Editor.tsx / MobileDocView 同一套写法。
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
      // fromRemote 只用来忽略 setMarkdown 自身的 onChange 回声,远端更新本身一律写入
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
    <div className="w-full flex-1 flex flex-col min-h-0 bg-gray-50 dark:bg-gray-900">
      <RoomHeader
        roomCode={code}
        roomName={roomName}
        isConnected={collab.isConnected}
        userCount={users.length}
        onRename={collab.renameRoom}
        onLeave={onClose}
        actions={
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap">
              {t("editor.charCount", { n: content.length })}
            </span>
            <button
              onClick={() => void doExport()}
              disabled={docBusy}
              className="px-2 py-1 rounded border border-gray-300 dark:border-gray-600 text-xs text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
            >
              {t("editor.exportBtn")}
            </button>
            {isOwner && (
              <button
                onClick={() => void doDelete()}
                disabled={docBusy}
                className="px-2 py-1 rounded border border-red-300 text-xs text-red-600 hover:bg-red-50 disabled:opacity-50"
              >
                {t("editor.deleteBtn")}
              </button>
            )}
            <button
              onClick={() => navigate(`/editor?code=${code}&name=${encodeURIComponent(userName)}`)}
              className="px-2 py-1 rounded border border-gray-300 dark:border-gray-600 text-xs text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 whitespace-nowrap"
            >
              {t("docPane.openFull")}
            </button>
          </div>
        }
      />

      {/* 编辑区(相对定位承载悬浮用户列表) */}
      <div className="relative flex-1 min-h-0 flex flex-col p-3 md:p-4">
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-lg flex-1 overflow-hidden flex flex-col">
          <div className="flex-1 overflow-auto">
            <MDXEditor
              ref={editorRef}
              markdown={content}
              onChange={handleChange}
              plugins={plugins}
              contentEditableClassName="focus:outline-none min-h-[300px] p-4 text-gray-900 dark:text-gray-100"
            />
          </div>
        </div>
      </div>

      {/* 在线用户面板(顶栏 👥 菜单触发;移动端底部抽屉,桌面居中卡片) */}
      {usersOpen && (
        <div
          className="fixed inset-0 z-50 bg-black/40 flex items-end md:items-center md:justify-center"
          onClick={() => setUsersOpen(false)}
        >
          <div
            className="w-full md:max-w-sm max-h-[70vh] overflow-y-auto rounded-t-2xl md:rounded-2xl bg-white"
            onClick={(e) => e.stopPropagation()}
          >
            <UsersPanel users={users} />
            <div className="p-3 border-t border-gray-100">
              <button
                onClick={() => setUsersOpen(false)}
                className="w-full py-2 rounded-lg bg-gray-900 text-white text-sm font-medium"
              >
                {t("common.close")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// 首页右栏「轻量文档面板」(v4.0 联调反馈图9):
// 选中列表项后原地展示文档内容,可编辑、可改名、可邀请/导出——完整编辑器的精简版。
// 用户列表做成右上角可展开/折叠的悬浮徽标。WS 连接随 code 动态建立/销毁。
import { useCallback, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { MDXEditor } from "@mdxeditor/editor";
import { RoomHeader } from "@/components/RoomHeader";
import { createEditorPlugins } from "@/components/editorConfig";
import { useCollaboration } from "@/lib/useCollaboration";
import { exportDoc, deleteDoc, getDocStatus } from "@/lib/docs";
import { getServerBase } from "@/lib/serverConfig";
import { prepImageForUpload } from "@/lib/imagePrep";
import { useT } from "@/i18n";
import type { User } from "@/types";

const UPLOAD_ERROR_KEYS: Record<string, "errors.E_NO_FILE" | "errors.E_FILE_TYPE" | "errors.E_FILE_SIZE" | "errors.E_UPLOAD"> = {
  E_NO_FILE: "errors.E_NO_FILE",
  E_FILE_TYPE: "errors.E_FILE_TYPE",
  E_FILE_SIZE: "errors.E_FILE_SIZE",
  E_UPLOAD: "errors.E_UPLOAD",
};

const COLLAB_ERROR_KEYS: Record<string, "editor.collabError" | "editor.connectionClosed"> = {
  ERR_COLLAB_CONNECT: "editor.collabError",
  ERR_CONNECTION_CLOSED: "editor.connectionClosed",
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

  // 所有权进入时查一次
  useMemo(() => {
    getDocStatus(code)
      .then((s) => setIsOwner(s.isOwner))
      .catch(() => setIsOwner(false));
  }, [code]);

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
    onContentChange: setContent,
    onUsersChange: setUsers,
    onRoomNameChange: setRoomName,
    onDocUnavailable,
  });

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
    if (!window.confirm(t("docs.deleteConfirm", { code }))) return;
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

      {collab.error && (
        <div className="bg-red-50 dark:bg-red-900/20 border-l-4 border-red-500 px-4 py-2">
          <p className="text-sm text-red-700 dark:text-red-400">
            {COLLAB_ERROR_KEYS[collab.error] ? t(COLLAB_ERROR_KEYS[collab.error]) : collab.error}
          </p>
        </div>
      )}

      {/* 编辑区(相对定位承载悬浮用户列表) */}
      <div className="relative flex-1 min-h-0 flex flex-col p-3 md:p-4">
        {/* 悬浮用户列表:右上角,可展开/折叠(图9 反馈) */}
        <div className="absolute top-2 right-3 z-10 flex justify-end">
          {usersOpen ? (
            <div className="rounded-xl bg-white dark:bg-gray-800 shadow-xl border border-gray-200 dark:border-gray-700 px-4 py-3 w-56">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-medium text-gray-700 dark:text-gray-300">
                  {t("usersPanel.online", { n: users.length })}
                </span>
                <button
                  onClick={() => setUsersOpen(false)}
                  className="text-xs text-gray-400 hover:text-gray-600"
                  title={t("common.close")}
                >
                  ▾
                </button>
              </div>
              <ul className="space-y-1.5">
                {users.map((u) => (
                  <li key={u.id} className="flex items-center gap-2 text-sm">
                    <span
                      className="size-3 rounded-full shrink-0"
                      style={{ backgroundColor: u.color }}
                    />
                    <span className="truncate text-gray-700 dark:text-gray-300">{u.name}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <button
              onClick={() => setUsersOpen(true)}
              className="rounded-full bg-white dark:bg-gray-800 shadow-lg border border-gray-200 dark:border-gray-700 px-3 py-1.5 text-xs text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
              title={t("usersPanel.online", { n: users.length })}
            >
              👥 {users.length} ▴
            </button>
          )}
        </div>

        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-lg flex-1 overflow-hidden flex flex-col">
          <div className="flex-1 overflow-auto">
            <MDXEditor
              key={code}
              markdown={content}
              onChange={collab.applyLocalChange}
              plugins={plugins}
              contentEditableClassName="focus:outline-none min-h-[300px] p-4 text-gray-900 dark:text-gray-100"
            />
          </div>
        </div>
      </div>
    </div>
  );
}

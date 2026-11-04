// 文档生命周期客户端(docs/document-lifecycle.md §4.3/§4.8)。
import { authFetch } from "@/lib/auth";
import { getServerBase } from "@/lib/serverConfig";

export type DocStatus = "active" | "trashed" | "missing";
export type TrashReason = "owner" | "inactive" | "account_deleted";

async function throwCoded(res: Response): Promise<never> {
  const data = (await res.json().catch(() => ({}))) as { code?: string; error?: string };
  const err = new Error(data.error || `HTTP ${res.status}`) as Error & { code?: string };
  err.code = data.code;
  throw err;
}

/** 新建:服务端生成码,创建者即所有者。 */
export async function createDoc(): Promise<{ code: string }> {
  const res = await authFetch(`${getServerBase()}/docs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  if (!res.ok) await throwCoded(res);
  return res.json();
}

/** 进入前检查:missing 不区分 purged/不存在;不再隐式创建。 */
export async function getDocStatus(
  code: string
): Promise<{ status: DocStatus; isOwner: boolean; name: string }> {
  const res = await authFetch(
    `${getServerBase()}/docs/${encodeURIComponent(code.toUpperCase())}`
  );
  if (!res.ok) await throwCoded(res);
  return res.json();
}

export async function deleteDoc(code: string): Promise<void> {
  const res = await authFetch(`${getServerBase()}/docs/${encodeURIComponent(code)}`, {
    method: "DELETE",
  });
  if (!res.ok) await throwCoded(res);
}

export async function restoreDoc(code: string): Promise<void> {
  const res = await authFetch(`${getServerBase()}/docs/${encodeURIComponent(code)}/restore`, {
    method: "POST",
  });
  if (!res.ok) await throwCoded(res);
}

export async function purgeDoc(code: string): Promise<void> {
  const res = await authFetch(`${getServerBase()}/docs/${encodeURIComponent(code)}/purge`, {
    method: "POST",
  });
  if (!res.ok) await throwCoded(res);
}

export type TrashEntry = {
  code: string;
  name: string;
  trashReason: TrashReason | null;
  trashedAt: number;
  purgeAt: number;
};

export async function fetchTrash(): Promise<TrashEntry[]> {
  const res = await authFetch(`${getServerBase()}/docs/trash/list`);
  if (!res.ok) await throwCoded(res);
  const data = (await res.json()) as { docs?: TrashEntry[] };
  return Array.isArray(data.docs) ? data.docs : [];
}

/** 上传附件(客户端已重新编码,见 imagePrep);返回写入文档的相对路径。 */
export async function uploadAttachment(
  code: string,
  file: Blob,
  filename: string
): Promise<string> {
  const form = new FormData();
  form.append("image", file, filename);
  const res = await authFetch(
    `${getServerBase()}/docs/${encodeURIComponent(code)}/attachments`,
    { method: "POST", body: form }
  );
  if (!res.ok) await throwCoded(res);
  const data = (await res.json()) as { url: string };
  return data.url;
}

/** 导出:换一次性链接。Web 直接跳转下载;App 由调用方转系统浏览器。 */
export async function exportDoc(code: string): Promise<string> {
  const res = await authFetch(
    `${getServerBase()}/docs/${encodeURIComponent(code)}/export-link`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }
  );
  if (!res.ok) await throwCoded(res);
  const data = (await res.json()) as { url: string };
  return data.url;
}

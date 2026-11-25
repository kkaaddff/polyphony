// 语音便签客户端(docs/voice-input.md §6):账号级短文本流,全端共用同一份。
// 手机原生语音输入页每次「发送」追加一条;Web/桌面在便签页查看、搜索、手动追加。
import { authFetch, getToken } from "@/lib/auth";
import { getServerBase } from "@/lib/serverConfig";

export type Note = { id: string; text: string; createdAt: number; device: string };

export const NOTE_MAX_CHARS = 4000;
/** 可选的保留天数;0 = 永久 */
export const RETENTION_CHOICES = [1, 7, 30, 90, 365, 0] as const;

/** 客户端生成 id:服务端按 id 幂等,重试不会产生重复。非安全上下文(http 局域网)没有 randomUUID。 */
export function newNoteId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

async function ok(res: Response): Promise<Response> {
  if (!res.ok) throw new Error(`notes ${res.status}`);
  return res;
}

/** 新 → 旧一页;before 传上一页最后一条的 createdAt。 */
export async function fetchNotes(opts: {
  q?: string;
  before?: number;
  limit?: number;
}): Promise<{ notes: Note[]; hasMore: boolean }> {
  const params = new URLSearchParams();
  if (opts.q?.trim()) params.set("q", opts.q.trim());
  if (opts.before) params.set("before", String(opts.before));
  params.set("limit", String(opts.limit ?? 100));
  const res = await ok(await authFetch(`${getServerBase()}/notes?${params}`));
  return (await res.json()) as { notes: Note[]; hasMore: boolean };
}

export async function createNote(text: string, id = newNoteId()): Promise<Note> {
  const res = await ok(
    await authFetch(`${getServerBase()}/notes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, text }),
    })
  );
  return ((await res.json()) as { note: Note }).note;
}

export async function removeNote(id: string): Promise<void> {
  await ok(await authFetch(`${getServerBase()}/notes/${encodeURIComponent(id)}`, { method: "DELETE" }));
}

export async function fetchRetentionDays(): Promise<number> {
  const res = await ok(await authFetch(`${getServerBase()}/notes/settings`));
  return ((await res.json()) as { retentionDays: number }).retentionDays;
}

export async function saveRetentionDays(retentionDays: number): Promise<number> {
  const res = await ok(
    await authFetch(`${getServerBase()}/notes/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ retentionDays }),
    })
  );
  return ((await res.json()) as { retentionDays: number }).retentionDays;
}

/**
 * 订阅「便签有变化」信号(WS /_events,服务端只发信号不发内容):别的设备新增/删除/改保留期时回调。
 * 断线自动重连,重连成功后也回调一次(补上断线期间的变化)。返回取消函数。
 */
export function subscribeNotesChanged(onChange: () => void): () => void {
  let ws: WebSocket | null = null;
  let timer: number | undefined;
  let stopped = false;
  let retry = 1000;
  let everOpened = false;

  const connect = () => {
    if (stopped) return;
    const token = getToken();
    if (!token) return;
    let socket: WebSocket;
    try {
      socket = new WebSocket(`${getServerBase().replace(/^http/i, "ws")}/_events`, ["polyphony.v1", `auth.${token}`]);
    } catch {
      timer = window.setTimeout(connect, 15000);
      return;
    }
    ws = socket;
    socket.onopen = () => {
      retry = 1000;
      if (everOpened) onChange();
      everOpened = true;
    };
    socket.onmessage = (ev) => {
      try {
        if ((JSON.parse(String(ev.data)) as { type?: string }).type === "notes.changed") onChange();
      } catch {
        /* 忽略坏帧 */
      }
    };
    socket.onclose = (ev) => {
      if (ws === socket) ws = null;
      if (stopped || ev.code === 4001) return;
      timer = window.setTimeout(connect, retry);
      retry = Math.min(retry * 2, 15000);
    };
  };
  connect();

  return () => {
    stopped = true;
    window.clearTimeout(timer);
    ws?.close();
  };
}

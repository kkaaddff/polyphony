// 统一接收入口(docs/identity-and-sharing.md §4.6):「扫码或粘贴链接」的结果分派。
// 一条通道(URL),三种能力:join(进房)/pair(登录)/server(分享本站)。
// 吸收原 qr.ts 的 parseJoinPayload/parsePairPayload;qr.ts 只留构造与渲染。
export type Intake =
  | { type: "join"; server?: string; code: string }
  | { type: "pair"; server?: string; code: string }
  | { type: "server"; server: string };

const URL_RE = /https?:\/\/[^\s<>"')\]]+/i;

function normalizePath(u: URL): string {
  return u.pathname.replace(/\/+$/, "") || "/";
}

/**
 * 解析扫码/粘贴文本:取文本中第一个 URL;另接受裸 8 位房间码(手输习惯)。
 * 识别不了返回 null。
 */
export function parseIntake(text: string): Intake | null {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return null;

  // 裸房间码 → 进房(不带 server,走当前配置)
  if (/^[A-Z0-9]{8}$/i.test(trimmed)) {
    return { type: "join", code: trimmed.toUpperCase() };
  }

  const urlMatch = trimmed.match(URL_RE);
  if (!urlMatch) return null;
  try {
    const u = new URL(urlMatch[0]);
    const path = normalizePath(u);
    const code = u.searchParams.get("code") ?? "";
    const server = u.searchParams.get("server") || undefined;
    if (path === "/pair" && code) return { type: "pair", code, server };
    if (code) return { type: "join", code: code.toUpperCase().slice(0, 8), server };
    return { type: "server", server: u.origin };
  } catch {
    return null;
  }
}

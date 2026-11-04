// 配对登录客户端:两端两类调用方(docs/pairing-login.md §4.2)。
// 发起端(Web/桌面,已登录):create/status/confirm/cancel,走 authFetch;
// 接收端(手机扫码/落地页,未登录):info/claim/poll,plain fetch 到 QR/链接携带的 server。
// 服务端错误码(E_PAIR_*)透传到 err.code,由渲染层 i18n 映射。
import { authFetch, getToken } from "@/lib/auth";
import { getServerBase } from "@/lib/serverConfig";

export type PairKind = "qr" | "link";
export type PairStatus =
  | "pending"
  | "claimed"
  | "approved"
  | "denied"
  | "cancelled"
  | "consumed";

export type PairingInfo = {
  code: string;
  kind: PairKind;
  status: PairStatus;
  expiresAt: number;
  claimedMeta: { ua: string; at: number } | null;
};

/** 剩余时长 mm:ss(配对 TTL 最长 60 分钟,不需要小时位)。 */
export function formatRemain(expiresAt: number, now = Date.now()): string {
  const s = Math.max(0, Math.ceil((expiresAt - now) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** UA → 「Chrome · Android」式短标签,供确认界面人工核对设备。 */
export function shortenUa(ua: string): string {
  const os = /android/i.test(ua)
    ? "Android"
    : /iphone|ipad|ios/i.test(ua)
      ? "iOS"
      : /mac os x/i.test(ua)
        ? "macOS"
        : /windows/i.test(ua)
          ? "Windows"
          : /linux/i.test(ua)
            ? "Linux"
            : "";
  const browser = /edg\//i.test(ua)
    ? "Edge"
    : /firefox/i.test(ua)
      ? "Firefox"
      : /chrome|chromium|webview/i.test(ua)
        ? "Chrome"
        : /safari/i.test(ua)
          ? "Safari"
          : "";
  return [browser, os].filter(Boolean).join(" · ") || "Unknown";
}

async function throwCoded(res: Response): Promise<never> {
  const data = (await res.json().catch(() => ({}))) as { code?: string; error?: string };
  const err = new Error(data.error || `HTTP ${res.status}`) as Error & { code?: string };
  err.code = data.code;
  throw err;
}

// ---------- 发起端(owner,需登录) ----------

export async function createPairing(
  kind: PairKind,
  ttlMinutes?: number
): Promise<{ code: string; kind: PairKind; expiresAt: number }> {
  const res = await authFetch(`${getServerBase()}/auth/pair/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind, ttlMinutes }),
  });
  if (!res.ok) return throwCoded(res);
  return res.json();
}

export async function fetchPairings(): Promise<PairingInfo[]> {
  const res = await authFetch(`${getServerBase()}/auth/pair/status`);
  if (!res.ok) return throwCoded(res);
  const data = (await res.json()) as { pairings?: PairingInfo[] };
  return Array.isArray(data.pairings) ? data.pairings : [];
}

/** 确认/拒绝:accept 时附上本端持有的明文 token,由服务端短暂中转给手机(D3)。 */
export async function confirmPairing(
  code: string,
  accept: boolean
): Promise<{ status: PairStatus }> {
  const res = await authFetch(`${getServerBase()}/auth/pair/confirm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, accept, token: accept ? getToken() : undefined }),
  });
  if (!res.ok) return throwCoded(res);
  return res.json();
}

export async function cancelPairing(code: string): Promise<{ status: PairStatus }> {
  const res = await authFetch(`${getServerBase()}/auth/pair/cancel`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  if (!res.ok) return throwCoded(res);
  return res.json();
}

// ---------- 接收端(未登录,目标服务器来自 QR/链接) ----------

export async function pairInfo(
  base: string,
  code: string
): Promise<{ status: PairStatus; accountName: string; kind: PairKind; expiresAt: number }> {
  const res = await fetch(`${base}/auth/pair/info?code=${encodeURIComponent(code)}`);
  if (!res.ok) return throwCoded(res);
  return res.json();
}

export async function claimPairing(
  base: string,
  code: string
): Promise<{ claimKey: string; accountName: string; expiresAt: number }> {
  const res = await fetch(`${base}/auth/pair/claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  if (!res.ok) return throwCoded(res);
  return res.json();
}

export async function pollPairing(
  base: string,
  code: string,
  claimKey: string
): Promise<
  | { status: "claimed" | "denied" | "cancelled" }
  | { status: "approved"; token: string; account: { id: string; name: string } }
> {
  const res = await fetch(`${base}/auth/pair/poll`, {
    method: "POST", // D15:claimKey 不进 URL;含 token 的响应不可被缓存
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, key: claimKey }),
  });
  if (!res.ok) return throwCoded(res);
  return res.json();
}

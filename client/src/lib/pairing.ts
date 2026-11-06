// 配对 v2 客户端(docs/identity-and-sharing.md §4.4):
// 双向(push=已登录端出码/链接,pull=新设备本机码);新设备本地生成 secret,
// claim/request 时提交一次;approve 即写入设备;轮询幂等且不含任何秘密。
import { authFetch, newDeviceSecret, assembleToken, setToken, getToken } from "@/lib/auth";
import { getServerBase } from "@/lib/serverConfig";
import { platformInfo } from "@/platform";

export type PairDirection = "push" | "pull";
/** 配对 TTL 档(分钟):一个配对码同时用于扫码与链接,与服务端保持一致。 */
export const LINK_TTL_MINUTES: number[] = [5, 15, 30, 60];
export type PairStatus = "pending" | "claimed" | "approved" | "denied" | "cancelled";

export type PairingInfo = {
  code: string;
  direction: PairDirection;
  status: PairStatus;
  accountName: string | null;
  newcomerLabel: string | null;
  createdAt: number;
  expiresAt: number;
  decidedAt: number | null;
  /** 「✓ 该设备已登录」以新设备首次上线为准(取代 v1 consumed) */
  deviceOnline?: boolean;
};

/** 剩余时长 mm:ss(配对 TTL 最长 60 分钟,不需要小时位)。 */
export function formatRemain(expiresAt: number, now = Date.now()): string {
  const s = Math.max(0, Math.ceil((expiresAt - now) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

async function throwCoded(res: Response): Promise<never> {
  const data = (await res.json().catch(() => ({}))) as { code?: string; error?: string };
  const err = new Error(data.error || `HTTP ${res.status}`) as Error & { code?: string };
  err.code = data.code;
  throw err;
}

// ---------- 发起端(已登录,任一设备) ----------

export async function createPushPairing(
  ttlMinutes?: number
): Promise<{ code: string; expiresAt: number }> {
  const res = await authFetch(`${getServerBase()}/auth/pair/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ttlMinutes }),
  });
  if (!res.ok) await throwCoded(res);
  return res.json();
}

export async function fetchPairings(): Promise<PairingInfo[]> {
  const res = await authFetch(`${getServerBase()}/auth/pair/status`);
  if (!res.ok) await throwCoded(res);
  const data = (await res.json()) as { pairings?: PairingInfo[] };
  return Array.isArray(data.pairings) ? data.pairings : [];
}

/** 批准/拒绝(pull 码也走这里:批准即把新设备写入本账号)。 */
export async function approvePairing(code: string, accept: boolean): Promise<{ status: PairStatus }> {
  const res = await authFetch(`${getServerBase()}/auth/pair/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, accept }),
  });
  if (!res.ok) await throwCoded(res);
  return res.json();
}

/** 撤销(push 发起账号;approved 记录撤销时连带吊销已写入设备)。 */
export async function cancelPairing(code: string): Promise<{ status: PairStatus }> {
  const res = await authFetch(`${getServerBase()}/auth/pair/cancel`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  if (!res.ok) await throwCoded(res);
  return res.json();
}

// ---------- 新设备(未登录,目标服务器来自 QR/链接/欢迎页配置) ----------

export type PairInfo =
  | { direction: "push"; status: PairStatus; accountName: string; expiresAt: number }
  | { direction: "pull"; status: PairStatus; newcomerLabel: string | null; expiresAt: number };

export async function pairInfo(base: string, code: string): Promise<PairInfo> {
  const res = await fetch(`${base}/auth/pair/info?code=${encodeURIComponent(code)}`);
  if (!res.ok) await throwCoded(res);
  return res.json();
}

/** push 认领:本地生成 secret 提交,拿 deviceId(轮询凭据拼装件)。 */
export async function claimPairing(
  base: string,
  code: string
): Promise<{ deviceId: string; accountName: string; expiresAt: number; secret: string }> {
  const secret = newDeviceSecret();
  const res = await fetch(`${base}/auth/pair/claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, secret, platform: platformInfo() }),
  });
  if (!res.ok) await throwCoded(res);
  const data = (await res.json()) as { deviceId: string; accountName: string; expiresAt: number };
  return { ...data, secret };
}

/** pull 发起:本机二维码(欢迎页);返回的 code 进 QR,dataId+secret 留在本地。 */
export async function requestPullPairing(
  base: string
): Promise<{ code: string; deviceId: string; secret: string; expiresAt: number }> {
  const secret = newDeviceSecret();
  const res = await fetch(`${base}/auth/pair/request`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ secret, platform: platformInfo() }),
  });
  if (!res.ok) await throwCoded(res);
  const data = (await res.json()) as { code: string; deviceId: string; expiresAt: number };
  return { ...data, secret };
}

/** 轮询(幂等、无秘密):approved → 本地拼凭据即完成登录。 */
export async function pollPairing(
  base: string,
  code: string,
  deviceId: string
): Promise<{ status: PairStatus; accountName?: string }> {
  const res = await fetch(`${base}/auth/pair/poll`, {
    method: "POST", // D15:不进 URL;状态响应同样不可缓存
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, deviceId }),
  });
  if (!res.ok) await throwCoded(res);
  return res.json();
}

/**
 * approved 后的收尾:拼凭据 → /auth/me 验证(网络抖动不阻断)。
 * 返回登录用的 token(已 setToken)。
 */
export async function finalizePairing(
  base: string,
  deviceId: string,
  secret: string
): Promise<string> {
  const token = assembleToken(deviceId, secret);
  setToken(token);
  try {
    await fetch(`${base}/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
  } catch {
    /* 网络抖动不阻断;后续任何请求失败会走 401 清理 */
  }
  return token;
}

/** 供调试/日志:当前凭据是否已就绪(不暴露 secret)。 */
export function hasCredential(): boolean {
  return getToken().startsWith("poly_d_");
}

// 账号鉴权客户端(v4):设备凭据 = poly_d_<deviceId>_<secret>,secret 由本机生成,
// 服务端只存哈希、从不下发(docs/identity-and-sharing.md §4.1/§4.6)。
// 凭据存 localStorage;HTTP 一律走 authFetch(Bearer),WS 由 useCollaboration 子协议注入。
import { useCallback, useEffect, useState } from "react";
import { getServerBase, saveServer } from "@/lib/serverConfig";
import { platformInfo } from "@/platform";

const TOKEN_KEY = "polyphony.token";
// 离线快照:上次在线校验通过的账号 / 房间簿,绑定到当时的设备凭据(换号、重新配对不串号)。
// 离线冷启动时用它们展示身份与文档列表——否则顶栏是「匿名用户」、列表为空、文档也打不开。
const ACCOUNT_CACHE_KEY = "polyphony.account";
const ROOMS_CACHE_KEY = "polyphony.roomsCache";
const UUID_RE = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

export type Account = { id: string; name: string };

// ---------- 本地秘密与凭据拼装 ----------

/** 生成 48 hex(24 字节)设备秘密。getRandomValues 在非安全上下文同样可用。 */
export function newDeviceSecret(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function assembleToken(deviceId: string, secret: string): string {
  return `poly_d_${deviceId}_${secret}`;
}

export function parseCredential(
  token: string
): { deviceId: string; secret: string } | null {
  const m = token.match(new RegExp(`^poly_d_(${UUID_RE})_([0-9a-f]{48})$`));
  return m ? { deviceId: m[1], secret: m[2] } : null;
}

// ---------- 存取 ----------

export function getToken(): string {
  try {
    return window.localStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

export function setToken(token: string): void {
  try {
    window.localStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* 忽略(隐私模式) */
  }
}

export function clearToken(): void {
  try {
    window.localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* 忽略 */
  }
}

// ---------- 离线快照(绑定设备凭据) ----------

function currentDeviceId(): string {
  return parseCredential(getToken())?.deviceId ?? "";
}

function readSnapshot<T>(key: string): T | null {
  const deviceId = currentDeviceId();
  if (!deviceId) return null;
  try {
    const raw = window.localStorage.getItem(key);
    const snap = raw ? (JSON.parse(raw) as { deviceId?: string; value?: T }) : null;
    return snap?.deviceId === deviceId && snap.value !== undefined ? snap.value : null;
  } catch {
    return null;
  }
}

function writeSnapshot<T>(key: string, value: T): void {
  const deviceId = currentDeviceId();
  if (!deviceId) return;
  try {
    window.localStorage.setItem(key, JSON.stringify({ deviceId, value }));
  } catch {
    /* 存储满/隐私模式:只是少了离线快照 */
  }
}

/** 上次在线拉到的房间簿(离线冷启动展示用;调用方自行把在线人数归零)。 */
export function readCachedRooms<T>(): T[] | null {
  return readSnapshot<T[]>(ROOMS_CACHE_KEY);
}

export function cacheRooms<T>(rooms: T[]): void {
  writeSnapshot(ROOMS_CACHE_KEY, rooms);
}

/** 清全部本地数据:凭据 + 文档缓存(IndexedDB)+ 最近房间 + 离线快照。退出登录/注销/清理 v3 残留共用。 */
export function clearAllLocalData(): void {
  clearToken();
  try {
    window.localStorage.removeItem("polyphony.recentRooms");
    window.localStorage.removeItem("polyphony.pinned");
    window.localStorage.removeItem(ACCOUNT_CACHE_KEY);
    window.localStorage.removeItem(ROOMS_CACHE_KEY);
  } catch {
    /* 忽略 */
  }
  void clearRoomCaches();
}

/** 删除本机全部文档缓存(polyphony-room-* IndexedDB 库)。 */
export async function clearRoomCaches(): Promise<void> {
  try {
    if (typeof indexedDB.databases === "function") {
      const dbs = await indexedDB.databases();
      for (const db of dbs) {
        if (typeof db.name === "string" && db.name.startsWith("polyphony-room-")) {
          indexedDB.deleteDatabase(db.name);
        }
      }
    } else {
      // 兜底:按最近房间列表逐个删
      let rooms: string[] = [];
      try {
        const raw = window.localStorage.getItem("polyphony.recentRooms");
        const parsed: unknown = raw ? JSON.parse(raw) : null;
        rooms = Array.isArray(parsed) ? parsed.map((r: { code?: string }) => r.code ?? "") : [];
      } catch {
        /* 无列表则放弃 */
      }
      for (const code of rooms) {
        if (code) indexedDB.deleteDatabase(`polyphony-room-${code}`);
      }
    }
  } catch {
    /* 尽力而为 */
  }
}

/** 删除单篇文档的本机缓存(退出房间时)。 */
export function clearRoomCache(code: string): void {
  try {
    indexedDB.deleteDatabase(`polyphony-room-${code}`);
  } catch {
    /* 忽略 */
  }
}

// ---------- 请求 ----------

async function codedFetch(url: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(url, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  return res;
}

async function throwCoded(res: Response, fallback: string): Promise<never> {
  const data = (await res.json().catch(() => ({}))) as {
    code?: string;
    error?: string;
    purgeAt?: number;
  };
  const err = new Error(data.error || fallback) as Error & {
    code?: string;
    purgeAt?: number;
  };
  err.code = data.code;
  err.purgeAt = data.purgeAt;
  throw err;
}

/** 带 Bearer 的 fetch;401 统一清 token 并回引导页(登录态失效只有这一种来源)。 */
export async function authFetch(input: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(input, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      Authorization: `Bearer ${getToken()}`,
    },
  });
  if (res.status === 401) {
    clearToken();
    window.location.assign("/welcome");
    throw new Error("unauthorized");
  }
  return res;
}

/** 创建账号(全端,V6):本地生成 secret;响应只含 deviceId+一次性恢复密钥。 */
export async function createAccount(
  server: string,
  name: string
): Promise<{ token: string; name: string; recoveryKey: string }> {
  saveServer(server.trim());
  const secret = newDeviceSecret();
  const res = await codedFetch(`${getServerBase()}/auth/create`, {
    method: "POST",
    body: JSON.stringify({ name, secret, platform: platformInfo() }),
  });
  if (!res.ok) await throwCoded(res, "create failed");
  const data = (await res.json()) as { deviceId: string; recoveryKey: string; name: string };
  const token = assembleToken(data.deviceId, secret);
  setToken(token);
  return { token, name: data.name, recoveryKey: data.recoveryKey };
}

/** 恢复密钥 → 兑换本机设备凭据。 */
export async function exchangeRecovery(
  server: string,
  key: string
): Promise<Account & { token: string }> {
  saveServer(server.trim());
  const secret = newDeviceSecret();
  const res = await codedFetch(`${getServerBase()}/auth/exchange`, {
    method: "POST",
    body: JSON.stringify({ key: key.trim(), secret, platform: platformInfo() }),
  });
  if (!res.ok) await throwCoded(res, "exchange failed");
  const data = (await res.json()) as { deviceId: string; name: string };
  const token = assembleToken(data.deviceId, secret);
  // 兑换成功 = 凭据有效;取账号 id 供顶栏
  const me = await fetch(`${getServerBase()}/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const acc = me.ok ? ((await me.json()) as Account) : { id: "", name: data.name };
  setToken(token);
  return { ...acc, name: data.name, token };
}

/** 撤销注销(恢复密钥,无会话;注销后本就无设备可会话)。 */
export async function restoreDeletedAccount(
  server: string,
  key: string
): Promise<Account & { token: string }> {
  saveServer(server.trim());
  const secret = newDeviceSecret();
  const res = await codedFetch(`${getServerBase()}/auth/account/restore`, {
    method: "POST",
    body: JSON.stringify({ key: key.trim(), secret, platform: platformInfo() }),
  });
  if (!res.ok) await throwCoded(res, "restore failed");
  const data = (await res.json()) as { deviceId: string; name: string };
  const token = assembleToken(data.deviceId, secret);
  setToken(token);
  return { id: "", name: data.name, token };
}

/** 服务端退出登录 = 吊销本机凭据(失败不阻断本地清理)。 */
export async function logoutRemote(): Promise<void> {
  try {
    await authFetch(`${getServerBase()}/auth/logout`, { method: "POST" });
  } catch {
    /* 网络失败时设备留在列表,可在他端吊销 */
  }
}

/** 校验凭据(登录/展示用)。 */
export async function verifyLogin(token: string): Promise<Account> {
  const res = await fetch(`${getServerBase()}/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(String(res.status));
  return (await res.json()) as Account;
}

/**
 * v3 本地残留一次性清理(应用启动时,docs/identity-and-sharing.md §4.6):
 * 存有凭据但不是 poly_d_ 格式 → 清凭据 + 全部文档缓存 + 最近房间。
 * 返回是否执行了清理(调用方据此重定向欢迎页)。
 */
export function cleanupV3Local(): boolean {
  const token = getToken();
  if (!token) return false;
  if (token.startsWith("poly_d_")) return false;
  clearAllLocalData();
  return true;
}

/**
 * 当前登录账号(供顶栏身份展示与默认用户名)。
 * 先用上次在线校验的快照(离线也是上次登录的用户,不是「匿名用户」),再联网校验刷新;
 * 服务端明确拒绝(凭据失效)才清空,网络失败保留快照。
 */
export function useAccount(): { account: Account | null; reload: () => void } {
  const [account, setAccount] = useState<Account | null>(() => readSnapshot<Account>(ACCOUNT_CACHE_KEY));

  const reload = useCallback(() => {
    const token = getToken();
    if (!token) {
      setAccount(null);
      return;
    }
    setAccount((prev) => prev ?? readSnapshot<Account>(ACCOUNT_CACHE_KEY));
    let cancelled = false;
    fetch(`${getServerBase()}/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(async (r) => {
        if (cancelled) return;
        if (r.ok) {
          const d = (await r.json()) as Account;
          writeSnapshot<Account>(ACCOUNT_CACHE_KEY, { id: d.id, name: d.name });
          setAccount(d);
        } else if (r.status === 401 || r.status === 403) {
          window.localStorage.removeItem(ACCOUNT_CACHE_KEY);
          setAccount(null);
        }
        // 其余状态(5xx/反代错误)视同暂时不可达:保留快照
      })
      .catch(() => {
        /* 网络失败(离线):保留快照里的上次登录用户 */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const cleanup = reload();
    return cleanup;
  }, [reload]);

  return { account, reload };
}

// ---------- 设备与账号管理(§4.4/§4.7,Settings 页) ----------

export type DeviceInfo = {
  id: string;
  label: string;
  createdAt: number;
  lastSeenAt: number | null;
  current: boolean;
};

export async function fetchDevices(): Promise<DeviceInfo[]> {
  const res = await authFetch(`${getServerBase()}/auth/devices`);
  if (!res.ok) await throwCoded(res, "devices failed");
  const data = (await res.json()) as { devices?: DeviceInfo[] };
  return Array.isArray(data.devices) ? data.devices : [];
}

export async function revokeDeviceById(deviceId: string): Promise<void> {
  const res = await authFetch(`${getServerBase()}/auth/devices/${encodeURIComponent(deviceId)}`, {
    method: "DELETE",
  });
  if (!res.ok) await throwCoded(res, "revoke failed");
}

export async function regenerateRecoveryKey(): Promise<string> {
  const res = await authFetch(`${getServerBase()}/auth/recovery/regenerate`, { method: "POST" });
  if (!res.ok) await throwCoded(res, "regenerate failed");
  const data = (await res.json()) as { recoveryKey: string };
  return data.recoveryKey;
}

/** 注销账号:输入账号名确认;成功后调用方清本地回欢迎页。 */
export async function deleteAccountRemote(name: string): Promise<void> {
  const res = await authFetch(`${getServerBase()}/auth/account/delete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) await throwCoded(res, "account delete failed");
}

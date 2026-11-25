// 共用工具：localStorage 预置、alert 捕获。
// v4:账号创建由本机生成 secret(服务端只存哈希、从不下发),
// helper 用 Node crypto 复刻客户端拼装 poly_d_<deviceId>_<secret>。
import { randomBytes } from "node:crypto";
import type { Page, Route, WebSocketRoute } from "@playwright/test";

export const USERNAME_KEY = "polyphony.username";
export const RECENT_ROOMS_KEY = "polyphony.recentRooms";
export const SERVER_KEY = "polyphony.server";
export const LOCALE_KEY = "polyphony.locale";
export const TOKEN_KEY = "polyphony.token";

const API = "http://localhost:3001";

export type TestAccount = { name: string; token: string; recoveryKey: string };

/** 对本地协同服务创建测试账号(名字唯一);本地生成 secret,返回拼装好的设备凭据。 */
export async function createAccount(): Promise<TestAccount> {
  const name = `e2e-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const secret = randomBytes(24).toString("hex");
  const res = await fetch(`${API}/auth/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, secret }),
  });
  if (!res.ok) throw new Error(`createAccount failed: ${res.status}`);
  const data = (await res.json()) as { deviceId: string; recoveryKey: string };
  return { name, token: `poly_d_${data.deviceId}_${secret}`, recoveryKey: data.recoveryKey };
}

/** 服务端建文档(服务端生成 8 位码,创建者即所有者)。 */
export async function createDoc(token: string, name?: string): Promise<string> {
  const res = await fetch(`${API}/docs`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error(`createDoc failed: ${res.status}`);
  return ((await res.json()) as { code: string }).code;
}

type RecentRoomSeed = { code: string; name: string; lastUsed?: number };

export async function seedStorage(
  page: Page,
  opts: {
    username?: string;
    recentRooms?: RecentRoomSeed[];
    server?: string;
    locale?: string;
    token?: string;
  }
) {
  await page.addInitScript((args) => {
    const { username, recentRooms, server, locale, token, keys } = args;
    if (username !== undefined)
      localStorage.setItem(keys.username, JSON.stringify(username));
    if (recentRooms !== undefined)
      localStorage.setItem(
        keys.recentRooms,
        JSON.stringify(
          recentRooms.map((r) => ({
            code: r.code,
            name: r.name,
            lastUsed: r.lastUsed ?? Date.now(),
          }))
        )
      );
    if (server !== undefined) localStorage.setItem(keys.server, server);
    // locale 与 username 同走 useLocalStorageState(JSON.stringify 格式),裸写会解析失败回落 auto
    if (locale !== undefined)
      localStorage.setItem(keys.locale, JSON.stringify(locale));
    // token 为裸字符串(auth.ts setToken 不做 JSON 包装)
    if (token !== undefined) localStorage.setItem(keys.token, token);
  }, {
    username: opts.username,
    recentRooms: opts.recentRooms,
    server: opts.server,
    locale: opts.locale,
    token: opts.token,
    keys: {
      username: USERNAME_KEY,
      recentRooms: RECENT_ROOMS_KEY,
      server: SERVER_KEY,
      locale: LOCALE_KEY,
      token: TOKEN_KEY,
    },
  });
}

/** 登录态快捷方式:创建测试账号并把凭据注入页面。返回账号信息。 */
export async function loginTestAccount(page: Page): Promise<TestAccount> {
  const acc = await createAccount();
  await seedStorage(page, { token: acc.token });
  return acc;
}

/** 捕获原生 alert/confirm 的文案（自动 accept）。 */
export function captureDialogs(page: Page) {
  const messages: string[] = [];
  page.on("dialog", (d) => {
    messages.push(d.message());
    void d.accept();
  });
  return messages;
}

/** 首页头像菜单 → 分享本站:打开弹层(服务器地址现只在弹层/设置里可见)。 */
export async function openShareSite(page: Page) {
  await page.getByTitle("账号菜单").click();
  await page.getByRole("menuitem", { name: "分享本站" }).click();
  const heading = page.getByRole("heading", { name: "扫码访问本站" });
  await heading.waitFor();
  return heading;
}

/**
 * 模拟服务器宕机/IP 不可达:down() 后 HTTP 请求一律挂起不回(而非立即拒绝——真机换网后正是这样,
 * 这才是「离线打不开文档」的根因),协同 WS 被断开且重连失败;up() 恢复转发。页面本身由 Vite 提供。
 */
export async function simulateOutage(page: Page) {
  let blocked = false;
  const hung = new Set<Route>();
  const sockets = new Set<WebSocketRoute>();
  await page.route(`${API}/**`, (route) => {
    if (blocked) hung.add(route);
    else void route.continue();
  });
  await page.routeWebSocket(/^ws:\/\/localhost:3001\//, (ws) => {
    if (blocked) {
      void ws.close();
      return;
    }
    ws.connectToServer();
    sockets.add(ws);
  });
  return {
    down: async () => {
      blocked = true;
      for (const ws of sockets) await ws.close();
      sockets.clear();
    },
    up: async () => {
      blocked = false;
      for (const r of hung) await r.abort("connectionrefused").catch(() => {});
      hung.clear();
    },
  };
}

// 共用工具：localStorage 预置、alert 捕获。
// 注意 username 的存储格式：Home 走 useLocalStorageState（JSON.stringify），
// recentRooms 为对象数组 —— 预置必须与真实写入格式一致。
export const USERNAME_KEY = "polyphony.username";
export const RECENT_ROOMS_KEY = "polyphony.recentRooms";
export const SERVER_KEY = "polyphony.server";
export const LOCALE_KEY = "polyphony.locale";
export const TOKEN_KEY = "polyphony.token";

const API = "http://localhost:3001";

/** 对本地协同服务创建测试账号(名字唯一);返回一次性明文 token。 */
export async function createAccount(): Promise<{ name: string; token: string }> {
  const name = `e2e-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const res = await fetch(`${API}/auth/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error(`createAccount failed: ${res.status}`);
  return (await res.json()) as { name: string; token: string };
}

type RecentRoomSeed = { code: string; name: string; lastUsed?: number };

export async function seedStorage(
  page: import("@playwright/test").Page,
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

/** 登录态快捷方式:创建测试账号并把 token 注入页面。返回账号信息。 */
export async function loginTestAccount(page: import("@playwright/test").Page) {
  const acc = await createAccount();
  await seedStorage(page, { token: acc.token });
  return acc;
}

/** 捕获原生 alert/confirm 的文案（自动 accept）。 */
export function captureDialogs(page: import("@playwright/test").Page) {
  const messages: string[] = [];
  page.on("dialog", (d) => {
    messages.push(d.message());
    void d.accept();
  });
  return messages;
}

/** 首页头像菜单 → 分享本站:打开弹层(服务器地址现只在弹层/设置里可见)。 */
export async function openShareSite(page: import("@playwright/test").Page) {
  await page.getByTitle("账号菜单").click();
  await page.getByRole("menuitem", { name: "分享本站" }).click();
  const heading = page.getByRole("heading", { name: "扫码访问本站" });
  await heading.waitFor();
  return heading;
}

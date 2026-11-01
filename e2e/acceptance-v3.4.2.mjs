// 验收截图生成器 v3.4.2 —— 复刻 acceptance-v3.4.1 的 13 个场景(PC 1440×900 / Pixel 7 仿真)。
// 前置::3001 与 :5173 已运行;产物写 local-artifacts/acceptance-v3.4.2/{pc,phone}/。
// 与 ui-*.spec 不同:这是演示/验收工具,不入测试套件,不进 CI。
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";

const BASE = "http://localhost:5173";
const API = "http://localhost:3001";
const OUT = "/Users/qc/Documents/polyphony/local-artifacts/acceptance-v3.4.2";
mkdirSync(`${OUT}/pc`, { recursive: true });
mkdirSync(`${OUT}/phone`, { recursive: true });

const TOKEN_KEY = "polyphony.token";

async function createAccount() {
  const name = `acc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
  const res = await fetch(`${API}/auth/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error(`createAccount: ${res.status}`);
  return res.json();
}

async function newCtx(browser, { token, mobile = false } = {}) {
  const ctx = await browser.newContext(
    mobile
      ? {
          viewport: { width: 412, height: 915 },
          deviceScaleFactor: 2,
          isMobile: true,
          hasTouch: true,
          locale: "zh-CN",
          permissions: ["clipboard-read", "clipboard-write"],
        }
      : {
          viewport: { width: 1440, height: 900 },
          locale: "zh-CN",
          permissions: ["clipboard-read", "clipboard-write"],
        }
  );
  if (token)
    await ctx.addInitScript(
      ([k, t]) => localStorage.setItem(k, t),
      [TOKEN_KEY, token]
    );
  const page = await ctx.newPage();
  return { ctx, page };
}

const shot = (page, name) => page.screenshot({ path: `${OUT}/${name}`, fullPage: false });

async function waitEditor(page) {
  await page.locator('[contenteditable="true"]').first().waitFor({ timeout: 20_000 });
  await page.getByText("已连接").first().waitFor({ timeout: 20_000 });
  await page.waitForTimeout(600); // 首帧渲染稳定
}

async function roomCodeOf(page) {
  const m = page.url().match(/code=([A-Za-z0-9]+)/);
  if (!m) throw new Error(`no code in url: ${page.url()}`);
  return m[1].toUpperCase();
}

const browser = await chromium.launch({ channel: "chrome", headless: true });

try {
  /* ============ PC(1440×900)============ */
  // 01 未登录 → welcome 创建账号表单
  {
    const { ctx, page } = await newCtx(browser);
    await page.goto(`${BASE}/welcome`);
    await page.getByRole("heading", { name: "欢迎使用复调" }).waitFor();
    await shot(page, "pc/01-welcome-创建账号.png");
    // 02 切到粘贴 token 登录
    await page.getByRole("button", { name: "已有账号 · 粘贴 token" }).click();
    await page.getByText("登录 token").waitFor();
    await shot(page, "pc/02-welcome-粘贴token登录.png");
    await ctx.close();
  }

  const accA = await createAccount();
  let collabCode = "";

  // 03/04/06:账号 A 的桌面会话
  {
    const { ctx, page } = await newCtx(browser, { token: accA.token });
    await page.goto(BASE);
    await page.getByRole("button", { name: "创建新文档" }).click();
    await waitEditor(page);
    // 第 1 个房间:重命名为更自然的样子
    await page.getByRole("button", { name: "未命名文档" }).click();
    await page.getByPlaceholder("输入房间名").fill("接口设计评审");
    await page.getByPlaceholder("输入房间名").press("Enter");
    await page.waitForTimeout(400);
    const code1 = await roomCodeOf(page);
    // 再开第 2 个房间(默认名),让「我的房间」列表有两条
    await page.goto(BASE);
    await page.getByRole("button", { name: "创建新文档" }).click();
    await waitEditor(page);
    const code2 = await roomCodeOf(page);
    void code1; void code2;

    // 03 首页双栏 + 我的房间
    await page.goto(BASE);
    await page.getByRole("button", { name: "接口设计评审" }).waitFor({ timeout: 10_000 });
    await page.waitForTimeout(400);
    await shot(page, "pc/03-home-双栏我的房间.png");

    // 04 批量管理
    await page.getByRole("button", { name: "批量管理" }).click();
    await page.getByRole("button", { name: "退出所选" }).waitFor();
    await shot(page, "pc/04-home-批量管理.png");
    await page.getByRole("button", { name: "完成" }).click();

    // 05 设置
    await page.goto(`${BASE}/settings`);
    await page.getByRole("heading", { name: "设置" }).waitFor();
    await shot(page, "pc/05-settings.png");

    // 06 双人协同:A 开新房,B 加入,双端写入
    await page.goto(BASE);
    await page.getByRole("button", { name: "创建新文档" }).click();
    await waitEditor(page);
    collabCode = await roomCodeOf(page);
    const editorA = page.locator('[contenteditable="true"]').first();
    await editorA.click();
    await editorA.type("声部 A(PC):复调 v3.4.2 验收——多声部实时协同。");

    const accB = await createAccount();
    const b = await newCtx(browser, { token: accB.token });
    await b.page.goto(BASE);
    await b.page.getByPlaceholder("输入 8 位房间代码").fill(collabCode);
    await b.page.getByRole("button", { name: "加入文档" }).click();
    await waitEditor(b.page);
    const editorB = b.page.locator('[contenteditable="true"]').first();
    await editorB.click();
    await editorB.type("声部 B(加入方):同步写入这一句。");
    // A 端等到两段文字都在 → 截 A 的桌面(含常驻在线用户侧栏)
    await page.getByText("声部 B(加入方)").waitFor({ timeout: 15_000 });
    await page.waitForTimeout(800);
    await shot(page, "pc/06-editor-双人协同含双端内容.png");
    // 手机「在线房间」要用到这个仍在线的房间:B 保持连接,A 上下文也留到手机段结束
    globalThis.__holdB = b;
    globalThis.__holdA = { ctx, page };
  }

  /* ============ 手机(Pixel 7 仿真 412×915)============ */
  const accC = await createAccount();
  let phoneCode = "";
  {
    const c = await newCtx(browser, { token: accC.token, mobile: true });
    await c.page.goto(BASE);
    await c.page.getByRole("button", { name: "创建新文档" }).click();
    await waitEditor(c.page);
    phoneCode = await roomCodeOf(c.page);

    const accD = await createAccount();
    const d = await newCtx(browser, { token: accD.token, mobile: true });
    await d.page.goto(BASE);
    await d.page.getByPlaceholder("输入 8 位房间代码").fill(phoneCode);
    await d.page.getByRole("button", { name: "加入文档" }).click();
    await waitEditor(d.page);
    const ed = d.page.locator('[contenteditable="true"]').first();
    await ed.click();
    await ed.type("手机端声部 B:一句话同步。");
    const ec = c.page.locator('[contenteditable="true"]').first();
    await ec.click();
    await ec.type("手机端声部 A:v3.4.2 验收。");
    await c.page.getByText("手机端声部 B").waitFor({ timeout: 15_000 });
    await c.page.waitForTimeout(600);
    await shot(c.page, "phone/03-editor-协同两人.png");

    // 04 在线用户抽屉(👥)
    await c.page.getByRole("button", { name: /👥/ }).click();
    await c.page.getByRole("heading", { name: /在线用户/ }).first().waitFor();
    await c.page.waitForTimeout(300);
    await shot(c.page, "phone/04-editor-在线用户抽屉.png");
    await c.page.keyboard.press("Escape");

    // 05 二维码弹层
    await c.page.getByRole("button", { name: "二维码" }).click();
    await c.page.getByRole("heading", { name: "扫码进房" }).waitFor();
    await c.page.waitForTimeout(300);
    await shot(c.page, "phone/05-editor-二维码弹层.png");
    await c.page.keyboard.press("Escape");

    // 02 在线房间(上面的房间 D 仍在线;桌面协同房也在线)
    await c.page.goto(BASE);
    await c.page.getByRole("button", { name: "在线房间" }).click();
    await c.page.getByText(phoneCode, { exact: false }).waitFor({ timeout: 10_000 });
    await c.page.waitForTimeout(400);
    await shot(c.page, "phone/02-home-在线房间.png");

    // 01 我的房间(D 仍连着,回「我的房间」截列表)
    await c.page.getByRole("button", { name: "我的房间", exact: true }).click();
    await c.page.waitForTimeout(400);
    await shot(c.page, "phone/01-home-我的房间.png");

    // 06 设置
    await c.page.goto(`${BASE}/settings`);
    await c.page.getByRole("heading", { name: "设置" }).waitFor();
    await shot(c.page, "phone/06-settings.png");
    await d.ctx.close();
    await c.ctx.close();
  }

  // 07 welcome 已有账号(未登录,手机)
  {
    const { ctx, page } = await newCtx(browser, { mobile: true });
    await page.goto(`${BASE}/welcome`);
    await page.getByRole("heading", { name: "欢迎使用复调" }).waitFor();
    await page.getByRole("button", { name: "已有账号 · 粘贴 token" }).click();
    await page.getByText("登录 token").waitFor();
    await shot(page, "phone/07-welcome-已有账号.png");
    await ctx.close();
  }

  globalThis.__holdB?.ctx.close();
  globalThis.__holdA?.ctx.close();
  console.log("DONE");
} finally {
  await browser.close();
}

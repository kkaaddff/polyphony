// 配对登录 v2(docs/identity-and-sharing.md §4.6):push 链接全流程/拒绝/撤销/双开,
// pull 已登录设备批准页。双 browser context 走 /pair URL(不碰摄像头)。
import { expect, test, type Browser, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { loginTestAccount } from "./helpers";

const API = "http://localhost:3001";

/** 发起端:登录 → 首页头像菜单「登录新设备」打开弹窗(QR 自动创建)。 */
async function openPairModal(browser: Browser): Promise<{ page: Page; name: string }> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const acc = await loginTestAccount(page);
  await page.goto("/");
  await page.getByTitle("账号菜单").click();
  await page.getByRole("menuitem", { name: "登录新设备" }).click();
  await expect(page.getByRole("heading", { name: "登录新设备" })).toBeVisible();
  // 配对自动创建(一个码同出二维码与链接)
  await expect(page.getByText(/剩余 \d+:\d{2}/)).toBeVisible({ timeout: 10_000 });
  return { page, name: acc.name };
}

/** 复制配对链接并返回其 URL(点「或复制配对链接」→ 只读 input 出现,从 DOM 取)。 */
async function generateLink(page: Page): Promise<string> {
  await page.getByRole("button", { name: "或复制配对链接" }).click();
  const input = page.getByRole("textbox", { name: "或复制配对链接" });
  await expect(input).toHaveValue(/\/pair\?code=/);
  // dev 环境:链接 host 是 API 源(:3001,无静态托管);生产 all-in-one 同源无此差异。
  // 手机语义 = 打开 Web 应用源、API 地址由 ?server= 携带,这里同样换到 :5173。
  return (await input.inputValue()).replace("http://localhost:3001", "http://localhost:5173");
}

/** API 侧发起 pull 配对(模拟新设备欢迎页的本机二维码)。 */
async function requestPull(): Promise<{ code: string; deviceId: string; secret: string }> {
  const secret = randomBytes(24).toString("hex");
  const res = await fetch(`${API}/auth/pair/request`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ secret }),
  });
  if (!res.ok) throw new Error(`pair/request failed: ${res.status}`);
  const data = (await res.json()) as { code: string; deviceId: string };
  return { ...data, secret };
}

test.describe("配对登录 push(链接)", () => {
  test("全流程:生成→落地页登录→网页批准→新设备进入→发起端见 ✓", async ({ browser }) => {
    const { page: page1, name } = await openPairModal(browser);
    const url = await generateLink(page1);

    // 新设备:独立 context(未登录),预览显示目标账号,显式按钮才 claim
    const ctx2 = await browser.newContext();
    const page2 = await ctx2.newPage();
    await page2.goto(url);
    await expect(page2.getByText(`将以账号「${name}」登录本设备`)).toBeVisible();
    await page2.getByRole("button", { name: "在此设备登录" }).click();
    await expect(page2.getByRole("heading", { name: "请在发起设备上确认" })).toBeVisible();

    // 发起端(1s 刷新)出现批准按钮;批准后新设备轮询取到凭据
    const approveBtn = page1.getByRole("button", { name: "批准", exact: true });
    await expect(approveBtn).toBeVisible({ timeout: 5000 });
    await approveBtn.click();

    await expect(page2.getByRole("heading", { name: "登录成功" })).toBeVisible({
      timeout: 5000,
    });
    await page2.getByRole("button", { name: "进入 Polyphony" }).click();
    await expect(page2).toHaveURL("/");
    await expect(page2.getByText(name, { exact: true })).toBeVisible();

    // 发起端:设备上线(/auth/me)后列表项显示 ✓
    await expect(page1.getByText("✓ 该设备已登录")).toBeVisible({ timeout: 10_000 });
  });

  test("拒绝:发起端点拒绝,新设备显示已被拒绝且未登录", async ({ browser }) => {
    const { page: page1 } = await openPairModal(browser);
    const url = await generateLink(page1);

    const ctx2 = await browser.newContext();
    const page2 = await ctx2.newPage();
    await page2.goto(url);
    await page2.getByRole("button", { name: "在此设备登录" }).click();

    const denyBtn = page1.getByRole("button", { name: "拒绝" });
    await expect(denyBtn).toBeVisible({ timeout: 5000 });
    await denyBtn.click();

    await expect(page2.getByText("登录已被拒绝")).toBeVisible({ timeout: 5000 });
    expect(await page2.evaluate(() => localStorage.getItem("polyphony.token"))).toBeNull();
    // 一次只有一个配对:拒绝即结束本次,发起端自动换出新码继续等待
    await expect(page1.getByText("等待新设备扫码")).toBeVisible({ timeout: 5000 });
    await expect(page1.getByText(/剩余 \d+:\d{2}/)).toBeVisible();
  });

  test("撤销:claim 后发起端撤销,新设备显示已被撤销", async ({ browser }) => {
    const { page: page1 } = await openPairModal(browser);
    const url = await generateLink(page1);

    const ctx2 = await browser.newContext();
    const page2 = await ctx2.newPage();
    await page2.goto(url);
    await page2.getByRole("button", { name: "在此设备登录" }).click();
    await expect(page2.getByRole("heading", { name: "请在发起设备上确认" })).toBeVisible();

    // 无列表:唯一在途码的「撤销」= 撤销并立即重建(取消就重新开始)
    await expect(page1.getByRole("button", { name: "撤销" })).toBeVisible({ timeout: 5000 });
    await page1.getByRole("button", { name: "撤销" }).click();

    await expect(page2.getByText("配对已被撤销")).toBeVisible({ timeout: 5000 });
    expect(await page2.evaluate(() => localStorage.getItem("polyphony.token"))).toBeNull();
    // 撤销后立刻回到「等待新设备扫码」,且二维码仍在
    await expect(page1.getByText("等待新设备扫码")).toBeVisible({ timeout: 5000 });
    await expect(page1.locator("canvas")).toBeVisible();
  });

  test("双开:同码第二个设备打不开登录按钮,提示已被使用", async ({ browser }) => {
    const { page: page1 } = await openPairModal(browser);
    const url = await generateLink(page1);

    const ctx2 = await browser.newContext();
    const page2 = await ctx2.newPage();
    await page2.goto(url);
    await page2.getByRole("button", { name: "在此设备登录" }).click();
    await expect(page2.getByRole("heading", { name: "请在发起设备上确认" })).toBeVisible();

    // 第三个设备打开同链接:info 显示已被 claim,不给出登录按钮
    const ctx3 = await browser.newContext();
    const page3 = await ctx3.newPage();
    await page3.goto(url);
    await expect(page3.getByText("配对码已被其他设备使用")).toBeVisible({
      timeout: 5000,
    });
    await expect(page3.getByRole("button", { name: "在此设备登录" })).toHaveCount(0);
  });
});

test.describe("配对登录 pull(本机码)", () => {
  test("已登录设备打开 /pair → 批准页 → 批准;新设备轮询通过", async ({ browser }) => {
    // 模拟新设备欢迎页发起(API 同 requestPullPairing)
    const pull = await requestPull();

    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const acc = await loginTestAccount(page);
    await page.goto(`/pair?code=${pull.code}&server=http%3A%2F%2Flocalhost%3A3001`);
    // 批准页:设备标签 + 醒目警示(V8)
    await expect(page.getByRole("heading", { name: "配对确认" })).toBeVisible();
    await expect(page.getByText(/请求登录你的账号/)).toBeVisible();
    await expect(page.getByText(/仅当你认识这台设备时才批准/)).toBeVisible();
    await page.getByRole("button", { name: "批准登录" }).click();
    await expect(page.getByRole("heading", { name: "已批准" })).toBeVisible();

    // 新设备侧轮询 → approved → 用本地 secret 拼凭据可调 /auth/me
    const poll = await fetch(`${API}/auth/pair/poll`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: pull.code, deviceId: pull.deviceId }),
    });
    const pollData = (await poll.json()) as { status: string; accountName?: string };
    expect(pollData.status).toBe("approved");
    expect(pollData.accountName).toBe(acc.name);
    const me = await fetch(`${API}/auth/me`, {
      headers: { Authorization: `Bearer poly_d_${pull.deviceId}_${pull.secret}` },
    });
    expect(me.ok).toBe(true);
  });

  test("未登录设备打开 pull 码:提示用已登录设备确认(不暴露批准页)", async ({ browser }) => {
    const pull = await requestPull();
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(`/pair?code=${pull.code}`);
    await expect(
      page.getByText("这是新设备的配对码。请用已登录的设备扫码打开本页进行确认。")
    ).toBeVisible({ timeout: 5000 });
    await expect(page.getByRole("button", { name: "批准登录" })).toHaveCount(0);
  });
});

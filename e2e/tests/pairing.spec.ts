// 配对登录:双 browser context 走 /pair URL 兜底路径(不碰摄像头)。
// 覆盖 docs/pairing-login.md §7 的四条:全流程、拒绝、撤销、双开抢码。
import { expect, test, type Browser, type Page } from "@playwright/test";
import { loginTestAccount } from "./helpers";

/** 发起端:登录 → 首页头像菜单「登录新设备」打开弹窗。 */
async function openPairModal(browser: Browser): Promise<{ page: Page; name: string }> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const acc = await loginTestAccount(page);
  await page.goto("/");
  await page.getByTitle("账号菜单").click();
  await page.getByRole("menuitem", { name: "登录新设备" }).click();
  await expect(page.getByRole("heading", { name: "登录新设备" })).toBeVisible();
  return { page, name: acc.name };
}

/** 生成邀请链接并返回其 URL(只读展示,e2e 从 DOM 取,不依赖剪贴板)。 */
async function generateLink(page: Page): Promise<string> {
  await page.getByRole("button", { name: "生成链接" }).click();
  const input = page.getByLabel("复制链接");
  await expect(input).toHaveValue(/\/pair\?code=/);
  // dev 环境:链接 host 是 API 源(:3001,无静态托管);生产 all-in-one 同源无此差异。
  // 手机语义 = 打开 Web 应用源、API 地址由 ?server= 携带,这里同样换到 :5173。
  return (await input.inputValue()).replace("http://localhost:3001", "http://localhost:5173");
}

test.describe("配对登录", () => {
  test("邀请链接全流程:生成→落地页登录→网页确认→新设备进入", async ({ browser }) => {
    const { page: page1, name } = await openPairModal(browser);
    const url = await generateLink(page1);

    // 接收端:独立 context(未登录),预览显示目标账号,显式按钮才 claim
    const ctx2 = await browser.newContext();
    const page2 = await ctx2.newPage();
    await page2.goto(url);
    await expect(page2.getByText(`将以账号「${name}」登录本设备`)).toBeVisible();
    await page2.getByRole("button", { name: "在此设备登录" }).click();
    await expect(page2.getByRole("heading", { name: "请在发起设备上确认" })).toBeVisible();

    // 发起端(1s 轮询)出现确认按钮;确认后手机端(1.5s 轮询)取到 token
    const confirmBtn = page1.getByRole("button", { name: "确认登录" });
    await expect(confirmBtn).toBeVisible({ timeout: 5000 });
    await confirmBtn.click();

    await expect(page2.getByRole("heading", { name: "登录成功" })).toBeVisible({
      timeout: 5000,
    });
    await page2.getByRole("button", { name: "进入 Polyphony" }).click();
    await expect(page2).toHaveURL("/");
    await expect(page2.getByText(name, { exact: true })).toBeVisible();

    // 发起端最终显示 ✓(consumed 在宽限内可见,D14)
    await expect(page1.getByText("✓ 该设备已登录")).toBeVisible({ timeout: 5000 });
  });

  test("拒绝:发起端点拒绝,接收端显示已被拒绝且未登录", async ({ browser }) => {
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
    // 发起端列表项落到「已拒绝」终态
    await expect(page1.getByText("已拒绝", { exact: true })).toBeVisible({ timeout: 5000 });
  });

  test("撤销:claim 后发起端撤销,接收端显示已被撤销", async ({ browser }) => {
    const { page: page1 } = await openPairModal(browser);
    const url = await generateLink(page1);

    const ctx2 = await browser.newContext();
    const page2 = await ctx2.newPage();
    await page2.goto(url);
    await page2.getByRole("button", { name: "在此设备登录" }).click();
    await expect(page2.getByRole("heading", { name: "请在发起设备上确认" })).toBeVisible();

    // 列表含 QR(pending)与链接(claimed)两项,撤销要落在「链接」那一行
    const linkRow = page1.locator("li", { hasText: "链接" });
    await expect(linkRow.getByRole("button", { name: "撤销" })).toBeVisible({
      timeout: 5000,
    });
    await linkRow.getByRole("button", { name: "撤销" }).click();

    await expect(page2.getByText("配对已被撤销")).toBeVisible({ timeout: 5000 });
    expect(await page2.evaluate(() => localStorage.getItem("polyphony.token"))).toBeNull();
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

// 账号体系:创建(token 一次性展示)、粘贴登录、退出登录、无效 token。
import { expect, test } from "@playwright/test";
import { createAccount, seedStorage } from "./helpers";

test.describe("/welcome 创建账号", () => {
  test("创建 → token 一次性展示 → 确认进入,刷新不再展示", async ({ page }) => {
    await page.goto("/welcome");
    await expect(page.getByRole("heading", { name: "欢迎使用 Polyphony" })).toBeVisible();

    // 名字唯一:并发/重试下固定名会撞「已被占用」
    const name = `张三丰${Date.now().toString(36).slice(-4)}`;
    await page.locator("#accountName").fill(name);
    await page.getByRole("button", { name: "创建账号" }).click();

    // token 一次性展示页:明示「仅此一次」+ poly_ 前缀 token + 复制按钮
    await expect(page.getByText("账号创建成功")).toBeVisible();
    await expect(page.getByText(/仅此一次展示/)).toBeVisible();
    const tokenText = await page.locator("code.break-all").textContent();
    expect(tokenText).toMatch(/^poly_[0-9a-f]{40,}$/);
    await page
      .getByRole("button", { name: "我已妥善保管，进入 Polyphony" })
      .click();

    // 进入首页:顶栏显示账号名
    await expect(page).toHaveURL("/");
    await expect(page.getByText(name, { exact: true })).toBeVisible();

    // token 已存;刷新停留在首页(不再回到展示页)
    const saved = await page.evaluate(() => localStorage.getItem("polyphony.token"));
    expect(saved).toBe(tokenText);
    await page.reload();
    await expect(page).toHaveURL("/");
  });

  test("重名:422 提示换名", async ({ page }) => {
    const acc = await createAccount(); // 占住名字
    await page.goto("/welcome");
    await page.locator("#accountName").fill(acc.name);
    await page.getByRole("button", { name: "创建账号" }).click();
    await expect(page.getByText("用户名已被占用，换一个试试")).toBeVisible({
      timeout: 10_000,
    });
  });
});

test.describe("/welcome 粘贴 token 登录", () => {
  test("有效 token:验证并进入首页", async ({ page }) => {
    const acc = await createAccount();
    await page.goto("/welcome");
    await page.getByRole("button", { name: /已有账号/ }).click();
    await page.locator("#tokenInput").fill(acc.token);
    await page.getByRole("button", { name: "验证并登录" }).click();
    await expect(page).toHaveURL("/");
    await expect(page.getByText(acc.name, { exact: true })).toBeVisible();
  });

  test("无效 token:错误提示停留引导页", async ({ page }) => {
    await page.goto("/welcome");
    await page.getByRole("button", { name: /已有账号/ }).click();
    await page.locator("#tokenInput").fill("poly_invalid");
    await page.getByRole("button", { name: "验证并登录" }).click();
    await expect(page.getByText("token 无效或已失效")).toBeVisible({
      timeout: 10_000,
    });
    await expect(page).toHaveURL(/\/welcome/);
  });
});

test.describe("401 统一登出", () => {
  test("token 失效后任一请求 → 清 token 回引导页", async ({ page }) => {
    // 经页面直接写入(addInitScript 会在登出重载后重放注入,不能用它模拟失效态)
    await page.goto("/welcome");
    await page.evaluate(() => localStorage.setItem("polyphony.token", "poly_forged0000"));
    await page.goto("/");
    // authFetch 401 → 清 token → 跳 /welcome
    await expect(page).toHaveURL(/\/welcome/, { timeout: 15_000 });
    const saved = await page.evaluate(() => localStorage.getItem("polyphony.token"));
    expect(saved).toBeNull();
  });
});

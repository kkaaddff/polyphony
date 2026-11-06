// 账号体系(v4):创建 → 恢复密钥一次性展示、恢复密钥登录、退出登录、401 统一登出。
import { expect, test } from "@playwright/test";
import { createAccount, seedStorage } from "./helpers";

test.describe("/welcome 创建账号", () => {
  test("创建 → 恢复密钥一次性展示 → 勾选确认进入,刷新不再展示", async ({ page }) => {
    await page.goto("/welcome");
    await expect(page.getByRole("heading", { name: "欢迎使用 Polyphony" })).toBeVisible();

    // 名字唯一:并发/重试下固定名会撞「已被占用」
    const name = `张三丰${Date.now().toString(36).slice(-4)}`;
    await page.locator("#accountName").fill(name);
    await page.getByRole("button", { name: "创建账号" }).click();

    // 恢复密钥一次性展示页:明示「仅此一次」+ poly_r_ 前缀 + 复制按钮
    await expect(page.getByRole("heading", { name: "账号已创建" })).toBeVisible();
    await expect(page.getByText(/仅此一次展示/)).toBeVisible();
    const keyText = await page.locator("code.break-all").textContent();
    expect(keyText).toMatch(/^poly_r_[0-9a-f]{48}$/);
    // 未勾选「已保存」时确认按钮不可点
    const confirm = page.getByRole("button", { name: "我已妥善保存，进入 Polyphony" });
    await expect(confirm).toBeDisabled();
    await page.getByLabel(/我已妥善保存恢复密钥/).check();
    await confirm.click();

    // 进入首页:顶栏显示账号名;本机凭据(poly_d_)已存,刷新停留首页
    await expect(page).toHaveURL("/");
    await expect(page.getByText(name, { exact: true })).toBeVisible();
    const saved = await page.evaluate(() => localStorage.getItem("polyphony.token"));
    expect(saved).toMatch(/^poly_d_[0-9a-f-]{36}_[0-9a-f]{48}$/);
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

test.describe("/welcome 恢复密钥登录", () => {
  test("有效恢复密钥:兑换本机凭据并进入首页", async ({ page }) => {
    const acc = await createAccount();
    await page.goto("/welcome");
    await page.getByRole("button", { name: "密钥登录" }).click();
    await page.locator("#recoveryKey").fill(acc.recoveryKey);
    await page.getByRole("button", { name: "恢复登录" }).click();
    await expect(page).toHaveURL("/");
    await expect(page.getByText(acc.name, { exact: true })).toBeVisible();
    // 兑换出的新设备凭据与原设备不同(每台设备独立)
    const saved = await page.evaluate(() => localStorage.getItem("polyphony.token"));
    expect(saved).not.toBe(acc.token);
  });

  test("无效恢复密钥:错误提示停留引导页", async ({ page }) => {
    await page.goto("/welcome");
    await page.getByRole("button", { name: "密钥登录" }).click();
    await page.locator("#recoveryKey").fill("poly_r_invalid");
    await page.getByRole("button", { name: "恢复登录" }).click();
    await expect(page.getByText("登录信息无效或已失效")).toBeVisible({
      timeout: 10_000,
    });
    await expect(page).toHaveURL(/\/welcome/);
  });
});

test.describe("401 统一登出", () => {
  test("凭据失效后任一请求 → 清凭据回引导页", async ({ page }) => {
    // 经页面直接写入(addInitScript 会在登出重载后重放注入,不能用它模拟失效态)
    await page.goto("/welcome");
    const forged = `poly_d_00000000-0000-4000-8000-000000000000_${"0".repeat(48)}`;
    await page.evaluate((t) => localStorage.setItem("polyphony.token", t), forged);
    await page.goto("/");
    // authFetch 401 → 清凭据 → 跳 /welcome
    await expect(page).toHaveURL(/\/welcome/, { timeout: 15_000 });
    const saved = await page.evaluate(() => localStorage.getItem("polyphony.token"));
    expect(saved).toBeNull();
  });

  test("v3 残留 token(非 poly_d_):加载即清理并回引导页", async ({ page }) => {
    await page.goto("/welcome");
    await page.evaluate(() => localStorage.setItem("polyphony.token", "poly_deadbeef"));
    await page.goto("/");
    await expect(page).toHaveURL(/\/welcome/, { timeout: 15_000 });
    const saved = await page.evaluate(() => localStorage.getItem("polyphony.token"));
    expect(saved).toBeNull();
  });
});

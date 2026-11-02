// 设置页：测试连接、协议头补全、保存/清除/返回（登录态之下）。
import { expect, test } from "@playwright/test";
import { loginTestAccount, openShareSite, seedStorage } from "./helpers";

test.beforeEach(async ({ page }) => {
  // 设置页在登录守卫之后:全部用例先注入测试账号 token
  await loginTestAccount(page);
});

test.describe("测试连接", () => {
  test("空地址点击：提示先输入", async ({ page }) => {
    await page.goto("/settings");
    await page.getByRole("button", { name: "测试连接" }).click();
    await expect(page.getByText("请先输入服务器地址")).toBeVisible();
  });

  test("真实服务（:3001）：成功 + 延迟/房间/人数", async ({ page }) => {
    await page.goto("/settings");
    await page.locator("#serverUrl").fill("http://localhost:3001");
    await page.getByRole("button", { name: "测试连接" }).click();
    await expect(page.getByText(/✓ 连接成功：\d+ms · \d+ 个房间 · \d+ 人在线/)).toBeVisible({
      timeout: 10_000,
    });
  });

  test("裸 IP 自动补 http:// 前缀", async ({ page }) => {
    await page.route("**/health", (r) =>
      r.fulfill({ contentType: "application/json", body: JSON.stringify({ totalRooms: 0, totalUsers: 0 }) })
    );
    await page.goto("/settings");
    await page.locator("#serverUrl").fill("localhost:3001");
    await page.getByRole("button", { name: "测试连接" }).click();
    await expect(page.getByText(/✓ 连接成功/)).toBeVisible();
    await expect(page.locator("#serverUrl")).toHaveValue("http://localhost:3001");
  });

  test("不可达地址：失败提示", async ({ page }) => {
    await page.goto("/settings");
    await page.locator("#serverUrl").fill("http://127.0.0.1:9"); // 无人监听，立即拒绝
    await page.getByRole("button", { name: "测试连接" }).click();
    await expect(page.getByText(/✗ 连接失败/)).toBeVisible({ timeout: 15_000 });
  });
});

test.describe("保存 / 清除 / 返回", () => {
  test("保存并返回：写 localStorage + 回首页状态条更新", async ({ page }) => {
    await page.goto("/settings");
    await page.locator("#serverUrl").fill("http://localhost:3001");
    await page.getByRole("button", { name: "保存并返回" }).click();
    await expect(page).toHaveURL("/");
    // 顶栏不再常驻展示地址;经头像菜单「分享本站」弹层确认当前服务器
    await openShareSite(page);
    await expect(page.getByText("http://localhost:3001")).toBeVisible();
    await page.keyboard.press("Escape");
    const saved = await page.evaluate(() => localStorage.getItem("polyphony.server"));
    expect(saved).toBe("http://localhost:3001");
  });

  test("已保存时出现「清除」按钮；清除后消失并回落默认地址", async ({ page }) => {
    await seedStorage(page, { server: "http://192.168.31.5:8101" });
    await page.goto("/settings");
    const clear = page.getByRole("button", { name: "清除已保存地址" });
    await expect(clear).toBeVisible();
    await clear.click();
    await expect(clear).toBeHidden();
    await expect(page.locator("#serverUrl")).toHaveValue("");
    const saved = await page.evaluate(() => localStorage.getItem("polyphony.server"));
    expect(saved).toBeNull();
    await page.getByRole("button", { name: "保存并返回" }).click();
    // 清除后的回落：dev 环境取 VITE_SERVER_URL（client/.env.local = :3001）；
    // 生产构建无该 env 才回落 location.origin（同源）
    await openShareSite(page);
    await expect(page.getByText("http://localhost:3001")).toBeVisible();
    await page.keyboard.press("Escape");
  });

  test("← 返回首页：不保存直接退出", async ({ page }) => {
    await page.goto("/settings");
    await page.locator("#serverUrl").fill("http://1.2.3.4:9999");
    await page.getByRole("button", { name: "← 返回首页" }).click();
    await expect(page).toHaveURL("/");
    const saved = await page.evaluate(() => localStorage.getItem("polyphony.server"));
    expect(saved).toBeNull();
  });

  test("首页头像菜单「设置」入口可达", async ({ page }) => {
    await page.goto("/");
    await page.getByTitle("账号菜单").click();
    await page.getByRole("menuitem", { name: "设置" }).click();
    await expect(page).toHaveURL("/settings");
    await expect(page.getByRole("heading", { name: "设置" })).toBeVisible();
  });
});

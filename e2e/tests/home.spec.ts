// 首页:登录守卫、双栏一屏布局、顶栏身份、创建/加入、我的房间(批量退出)。
import { expect, test } from "@playwright/test";
import { captureDialogs, loginTestAccount, openShareSite } from "./helpers";

test.describe("守卫与顶栏身份", () => {
  test("无 token:任意路由 → /welcome 引导", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/welcome\?next=%2F$/);
    await expect(
      page.getByRole("heading", { name: "欢迎使用 Polyphony" })
    ).toBeVisible();
  });

  test("已登录:双栏一屏 + 右上角头像菜单(不展示服务器地址)", async ({ page }) => {
    const acc = await loginTestAccount(page);
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "Polyphony", exact: true })
    ).toBeVisible();
    // 顶栏右上角:账号名 + 头像菜单;服务器地址不再常驻展示
    await expect(page.getByText(acc.name, { exact: true })).toBeVisible();
    await expect(page.getByTitle("账号菜单")).toBeVisible();
    await expect(page.getByText("http://localhost:3001")).toHaveCount(0);
    // 双栏:左操作右列表
    await expect(
      page.getByRole("button", { name: "创建新文档" })
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "我的房间" })).toBeVisible();
    // 一屏无外滚(h-screen + 列表内部滚动)
    const overflowed = await page.evaluate(
      () =>
        document.documentElement.scrollHeight >
        document.documentElement.clientHeight
    );
    expect(overflowed).toBe(false);
  });

  test("创建新文档 → 直进编辑器", async ({ page }) => {
    await loginTestAccount(page);
    await page.goto("/");
    await page.getByRole("button", { name: "创建新文档" }).click();
    await expect(page).toHaveURL(/\/editor\?code=[A-Z0-9]{8}/);
  });

  test("空房间码加入:提示补全", async ({ page }) => {
    await loginTestAccount(page);
    const dialogs = captureDialogs(page);
    await page.goto("/");
    await page.getByRole("button", { name: "加入文档" }).click();
    await expect.poll(() => dialogs).toContain("请输入房间代码");
  });

  test("扫码:无摄像头环境显式报错(不静默关闭)", async ({ page }) => {
    // http:// 直连等环境无 getUserMedia —— 必须显示本地化错误而非无声关掉
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "mediaDevices", {
        value: undefined,
        configurable: true,
      });
    });
    await loginTestAccount(page);
    await page.goto("/");
    await page.getByTitle("扫房间二维码直接加入").click();
    await expect(
      page.getByText("当前环境不支持摄像头（需 HTTPS 或 App）")
    ).toBeVisible();
    await page.getByRole("button", { name: "知道了" }).click();
    await expect(
      page.getByText("当前环境不支持摄像头（需 HTTPS 或 App）")
    ).toBeHidden();
  });

  test("房间码加入 → 编辑器", async ({ page }) => {
    await loginTestAccount(page);
    await page.goto("/");
    await page.locator("#roomCode").fill("JOIN0001");
    await page.getByRole("button", { name: "加入文档" }).click();
    await expect(page).toHaveURL(/\/editor\?code=JOIN0001/);
  });
});

test.describe("我的房间(服务端房间簿)", () => {
  test("进入自动登记;单个退出后列表清空", async ({ page }) => {
    await loginTestAccount(page);
    await page.goto("/");
    await page.getByRole("button", { name: "创建新文档" }).click();
    await expect(page).toHaveURL(/\/editor/);
    await page.getByTitle("在线用户与更多操作").click();
    await page.getByRole("menuitem", { name: "退出房间" }).click();
    // 回首页:房间已登记(未命名 + 随机码行)
    await expect(
      page.getByText("未命名文档", { exact: true })
    ).toBeVisible({ timeout: 10_000 });

    // 单个退出(confirm 自动接受)
    page.once("dialog", (d) => d.accept());
    await page.getByTitle("退出该房间").click();
    await expect(page.getByText("还没有访问过的房间")).toBeVisible({
      timeout: 10_000,
    });
  });

  test("批量退出:3 个退 2 留 1", async ({ page }) => {
    const acc = await loginTestAccount(page);
    // API 直登 3 个房间
    for (const code of ["BATCH001", "BATCH002", "BATCH003"]) {
      await fetch("http://localhost:3001/rooms/enter", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${acc.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ code, name: `批量${code}` }),
      });
    }
    await page.goto("/");
    await expect(page.getByText("批量BATCH001")).toBeVisible({
      timeout: 10_000,
    });

    await page.getByRole("button", { name: /批量管理/ }).click();
    await page
      .locator("li", { hasText: "BATCH001" })
      .locator('input[type="checkbox"]')
      .check();
    await page
      .locator("li", { hasText: "BATCH002" })
      .locator('input[type="checkbox"]')
      .check();

    page.once("dialog", (d) => d.accept());
    await page.getByRole("button", { name: /退出所选/ }).click();

    await expect(page.getByText("批量BATCH003")).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByText("批量BATCH001")).toHaveCount(0);
    await expect(page.getByText("批量BATCH002")).toHaveCount(0);
  });

  test("退出登录:头像菜单 confirm 后清 token 回引导页", async ({ page }) => {
    await loginTestAccount(page);
    await page.goto("/");
    page.once("dialog", (d) => d.accept());
    await page.getByTitle("账号菜单").click();
    await page.getByRole("menuitem", { name: "退出登录" }).click();
    await expect(page).toHaveURL(/\/welcome/);
  });

  test("分享本站:头像菜单 → 弹层展示服务器地址二维码", async ({ page }) => {
    await loginTestAccount(page);
    await page.goto("/");
    await openShareSite(page);
    await expect(page.getByText("http://localhost:3001")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("heading", { name: "扫码访问本站" })
    ).toBeHidden();
  });
});

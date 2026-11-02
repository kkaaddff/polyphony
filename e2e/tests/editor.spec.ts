// 编辑器：直达守卫、顶栏操作（房间码点击复制/发送邀请/重命名/人数菜单退出）、双端协同收敛。
// 并行隔离：每个用例独立账号 + 独立房间码（WS 强制 token 鉴权）。
import { expect, test, type Page } from "@playwright/test";
import { createAccount, seedStorage } from "./helpers";

function uniqRoom(base: string): string {
  return (base + Math.random().toString(36).slice(2, 6)).toUpperCase().slice(0, 8);
}

async function openEditor(page: Page, code: string, name = "张三", token?: string) {
  if (token) await seedStorage(page, { token });
  await page.goto(`/editor?code=${code}&name=${encodeURIComponent(name)}`);
  await expect(page.getByText("已连接", { exact: true })).toBeVisible({ timeout: 15_000 });
}

test.describe("路由守卫与退出", () => {
  test("无 code 直达 → 弹回首页", async ({ page }) => {
    const { token } = await createAccount();
    await seedStorage(page, { token });
    await page.goto("/editor");
    await expect(page).toHaveURL("/");
  });

  test("退出房间(人数菜单) → 回首页", async ({ page }) => {
    const { token } = await createAccount();
    await openEditor(page, uniqRoom("EXIT"), "张三", token);
    await page.getByTitle("在线用户与更多操作").click();
    await page.getByRole("menuitem", { name: "退出房间" }).click();
    await expect(page).toHaveURL("/");
  });
});

test.describe("顶栏", () => {
  test("点击房间码复制：toast 反馈 + 剪贴板内容正确", async ({ page }) => {
    const { token } = await createAccount();
    const code = uniqRoom("COPY");
    await openEditor(page, code, "张三", token);
    // 房间码本身即复制按钮(不再有独立「复制」按钮)
    await page.getByRole("button", { name: code }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "房间号已复制" })
    ).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(code);
  });

  test("无 clipboard API（http 直连场景）：降级复制仍有 toast 反馈", async ({ page }) => {
    const { token } = await createAccount();
    await page.addInitScript(() => {
      // 模拟非安全上下文（http://IP）：navigator.clipboard 不存在
      Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    });
    const code = uniqRoom("NOC");
    await openEditor(page, code, "张三", token);
    await page.getByRole("button", { name: code }).click();
    // 不能无反馈/抛错：降级 execCommand 路径给出同样的 toast
    await expect(
      page.getByRole("status").filter({ hasText: "房间号已复制" })
    ).toBeVisible();
  });

  test("发送邀请(人数菜单)：URL 载荷含 code 与 server；ESC/遮罩/按钮三种关闭", async ({ page }) => {
    const { token } = await createAccount();
    const code = uniqRoom("QRM");
    await openEditor(page, code, "张三", token);
    const openInvite = async () => {
      await page.getByTitle("在线用户与更多操作").click();
      await page.getByRole("menuitem", { name: "发送邀请" }).click();
    };
    await openInvite();
    await expect(page.getByRole("heading", { name: "扫码进房" })).toBeVisible();
    await expect(
      page.getByText(new RegExp(`/join\\?code=${code}&server=http%3A%2F%2Flocalhost%3A3001`))
    ).toBeVisible();
    // canvas 确已渲染（尺寸 240）
    const canvas = page.locator("canvas");
    await expect(canvas).toBeVisible();
    expect((await canvas.boundingBox())?.width).toBeGreaterThan(200);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("heading", { name: "扫码进房" })).toBeHidden();

    await openInvite();
    await page.getByRole("button", { name: "关闭" }).click();
    await expect(page.getByRole("heading", { name: "扫码进房" })).toBeHidden();

    await openInvite();
    await page.mouse.click(8, 400); // 点遮罩
    await expect(page.getByRole("heading", { name: "扫码进房" })).toBeHidden();
  });

  test("重命名：就地编辑 + Enter 提交，首页我的房间同步名称", async ({ page }) => {
    const { token } = await createAccount();
    const code = uniqRoom("REN");
    await openEditor(page, code, "张三", token);
    await page.getByRole("button", { name: "未命名文档" }).click();
    const input = page.getByPlaceholder("输入房间名");
    await input.fill("接口设计评审");
    await input.press("Enter");
    await expect(page.getByRole("button", { name: "接口设计评审" })).toBeVisible();

    await page.getByTitle("在线用户与更多操作").click();
    await page.getByRole("menuitem", { name: "退出房间" }).click();
    // 服务端房间簿登记后首页展示(网络 + 500ms 防抖,放宽等待)
    await expect(
      page.getByRole("button", { name: /接口设计评审/ })
    ).toBeVisible({ timeout: 10_000 });
  });

  test("重命名：Escape 放弃本次修改（保留已提交名）", async ({ page }) => {
    const { token } = await createAccount();
    await openEditor(page, uniqRoom("ESC"), "张三", token);
    // 先提交一个名字（顶栏名来自房间 meta，而非本地最近列表）
    await page.getByRole("button", { name: "未命名文档" }).click();
    const input = page.getByPlaceholder("输入房间名");
    await input.fill("已提交名");
    await input.press("Enter");
    await expect(page.getByRole("button", { name: "已提交名" })).toBeVisible();

    // 再改后按 Escape：不提交
    await page.getByRole("button", { name: "已提交名" }).click();
    await page.getByPlaceholder("输入房间名").fill("改了也不算");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "已提交名" })).toBeVisible();
    await expect(page.getByRole("button", { name: "改了也不算" })).toHaveCount(0);
  });
});

test.describe("双端协同（真实 ws :3001,同一账号两个浏览器上下文）", () => {
  // 双用户各用独立 browser context：同 context 双标签会共享 IndexedDB/BroadcastChannel，
  // y-websocket 的 awareness 归属会错位（离开广播要等 ~30s 过期兜底）——真实多用户
  // （不同设备/浏览器）不存在此现象，测试按真实场景隔离。
  test("A 输入 B 收到；在线用户数 2；改名跨端同步", async ({ browser }) => {
    const { token } = await createAccount();
    const code = uniqRoom("SYNC");
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const a = await ctxA.newPage();
    const b = await ctxB.newPage();
    await openEditor(a, code, "甲", token);
    await openEditor(b, code, "乙", token);

    for (const p of [a, b]) {
      await expect(p.getByText("在线用户 (2)")).toBeVisible({ timeout: 15_000 });
      await expect(p.getByText("甲", { exact: true })).toBeVisible();
      await expect(p.getByText("乙", { exact: true })).toBeVisible();
    }

    // A 打字 → B 收敛
    const editorA = a.locator('[contenteditable="true"]').first();
    await editorA.click();
    await editorA.type("e2e-collab-marker");
    await expect(b.locator("body")).toContainText("e2e-collab-marker", { timeout: 15_000 });

    // A 改房间名 → B 顶栏同步
    await a.getByRole("button", { name: "未命名文档" }).click();
    const input = a.getByPlaceholder("输入房间名");
    await input.fill("双端改名测试");
    await input.press("Enter");
    await expect(b.getByRole("button", { name: "双端改名测试" })).toBeVisible({
      timeout: 15_000,
    });
    await ctxB.close();
    await ctxA.close();
  });

  test("B 退出后 A 的在线人数回落（独立 context，秒级）", async ({ browser }) => {
    const { token } = await createAccount();
    const code = uniqRoom("LEAV");
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const a = await ctxA.newPage();
    const b = await ctxB.newPage();
    await openEditor(a, code, "甲", token);
    await openEditor(b, code, "乙", token);
    await expect(a.getByText("在线用户 (2)")).toBeVisible({ timeout: 15_000 });
    await b.close();
    // 跨设备场景：服务端按连接名单立即广播离开，无需等 awareness 过期
    await expect(a.getByText("在线用户 (1)")).toBeVisible({ timeout: 10_000 });
    await ctxB.close();
    await ctxA.close();
  });
});

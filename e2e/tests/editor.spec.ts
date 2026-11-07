// 编辑器：直达守卫、顶栏操作（文档码点击复制/发送邀请/重命名/人数菜单退出）、
// 所有者导出/删除、双端协同收敛。
// v4:WS 进房前服务端校验文档存在——所有用例先经 API 建文档(服务端生成码);
// 并行隔离:每个用例独立账号 + 独立文档。
import { expect, test, type Page } from "@playwright/test";
import { createAccount, createDoc } from "./helpers";

/** 建文档(创建者即所有者),注入凭据并进入编辑器;返回文档码。 */
async function openEditor(page: Page, name = "张三", token?: string): Promise<string> {
  const t = token ?? (await createAccount()).token;
  const code = await createDoc(t);
  await page.addInitScript((x) => localStorage.setItem("polyphony.token", x), t);
  await page.goto(`/editor?code=${code}&name=${encodeURIComponent(name)}`);
  await expect(page.getByText("已连接", { exact: true })).toBeVisible({ timeout: 15_000 });
  return code;
}

test.describe("路由守卫与退出", () => {
  test("无 code 直达 → 弹回首页", async ({ page }) => {
    const { token } = await createAccount();
    await page.addInitScript((t) => localStorage.setItem("polyphony.token", t), token);
    await page.goto("/editor");
    await expect(page).toHaveURL("/");
  });

  test("不存在的文档码:WS 4004 → alert 后回首页", async ({ page }) => {
    const { token } = await createAccount();
    await page.addInitScript((t) => localStorage.setItem("polyphony.token", t), token);
    const dialogs: string[] = [];
    page.on("dialog", (d) => {
      dialogs.push(d.message());
      void d.accept();
    });
    await page.goto("/editor?code=NOSUCH99&name=%E5%BC%A0%E4%B8%89");
    await expect(page).toHaveURL("/", { timeout: 15_000 });
    expect(dialogs).toContain("文档不存在或已被永久清除");
  });

  test("退出文档(人数菜单) → 回首页", async ({ page }) => {
    const { token } = await createAccount();
    await openEditor(page, "张三", token);
    await page.getByTitle("在线用户与更多操作").click();
    await page.getByRole("menuitem", { name: "退出文档" }).click();
    await expect(page).toHaveURL("/");
  });
});

test.describe("顶栏", () => {
  test("分享按钮复制邀请链接：toast 反馈 + 剪贴板内容正确", async ({ page }) => {
    const code = await openEditor(page);
    // 顶栏不再展示文档码:分享按钮 = 复制邀请链接,码只存在于链接里
    await expect(page.getByText(code, { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "分享" }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "邀请链接已复制" })
    ).toBeVisible();
    const link = await page.evaluate(() => navigator.clipboard.readText());
    expect(link).toContain(`/join?code=${code}`);
  });

  test("无 clipboard API（http 直连场景）：降级复制仍有 toast 反馈", async ({ page }) => {
    await page.addInitScript(() => {
      // 模拟非安全上下文（http://IP）：navigator.clipboard 不存在
      Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    });
    const { token } = await createAccount();
    const code = await createDoc(token);
    await page.addInitScript((t) => localStorage.setItem("polyphony.token", t), token);
    await page.goto(`/editor?code=${code}&name=${encodeURIComponent("张三")}`);
    await expect(page.getByText("已连接", { exact: true })).toBeVisible({ timeout: 15_000 });
    await page.getByRole("button", { name: "分享" }).click();
    // 不能无反馈/抛错：降级 execCommand 路径给出同样的 toast
    await expect(
      page.getByRole("status").filter({ hasText: "邀请链接已复制" })
    ).toBeVisible();
  });

  test("发送邀请(人数菜单)：URL 载荷含 code 与 server；ESC/遮罩/按钮三种关闭", async ({ page }) => {
    const code = await openEditor(page);
    const openInvite = async () => {
      await page.getByTitle("在线用户与更多操作").click();
      await page.getByRole("menuitem", { name: "发送邀请" }).click();
    };
    await openInvite();
    await expect(page.getByRole("heading", { name: "扫码进文档" })).toBeVisible();
    await expect(
      page.getByText(new RegExp(`/join\\?code=${code}&server=http%3A%2F%2Flocalhost%3A3001`))
    ).toBeVisible();
    // canvas 确已渲染（尺寸 240）
    const canvas = page.locator("canvas");
    await expect(canvas).toBeVisible();
    expect((await canvas.boundingBox())?.width).toBeGreaterThan(200);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("heading", { name: "扫码进文档" })).toBeHidden();

    await openInvite();
    await page.getByRole("button", { name: "关闭" }).click();
    await expect(page.getByRole("heading", { name: "扫码进文档" })).toBeHidden();

    await openInvite();
    await page.mouse.click(8, 400); // 点遮罩
    await expect(page.getByRole("heading", { name: "扫码进文档" })).toBeHidden();
  });

  test("重命名：就地编辑 + Enter 提交，首页我的文档同步名称", async ({ page }) => {
    await openEditor(page);
    await page.getByRole("button", { name: "未命名文档" }).click();
    const input = page.getByPlaceholder("输入文档名");
    await input.fill("接口设计评审");
    await input.press("Enter");
    await expect(page.getByRole("button", { name: "接口设计评审" })).toBeVisible();

    await page.getByTitle("在线用户与更多操作").click();
    await page.getByRole("menuitem", { name: "退出文档" }).click();
    // 服务端房间簿登记后首页展示(快照写盘 2s 防抖 + 网络,放宽等待)
    await expect(
      page.getByRole("button", { name: /接口设计评审/ })
    ).toBeVisible({ timeout: 15_000 });
  });

  test("重命名：Escape 放弃本次修改（保留已提交名）", async ({ page }) => {
    await openEditor(page);
    // 先提交一个名字（顶栏名来自文档 meta，而非本地最近列表）
    await page.getByRole("button", { name: "未命名文档" }).click();
    const input = page.getByPlaceholder("输入文档名");
    await input.fill("已提交名");
    await input.press("Enter");
    await expect(page.getByRole("button", { name: "已提交名" })).toBeVisible();

    // 再改后按 Escape：不提交
    await page.getByRole("button", { name: "已提交名" }).click();
    await page.getByPlaceholder("输入文档名").fill("改了也不算");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "已提交名" })).toBeVisible();
    await expect(page.getByRole("button", { name: "改了也不算" })).toHaveCount(0);
  });
});

test.describe("所有者操作(v4)", () => {
  test("导出:一次性令牌下载 zip(md + 图片目录)", async ({ page }) => {
    await openEditor(page);
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: "导出" }).click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/\.zip$/);
  });

  test("删除:confirm 后进回收站并回首页", async ({ page }) => {
    const dialogs: string[] = [];
    page.on("dialog", (d) => {
      dialogs.push(d.message());
      void d.accept();
    });
    await openEditor(page);
    await page.getByRole("button", { name: "删除" }).click();
    await expect(page).toHaveURL("/", { timeout: 10_000 });
    expect(dialogs.some((m) => m.includes("回收站"))).toBe(true);
    // 主列表只放 active 文档:删除后列表清空(回收站行不混排,v4 联调反馈)
    await expect(page.getByText("还没有打开过的文档")).toBeVisible({ timeout: 10_000 });
  });
});

test.describe("双端协同（真实 ws :3001,同一账号两个浏览器上下文）", () => {
  // 双用户各用独立 browser context：同 context 双标签会共享 IndexedDB/BroadcastChannel，
  // y-websocket 的 awareness 归属会错位（离开广播要等 ~30s 过期兜底）——真实多用户
  // （不同设备/浏览器）不存在此现象，测试按真实场景隔离。
  test("A 输入 B 收到；在线用户数 2；改名跨端同步", async ({ browser }) => {
    const { token } = await createAccount();
    const code = await createDoc(token);
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const a = await ctxA.newPage();
    const b = await ctxB.newPage();
    for (const [p, n] of [
      [a, "甲"],
      [b, "乙"],
    ] as const) {
      await p.addInitScript((t) => localStorage.setItem("polyphony.token", t), token);
      await p.goto(`/editor?code=${code}&name=${encodeURIComponent(n)}`);
      await expect(p.getByText("已连接", { exact: true })).toBeVisible({ timeout: 15_000 });
    }

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

    // A 改文档名 → B 顶栏同步
    await a.getByRole("button", { name: "未命名文档" }).click();
    const input = a.getByPlaceholder("输入文档名");
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
    const code = await createDoc(token);
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const a = await ctxA.newPage();
    const b = await ctxB.newPage();
    for (const [p, n] of [
      [a, "甲"],
      [b, "乙"],
    ] as const) {
      await p.addInitScript((t) => localStorage.setItem("polyphony.token", t), token);
      await p.goto(`/editor?code=${code}&name=${encodeURIComponent(n)}`);
      await expect(p.getByText("已连接", { exact: true })).toBeVisible({ timeout: 15_000 });
    }
    await expect(a.getByText("在线用户 (2)")).toBeVisible({ timeout: 15_000 });
    await b.close();
    // 跨设备场景：服务端按连接名单立即广播离开，无需等 awareness 过期
    await expect(a.getByText("在线用户 (1)")).toBeVisible({ timeout: 10_000 });
    await ctxB.close();
    await ctxA.close();
  });
});

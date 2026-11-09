// 桌面布局形态守护:双栏一屏、无外滚(与移动专项互补)。
import { expect, test } from "@playwright/test";
import { createDoc, loginTestAccount, seedStorage } from "./helpers";

test.describe("首页桌面形态", () => {
  test("双栏并存且整页一屏无外滚", async ({ page }) => {
    const acc = await loginTestAccount(page);
    // 建一个文档让右栏有内容(v4:码由服务端生成)
    await createDoc(acc.token, "桌面布局守护");
    await page.goto("/");
    await expect(page.getByText("桌面布局守护")).toBeVisible({ timeout: 10_000 });

    // 一屏无外滚(h-screen + 列表内部滚动)
    const overflowed = await page.evaluate(
      () =>
        document.documentElement.scrollHeight > document.documentElement.clientHeight
    );
    expect(overflowed).toBe(false);

    // 双栏:左栏(文档列表)与右栏详情占位横向并列;加入/新建在顶栏(联调反馈)
    const create = await page.getByRole("button", { name: "创建新文档" }).boundingBox();
    const listHeader = await page.getByText("我的文档", { exact: true }).boundingBox();
    const paneEmpty = await page.getByText("从左侧选择一个文档").boundingBox();
    expect(create).toBeTruthy();
    expect(listHeader).toBeTruthy();
    expect(paneEmpty).toBeTruthy();
    // 加入表单在顶栏:创建按钮在列表上方、且位于左栏右侧(顶栏右段,不再挤在左栏卡片里)
    expect(listHeader!.y).toBeGreaterThan(create!.y);
    expect(create!.x).toBeGreaterThan(listHeader!.x + 300);
    const join = await page.getByRole("button", { name: "加入文档" }).boundingBox();
    expect(Math.abs(join!.y - create!.y)).toBeLessThan(4);
    // 右栏详情区在左栏右侧
    expect(paneEmpty!.x).toBeGreaterThan(listHeader!.x + 100);

    // 创建按钮是顶栏小按钮(宽 < 25% 视口)
    const vw = page.viewportSize()!.width;
    expect(create!.width).toBeLessThan(vw * 0.25);
  });

  test("当前文档行有选中背景;同账号两端在线时面板按客户端区分并标注本机", async ({ browser }) => {
    const ctxA = await browser.newContext();
    const a = await ctxA.newPage();
    const acc = await loginTestAccount(a);
    await createDoc(acc.token, "选中态A");
    await createDoc(acc.token, "选中态B");
    // 同一账号的第二个连接(独立 context,模拟另一台设备)
    const ctxB = await browser.newContext();
    const b = await ctxB.newPage();
    await seedStorage(b, { token: acc.token });
    try {
      await a.goto("/");
      await a.getByRole("button", { name: "选中态A" }).click();
      await expect(a.getByRole("button", { name: "完整编辑器" })).toBeVisible({ timeout: 10_000 });
      const rowA = a.locator('[aria-current="true"]');
      await expect(rowA).toHaveCount(1);
      await expect(rowA).toContainText("选中态A");
      const bg = await rowA.evaluate((el) => getComputedStyle(el).backgroundColor);
      expect(bg).not.toBe("rgba(0, 0, 0, 0)");

      await b.goto("/");
      await b.getByRole("button", { name: "选中态A" }).click();
      await a.getByTitle("在线用户与更多操作").click();
      await a.getByRole("menuitem", { name: /在线用户 \(2\)/ }).click({ timeout: 15_000 });
      const rows = a.getByTestId("online-user");
      await expect(rows).toHaveCount(2);
      // 本机置顶并标注;两行都带客户端标签(Chrome · macOS 之类)
      await expect(rows.first()).toContainText("本机");
      await expect(rows.nth(1)).not.toContainText("本机");
      for (const i of [0, 1]) await expect(rows.nth(i)).toContainText(/ · /);
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });
});

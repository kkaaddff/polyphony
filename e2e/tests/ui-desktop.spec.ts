// 桌面布局形态守护:双栏一屏、无外滚(与移动专项互补)。
import { expect, test } from "@playwright/test";
import { createDoc, loginTestAccount } from "./helpers";

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

    // 双栏:创建按钮(左栏)与文档列表(右栏)横向并列
    const create = await page.getByRole("button", { name: "创建新文档" }).boundingBox();
    const listHeader = await page.getByText("我的文档", { exact: true }).boundingBox();
    expect(create).toBeTruthy();
    expect(listHeader).toBeTruthy();
    expect(listHeader!.x).toBeGreaterThan(create!.x + create!.width * 0.5);

    // 左栏为窄栏(创建按钮宽 < 60% 视口)
    const vw = page.viewportSize()!.width;
    expect(create!.width).toBeLessThan(vw * 0.6);
  });
});

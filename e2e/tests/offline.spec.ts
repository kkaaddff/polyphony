// 离线:服务器不可达时有明确的「离线」标签;文档照常秒开、可编辑,恢复连接后自动同步。
// 曾经:打开文档前先 await 状态查询,fetch 无超时 —— 服务器 IP 不可达时一挂几十秒,表现为打不开。
import { expect, test } from "@playwright/test";
import { captureDialogs, createDoc, loginTestAccount, seedStorage, simulateOutage } from "./helpers";

const editor = '[contenteditable="true"]';

test.describe("离线(桌面/Web)", () => {
  test("冷启动不可达:离线标签 → 文档秒开可写 → 恢复后标签消失且修改同步到服务器", async ({ page, browser }) => {
    const acc = await loginTestAccount(page);
    const code = await createDoc(acc.token, "离线草稿");
    const net = await simulateOutage(page);
    await page.goto("/");
    await expect(page.getByRole("button", { name: "离线草稿" })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("offline-tag")).toHaveCount(0);

    await net.down();
    await page.reload();
    await expect(page.getByTestId("offline-tag").first()).toBeVisible({ timeout: 8_000 });

    // 点开不等网络:编辑器 3s 内出现(以前要等状态查询超时/永远挂起)
    await page.getByRole("button", { name: "离线草稿" }).click();
    const ed = page.locator(editor).first();
    await expect(ed).toBeVisible({ timeout: 3_000 });
    await ed.click();
    await page.keyboard.type("断网时写下的内容");
    // 文档顶栏也是离线标签,不再刷「无法连接实时协作服务」红条
    await expect(page.getByTestId("offline-tag")).toHaveCount(2);
    await expect(page.getByText("无法连接实时协作服务")).toHaveCount(0);

    await net.up();
    await expect(page.getByTestId("offline-tag")).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByText("已连接", { exact: true })).toBeVisible({ timeout: 15_000 });

    // 另一台设备(同账号、直连服务器)读到离线期间的修改
    const ctx2 = await browser.newContext();
    const p2 = await ctx2.newPage();
    await seedStorage(p2, { token: acc.token });
    await p2.goto(`/editor?code=${code}&name=${encodeURIComponent(acc.name)}`);
    await expect(p2.getByText("断网时写下的内容")).toBeVisible({ timeout: 15_000 });
    await ctx2.close();
  });

  test("文档打开中断网:几秒内出现离线标签,恢复后回到「已连接」", async ({ page }) => {
    const acc = await loginTestAccount(page);
    await createDoc(acc.token, "在线中断网");
    const net = await simulateOutage(page);
    await page.goto("/");
    await page.getByRole("button", { name: "在线中断网" }).click();
    await expect(page.getByText("已连接", { exact: true })).toBeVisible({ timeout: 15_000 });

    await net.down();
    await expect(page.getByTestId("offline-tag").first()).toBeVisible({ timeout: 10_000 });
    // 点开标签是说明卡:修改存本机、联网后自动同步
    await page.getByTestId("offline-tag").last().click();
    await expect(page.getByText("修改都保存在本机，恢复连接后自动同步。")).toBeVisible();

    await net.up();
    await expect(page.getByText("已连接", { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("offline-tag")).toHaveCount(0, { timeout: 15_000 });
  });

  test("离线新建文档:明确提示需联网,而不是笼统的「创建失败」", async ({ page }) => {
    await loginTestAccount(page);
    const net = await simulateOutage(page);
    const dialogs = captureDialogs(page);
    await page.goto("/");
    await net.down();
    await page.reload();
    await expect(page.getByTestId("offline-tag").first()).toBeVisible({ timeout: 8_000 });
    await page.getByRole("button", { name: "创建新文档" }).click();
    await expect.poll(() => dialogs).toContain("离线时无法新建文档，请联网后重试");
  });
});

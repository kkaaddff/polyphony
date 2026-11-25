// 语音便签页(/notes):账号级便签流 —— 追加、手机端写入可见、搜索、删除、保留天数。
import { expect, test } from "@playwright/test";
import { captureDialogs, loginTestAccount } from "./helpers";

const API = "http://localhost:3001";

/** 模拟手机原生语音输入页「发送」后的便签上传。 */
async function postNote(token: string, text: string, createdAt?: number) {
  const res = await fetch(`${API}/notes`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ text, createdAt }),
  });
  if (!res.ok) throw new Error(`postNote failed: ${res.status}`);
}

test.describe("语音便签", () => {
  test("侧栏进入 → 空态 → 添加一条 → 刷新仍在", async ({ page }) => {
    await loginTestAccount(page);
    await page.goto("/");
    // v5:语音便签是侧栏分区导航按钮
    await page.getByRole("button", { name: "语音便签" }).click();
    await expect(page).toHaveURL(/\/notes$/);
    await expect(page.getByText(/还没有便签/)).toBeVisible();

    const input = page.getByRole("textbox", { name: /写一条便签/ });
    await expect(page.getByRole("button", { name: "添加" })).toBeDisabled();
    await input.fill("明天下午三点开会");
    await page.getByRole("button", { name: "添加" }).click();
    await expect(page.getByTestId("note")).toHaveCount(1);
    await expect(page.getByTestId("note").first()).toContainText("明天下午三点开会");
    await expect(input).toHaveValue("");

    await page.reload();
    await expect(page.getByTestId("note")).toHaveCount(1);
  });

  test("手机端写入的便签可见,按时间向下追加;搜索过滤;删除", async ({ page }) => {
    const acc = await loginTestAccount(page);
    const now = Date.now();
    await postNote(acc.token, "第一条:买牛奶", now - 3000);
    await postNote(acc.token, "第二条:进度 100% 完成", now - 2000);
    await postNote(acc.token, "第三条:回电话", now - 1000);

    await page.goto("/notes");
    const notes = page.getByTestId("note");
    await expect(notes).toHaveCount(3);
    await expect(notes.nth(0)).toContainText("第一条");
    await expect(notes.nth(2)).toContainText("第三条");

    const search = page.getByRole("searchbox", { name: "搜索便签" });
    await search.fill("100%");
    await expect(notes).toHaveCount(1);
    await expect(notes.first()).toContainText("第二条");
    await search.fill("查无此条");
    await expect(page.getByText("没有匹配的便签")).toBeVisible();
    await search.fill("");
    await expect(notes).toHaveCount(3);

    const dialogs = captureDialogs(page);
    await notes.nth(0).getByRole("button", { name: "删除" }).click();
    await expect(notes).toHaveCount(2);
    expect(dialogs[0]).toContain("删除这条便签");
    await page.reload();
    await expect(notes).toHaveCount(2);
  });

  test("保留天数:默认 30 天;改为 7 天后过期便签立即消失且设置持久", async ({ page }) => {
    const acc = await loginTestAccount(page);
    const day = 24 * 3600_000;
    await postNote(acc.token, "十天前的便签", Date.now() - 10 * day);
    await postNote(acc.token, "今天的便签");

    await page.goto("/notes");
    const select = page.getByRole("combobox", { name: "最多保留" });
    await expect(select).toHaveValue("30");
    await expect(page.getByTestId("note")).toHaveCount(2);

    await select.selectOption("7");
    await expect(page.getByTestId("note")).toHaveCount(1);
    await expect(page.getByTestId("note").first()).toContainText("今天的便签");

    await page.reload();
    await expect(page.getByRole("combobox", { name: "最多保留" })).toHaveValue("7");
  });

  test("未登录访问被守卫拦到欢迎页", async ({ page }) => {
    await page.goto("/notes");
    await expect(page).toHaveURL(/\/welcome\?next=%2Fnotes/);
  });

  // v4.3 交互(参照 iOS 信息):卡片固定高度两行省略;右滑 = 发送(免确认),左滑 = 删除(需确认);
  // 长按/轻点 = 预览(全文 + 删除/转文档/发送)。网页没有发送通道,右滑只提示。
  async function drag(page: import("@playwright/test").Page, fromX: number, toX: number, y: number) {
    await page.mouse.move(fromX, y);
    await page.mouse.down();
    await page.mouse.move(toX, y, { steps: 12 });
    await page.mouse.up();
  }

  test("卡片固定高度,正文最多两行省略", async ({ page }) => {
    const acc = await loginTestAccount(page);
    await postNote(acc.token, "短");
    await postNote(acc.token, "很长的便签".repeat(60));
    await page.goto("/notes");
    const notes = page.getByTestId("note");
    await expect(notes).toHaveCount(2);
    const [h1, h2] = [(await notes.nth(0).boundingBox())!.height, (await notes.nth(1).boundingBox())!.height];
    expect(Math.abs(h1 - h2)).toBeLessThan(1);
    const clamp = await notes.nth(1).locator("p").first().evaluate((el) => getComputedStyle(el).webkitLineClamp);
    expect(clamp).toBe("2");
  });

  test("手势:往左滑删除需确认;取消回弹,确认后消失", async ({ page }) => {
    const acc = await loginTestAccount(page);
    await postNote(acc.token, "待滑除的便签");
    await page.goto("/notes");
    const note = page.getByTestId("note").first();
    await expect(note).toBeVisible();
    const box = (await note.boundingBox())!;
    const cy = box.y + 20;

    page.once("dialog", (d) => d.dismiss());
    await drag(page, box.x + 240, box.x + 40, cy);
    await expect(note).toHaveCSS("transform", "none", { timeout: 2000 });
    await expect(page.getByTestId("note")).toHaveCount(1);

    page.once("dialog", (d) => {
      expect(d.message()).toContain("删除这条便签");
      void d.accept();
    });
    await drag(page, box.x + 240, box.x + 40, cy);
    await expect(page.getByTestId("note")).toHaveCount(0);
  });

  test("手势:往右滑 = 发送(不弹确认;桌面布局是接收端,提示到手机上发送),便签保留", async ({ page }) => {
    const acc = await loginTestAccount(page);
    await postNote(acc.token, "右滑发送的便签");
    await page.goto("/notes");
    const note = page.getByTestId("note").first();
    const box = (await note.boundingBox())!;
    let dialogs = 0;
    page.on("dialog", (d) => {
      dialogs++;
      void d.dismiss();
    });
    await drag(page, box.x + 40, box.x + 240, box.y + 20);
    await expect(page.getByText(/请在手机上的便签页发送到电脑/)).toBeVisible();
    expect(dialogs).toBe(0);
    await expect(page.getByTestId("note")).toHaveCount(1);
  });

  test("长按预览:全文可滚动,三个按钮;转文档打开新文档且便签保留", async ({ page }) => {
    const acc = await loginTestAccount(page);
    await postNote(acc.token, "预览便签第一行\n" + "很长的正文。".repeat(200));
    await page.goto("/notes");
    const note = page.getByTestId("note").first();
    const box = (await note.boundingBox())!;
    await page.mouse.move(box.x + 60, box.y + 20);
    await page.mouse.down();
    await page.waitForTimeout(650);
    await page.mouse.up();

    const preview = page.getByTestId("note-preview");
    await expect(preview).toBeVisible();
    await expect(preview.getByText(/预览便签第一行/)).toBeVisible();
    for (const name of ["删除", "转为文档", "发送到电脑"]) {
      await expect(preview.getByRole("button", { name, exact: true })).toBeVisible();
    }
    const scrollable = await preview.locator(".overflow-y-auto").first().evaluate((el) => el.scrollHeight > el.clientHeight);
    expect(scrollable).toBe(true);

    await preview.getByRole("button", { name: "转为文档", exact: true }).click();
    await expect(page).toHaveURL("/");
    await expect(page.locator('[contenteditable="true"]').first()).toContainText("预览便签第一行", { timeout: 10_000 });
    await page.getByRole("button", { name: "语音便签" }).click();
    await expect(page.getByTestId("note").first()).toContainText("预览便签第一行");
  });
});

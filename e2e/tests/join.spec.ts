// /join 扫码落地页:无凭据带 next 去引导;有凭据取账号名直进编辑器。
// v4:WS 进房前服务端校验文档存在,所有用例的码都先经 API 真实建文档。
import { expect, test } from "@playwright/test";
import { createDoc, loginTestAccount } from "./helpers";

test.describe("/join 分流", () => {
  test("无凭据:重定向 /welcome 并保留 next=落地地址", async ({ page }) => {
    await page.goto("/join?code=abcd1234&server=http%3A%2F%2Flocalhost%3A3001");
    await expect(page).toHaveURL(/\/welcome\?next=%2Fjoin%3Fcode%3DABCD1234/);
  });

  test("有凭据:账号名直进编辑器", async ({ page }) => {
    const acc = await loginTestAccount(page);
    const code = await createDoc(acc.token);
    await page.goto(`/join?code=${code}&server=http%3A%2F%2Flocalhost%3A3001`);
    await expect(page).toHaveURL(
      new RegExp(`/editor\\?code=${code}&name=${encodeURIComponent(acc.name)}$`)
    );
    // server 参数已固化
    const saved = await page.evaluate(() => localStorage.getItem("polyphony.server"));
    expect(saved).toBe("http://localhost:3001");
  });

  test("无文档码:登录态回首页", async ({ page }) => {
    await loginTestAccount(page);
    await page.goto("/join");
    await expect(page).toHaveURL("/");
  });

  test("超长码截断到 8 位:?join 预填与手输进同一文档(回归)", async ({ page }) => {
    const acc = await loginTestAccount(page);
    // 建两个真实文档,把完整码 pad 到 10 位:截断后应恰好等于码本身
    const codeA = await createDoc(acc.token);
    const codeB = await createDoc(acc.token);
    const longA = codeA + "ZZ"; // 10 位,截断 = codeA
    const longB = codeB + "ZZ";
    await page.goto(`/?join=${longA}`);
    await expect(page.locator("#roomCode")).toHaveValue(codeA);
    await page.getByRole("button", { name: "加入文档" }).click();
    // 加入 → 右栏面板打开;面板 RoomHeader 显示截断后的码
    const paneBtn = page.getByRole("button", { name: "完整编辑器" });
    await expect(paneBtn).toBeVisible({ timeout: 10_000 });
    // exact:左栏列表行(名称含「未命名文档 <码>」)也会匹配到模糊名,取顶栏码按钮
    await expect(page.getByRole("button", { name: codeA, exact: true })).toBeVisible();

    // /join 直达路径同样截断
    await page.goto(`/join?code=${longB}`);
    await expect(page.getByRole("button", { name: codeB, exact: true })).toBeVisible({
      timeout: 10_000,
    });
  });
});

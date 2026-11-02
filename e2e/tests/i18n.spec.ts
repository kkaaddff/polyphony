// i18n：英文渲染冒烟 + 设置页语言切换即时生效（登录态之下）。
import { expect, test } from "@playwright/test";
import { loginTestAccount, seedStorage, LOCALE_KEY } from "./helpers";

test.describe("i18n 语言", () => {
  test("locale=en：品牌与按钮渲染英文，无中文混排", async ({ page }) => {
    const acc = await loginTestAccount(page);
    await seedStorage(page, { locale: "en" });
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Polyphony", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Create document" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Join document" })).toBeVisible();
    // 顶栏身份区:账号名 + 地址
    await expect(page.getByText(acc.name, { exact: true })).toBeVisible();
    const h1 = await page.locator("h1").first().textContent();
    expect(h1?.trim()).toBe("Polyphony");
  });

  test("设置页切换 English → 中文：即时生效并持久化", async ({ page }) => {
    await loginTestAccount(page);
    await page.goto("/settings");
    // 默认 zh-CN（config 固定），标题为中文
    await expect(page.getByRole("heading", { name: "设置" })).toBeVisible();
    await page.getByRole("radio", { name: "English" }).click();
    // 同页即时切换（无需重载）
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
    expect(await page.evaluate((k) => localStorage.getItem(k), LOCALE_KEY)).toBe(
      JSON.stringify("en")
    );
    // 切回中文
    await page.getByRole("radio", { name: "中文", exact: true }).click();
    await expect(page.getByRole("heading", { name: "设置" })).toBeVisible();
  });

  test("locale 跟随系统(zh-CN runner)默认中文", async ({ page }) => {
    await loginTestAccount(page);
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Polyphony", exact: true })).toBeVisible();
  });
});

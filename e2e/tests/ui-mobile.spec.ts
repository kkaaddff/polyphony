// 移动端(Pixel 7 仿真)全页面 UI 专项:布局不破、不裁切、可点、触达达标。
// 背景:真机审计发现房间行按钮裁出屏外、编辑器横溢 51px、退出按钮被遮挡
// 点不动(交互损坏)——本套件用程序化布局断言守护(v3.4.0 重构的回归线)。
import { expect, test, type Page } from "@playwright/test";
import { createAccount, createDoc, loginTestAccount } from "./helpers";

/** 页面横向溢出 ≤1px(整页可左右晃 = 布局破)。 */
async function expectNoBreakout(page: Page) {
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow, "页面横向溢出").toBeLessThanOrEqual(1);
}

/** 所有可见按钮均在视口内(不裁切)。
 *  跳过位于横向滚动容器内的按钮(如 MDX 工具栏)——它们按设计可滚出视口。 */
async function expectButtonsInView(page: Page) {
  const out = await page.evaluate(() => {
    const vw = window.innerWidth;
    const inScrollStrip = (el: HTMLElement) => {
      for (let n = el.parentElement; n; n = n.parentElement) {
        const s = getComputedStyle(n);
        if (
          /auto|scroll/.test(s.overflowX) &&
          n.scrollWidth > n.clientWidth
        ) {
          return true;
        }
      }
      return false;
    };
    const bad: string[] = [];
    for (const b of document.querySelectorAll("button")) {
      const r = b.getBoundingClientRect();
      if (r.width > 0 && (r.right > vw + 1 || r.left < -1)) {
        if (inScrollStrip(b as HTMLElement)) continue;
        bad.push(`${b.textContent?.trim().slice(0, 8) || "?"}(${Math.round(r.right)}>${vw})`);
      }
    }
    return bad;
  });
  expect(out, "被裁切的按钮").toEqual([]);
}

/** 关键触达:指定按钮最小边 ≥38px(44 推荐值留 WebView 缩放余量)。 */
async function expectTapSize(page: Page, names: string[]) {
  for (const name of names) {
    const box = await page.getByRole("button", { name }).first().boundingBox();
    expect(box, `按钮应存在: ${name}`).toBeTruthy();
    if (!box) continue;
    expect(Math.min(box.width, box.height), `${name} 触达过小`).toBeGreaterThanOrEqual(38);
  }
}

/** 服务端建 3 个文档让右栏有内容(v4:码由服务端生成)。 */
async function seedThreeDocs(page: Page, token: string) {
  for (const base of ["MOBROOM1", "MOBROOM2", "MOBROOM3"]) {
    await createDoc(token, `移动${base}`);
  }
  // goto 而非 reload:调用方可能尚未导航(about:blank 上 reload 无效)
  await page.goto("/");
}

test.describe("去 web 化交互基线(v3.6.0)", () => {
  test("禁下拉刷新/点击灰闪/U 长按选中;输入区可选中;Web 版保留缩放", async ({ page }) => {
    await page.goto("/welcome");
    const styles = await page.evaluate(() => ({
      overscroll: getComputedStyle(document.documentElement).overscrollBehavior,
      tapHighlight: getComputedStyle(document.body).webkitTapHighlightColor,
      bodySelect: getComputedStyle(document.body).userSelect,
      inputSelect: getComputedStyle(document.querySelector("#server")!).userSelect,
      viewport: document
        .querySelector('meta[name="viewport"]')!
        .getAttribute("content"),
    }));
    expect(styles.overscroll).toBe("none");
    expect(styles.tapHighlight).toBe("rgba(0, 0, 0, 0)");
    expect(styles.bodySelect).toBe("none");
    expect(styles.inputSelect).not.toBe("none");
    // 全端禁缩放(ADR #31:用户拍板一致性优先):静态 meta 必须带 user-scalable=no
    expect(styles.viewport).toMatch(/user-scalable=no/i);
  });
});

test.describe("/welcome(移动)", () => {
  test("三入口表单:不破版、按钮可见可点", async ({ page }) => {
    await page.goto("/welcome");
    await expect(page.getByRole("heading", { name: "欢迎使用 Polyphony" })).toBeVisible();
    await expectNoBreakout(page);
    await expectButtonsInView(page);
    await expectTapSize(page, ["新建账号", "配对登录", "密钥登录"]);
  });

  test("配对页签:本机二维码 + 扫码按钮,不破版", async ({ page }) => {
    await page.goto("/welcome");
    await page.getByRole("button", { name: /配对登录/ }).click();
    // 服务端返回本机码后渲染二维码(canvas)与剩余时间
    await expect(page.getByText(/剩余 \d+:\d{2}/)).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("canvas")).toBeVisible();
    await expectNoBreakout(page);
    await expectButtonsInView(page);
  });

  test("恢复密钥页签:输入框可聚焦,不破版", async ({ page }) => {
    await page.goto("/welcome");
    await page.getByRole("button", { name: "密钥登录" }).click();
    await expect(page.locator("#recoveryKey")).toBeVisible();
    await expectNoBreakout(page);
  });
});

test.describe("首页(移动单列)", () => {
  test("单列纵排:创建按钮全宽;列表不裁切;图标按钮触达达标", async ({ page }) => {
    const acc = await loginTestAccount(page);
    await seedThreeDocs(page, acc.token);

    await expect(page.getByText("移动MOBROOM1")).toBeVisible({ timeout: 10_000 });
    await expectNoBreakout(page);
    await expectButtonsInView(page);

    // 移动端顶栏不显示品牌名(左上角留给内容;品牌在 welcome 页呈现)
    await expect(
      page.getByRole("heading", { name: "Polyphony", exact: true })
    ).toBeHidden();

    // 头像菜单:身份区必须靠右,面板完整落在视口内(真机实踩:justify-between 只剩一个
    // 子元素时身份区跑到左侧,右对齐面板顶出屏幕左缘、文字被裁)
    const avatar = page.getByTitle("账号菜单");
    const avatarBox = (await avatar.boundingBox())!;
    const vw = page.viewportSize()!.width;
    expect(avatarBox.x + avatarBox.width).toBeGreaterThan(vw * 0.75);
    await avatar.click();
    const menuBox = (await page.getByRole("menu").boundingBox())!;
    expect(menuBox.x).toBeGreaterThanOrEqual(0);
    expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(vw + 0.5);
    await page.keyboard.press("Escape");

    // 创建按钮=加入表单内的小按钮,与输入框同宽(同卡)
    const input = await page.locator("#roomCode").boundingBox();
    const create = await page.getByRole("button", { name: "创建新文档" }).boundingBox();
    expect(create!.width).toBeGreaterThan(input!.width - 4);

    // 文档行操作按钮触达(曾被裁出屏外的 ▦/✕)
    await expectTapSize(page, ["创建新文档", "加入文档"]);
    const qrBtns = page.getByTitle("显示二维码");
    expect(await qrBtns.count()).toBeGreaterThan(0);
    const qrBox = await qrBtns.first().boundingBox();
    expect(Math.min(qrBox!.width, qrBox!.height)).toBeGreaterThanOrEqual(38);
    // 所有者行操作是 🗑 删除(退出 ✕ 只属于成员行)
    const delBtn = page.getByTitle("删除文档（移入回收站）").first();
    const delBox = await delBtn.boundingBox();
    expect(Math.min(delBox!.width, delBox!.height)).toBeGreaterThanOrEqual(38);
  });

  test("所有者删除在移动端可用", async ({ page }) => {
    const acc = await loginTestAccount(page);
    await createDoc(acc.token, "移动删除");
    await page.goto("/");
    await expect(page.getByText("移动删除")).toBeVisible({ timeout: 10_000 });
    page.once("dialog", (d) => d.accept());
    await page.getByTitle("删除文档（移入回收站）").click();
    await expect(page.getByText("回收站", { exact: true }).first()).toBeVisible({
      timeout: 10_000,
    });
  });

  test("扫码弹层:无摄像头时切粘贴表单,打开不破版", async ({ page }) => {
    await loginTestAccount(page);
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "mediaDevices", {
        value: undefined,
        configurable: true,
      });
    });
    await page.goto("/");
    // 移动端扫码按钮仅剩 📷 图标(文案 sm 起显示),按 title 定位
    await page.getByTitle("扫房间二维码直接加入").click();
    await expect(page.getByText("或粘贴二维码内容 / 链接")).toBeVisible();
    await expectNoBreakout(page);
    await expectButtonsInView(page);
  });
});

test.describe("编辑器(移动)", () => {
  test("整页零横溢(曾溢出 51px);工具栏双行换行无内滚;退出文档可达(人数菜单)", async ({ page }) => {
    await loginTestAccount(page);
    await page.goto("/");
    await page.getByRole("button", { name: "创建新文档" }).click();
    // 创建 → 首页右栏面板;进「完整编辑器」页面继续(工具栏/底部面板/二维码弹层属完整页)
    await page.getByRole("button", { name: "完整编辑器" }).click();
    await expect(page).toHaveURL(/\/editor\?code=[A-Z0-9]{8}/);
    await expect(page.getByText("已连接", { exact: true })).toBeVisible({ timeout: 20_000 });

    await expectNoBreakout(page); // 核心回归:曾整页可左右晃
    await expectButtonsInView(page);

    // MDX 工具栏存在且双行换行 —— 自身无横向滚动(flex-wrap,而非撑破页面)
    const toolbar = page.locator(".mdxeditor-toolbar").first();
    await expect(toolbar).toBeVisible();
    expect(
      await toolbar.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)
    ).toBe(true);

    // 工具栏图标按钮触达:第三方原生 28px,移动端应抬到 ≥38px(真机 audit 发现)
    const tapSides = await page
      .locator(".mdxeditor-toolbar button")
      .evaluateAll((els) =>
        els.map((e) => {
          const r = e.getBoundingClientRect();
          return Math.min(r.width, r.height);
        })
      );
    const visible = tapSides.filter((s) => s > 0);
    expect(visible.length).toBeGreaterThan(0);
    expect(Math.min(...visible), "工具栏按钮触达过小").toBeGreaterThanOrEqual(38);

    // 交互级回归:「退出文档」收敛进人数菜单后仍必须真实可达;人数按钮自身触达 ≥38
    const countBtn = page.getByTitle(/在线用户/);
    const cb = await countBtn.boundingBox();
    expect(Math.min(cb!.width, cb!.height), "人数按钮触达过小").toBeGreaterThanOrEqual(38);
    await countBtn.click();
    await page.getByRole("menuitem", { name: "退出文档" }).click();
    await expect(page).toHaveURL("/");
  });

  test("在线用户底部面板:人数菜单打开 → 列表可见 → ESC/关闭按钮", async ({ page }) => {
    await loginTestAccount(page);
    await page.goto("/");
    await page.getByRole("button", { name: "创建新文档" }).click();
    // 创建 → 首页右栏面板;进「完整编辑器」页面继续(工具栏/底部面板/二维码弹层属完整页)
    await page.getByRole("button", { name: "完整编辑器" }).click();
    await expect(page).toHaveURL(/\/editor\?code=[A-Z0-9]{8}/);
    await expect(page.getByText("已连接", { exact: true })).toBeVisible({ timeout: 20_000 });

    // 移动端常驻侧栏应隐藏,改由顶栏人数菜单进入底部面板
    const usersText = page.getByText(/在线用户 \(1\)/);
    await expect(usersText).toBeHidden();

    const sheet = page.locator(".fixed.inset-0");
    await page.getByTitle(/在线用户/).click();
    await page.getByRole("menuitem", { name: /在线用户 \(1\)/ }).click();
    await expect(sheet.getByText(/在线用户 \(1\)/)).toBeVisible();
    await expectNoBreakout(page);

    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);

    // 重开 → 显式关闭按钮
    await page.getByTitle(/在线用户/).click();
    await page.getByRole("menuitem", { name: /在线用户 \(1\)/ }).click();
    await expect(sheet.getByText(/在线用户 \(1\)/)).toBeVisible();
    await sheet.getByTitle("关闭").click();
    await expect(sheet).toHaveCount(0);
  });

  test("二维码弹层在移动端不破版", async ({ page }) => {
    await loginTestAccount(page);
    await page.goto("/");
    await page.getByRole("button", { name: "创建新文档" }).click();
    // 创建 → 首页右栏面板;进「完整编辑器」页面继续(工具栏/底部面板/二维码弹层属完整页)
    await page.getByRole("button", { name: "完整编辑器" }).click();
    await expect(page).toHaveURL(/\/editor\?code=[A-Z0-9]{8}/);
    await expect(page.getByText("已连接", { exact: true })).toBeVisible({ timeout: 20_000 });
    await page.getByTitle(/在线用户/).click();
    await page.getByRole("menuitem", { name: "发送邀请" }).click();
    await expect(page.getByRole("heading", { name: "扫码进文档" })).toBeVisible();
    await expectNoBreakout(page);
  });
});

test.describe("设置(移动)", () => {
  test("按钮纵排全宽;不破版", async ({ page }) => {
    await loginTestAccount(page);
    await page.goto("/settings");
    await expect(page.getByRole("heading", { name: "设置" })).toBeVisible();
    await expectNoBreakout(page);
    // 纵排全宽 = 与输入框同宽(内容区撑满,视口无关;卡片 p-8 内边距已扣除)
    const input = await page.locator("#serverUrl").boundingBox();
    const test = await page.getByRole("button", { name: "测试连接" }).boundingBox();
    expect(test!.width).toBeGreaterThan(input!.width - 4);
  });

  test("已登录设备/恢复密钥/注销三段均在视口内", async ({ page }) => {
    await loginTestAccount(page);
    await page.goto("/settings");
    await expect(page.getByText("已登录设备")).toBeVisible();
    await expect(page.getByText("本机")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("恢复密钥", { exact: true })).toBeVisible();
    await expect(page.getByText("注销账号", { exact: true })).toBeVisible();
    await expectNoBreakout(page);
  });
});

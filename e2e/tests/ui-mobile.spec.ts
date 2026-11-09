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

/** 长按(移动端多选入口):按住超过 450ms 再松开。 */
async function longPress(page: Page, name: RegExp) {
  const box = (await page.getByRole("button", { name }).boundingBox())!;
  await page.mouse.move(box.x + 40, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(650);
  await page.mouse.up();
}

test.describe("首页(移动原生化,v4.1)", () => {
  test("列表页:大标题/搜索/分类/卡片不破版;顶栏与底部胶囊触达达标", async ({ page }) => {
    const acc = await loginTestAccount(page);
    await seedThreeDocs(page, acc.token);

    await expect(page.getByText("移动MOBROOM1")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole("heading", { name: "文档", exact: true })).toBeVisible();
    await expect(page.getByPlaceholder("搜索")).toBeVisible();
    await expectNoBreakout(page);
    await expectButtonsInView(page);
    await expectTapSize(page, ["多选", "更多", "扫码加入", "新建文档"]);

    // 左上角用户头像:点开抽屉(底部是账号名)
    const avatar = page.getByRole("button", { name: `账号:${acc.name}` });
    const avBox = (await avatar.boundingBox())!;
    expect(avBox.x).toBeLessThan(60);
    expect(avBox.width).toBeGreaterThanOrEqual(44);
    await avatar.click();
    const drawer = page.getByRole("dialog", { name: "分类" });
    await expect(drawer.getByText(acc.name)).toBeVisible();
    await drawer.getByRole("button", { name: "关闭" }).click();
    await expect(drawer).toHaveCount(0);

    // 更多菜单:锚在右上角,面板完整落在视口内
    const vw = page.viewportSize()!.width;
    await page.getByTitle("更多").click();
    const menuBox = (await page.getByRole("menu").boundingBox())!;
    expect(menuBox.x).toBeGreaterThanOrEqual(0);
    expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(vw + 0.5);
    await page.keyboard.press("Escape");
  });

  test("搜索与分类过滤;分类抽屉计数", async ({ page }) => {
    const acc = await loginTestAccount(page);
    await seedThreeDocs(page, acc.token);
    await expect(page.getByText("移动MOBROOM2")).toBeVisible({ timeout: 10_000 });

    await page.getByPlaceholder("搜索").fill("ROOM2");
    await expect(page.getByText("移动MOBROOM2")).toBeVisible();
    await expect(page.getByText("移动MOBROOM1")).toHaveCount(0);
    await page.getByPlaceholder("搜索").fill("");

    // 自建文档不出现在「共享给我」
    await page.getByRole("button", { name: "共享给我", exact: true }).click();
    await expect(page.getByText("还没有打开过的文档")).toBeVisible();
    await page.getByRole("button", { name: "全部", exact: true }).click();

    await page.getByRole("button", { name: "分类" }).click();
    const drawer = page.getByRole("dialog", { name: "分类" });
    await expect(drawer.getByRole("button", { name: /全部文档\s*3/ })).toBeVisible();
    await expectNoBreakout(page);
    await drawer.getByRole("button", { name: /我创建的/ }).click();
    await expect(drawer).toHaveCount(0);
    await expect(page.getByRole("button", { name: "我创建的", exact: true })).toHaveAttribute("aria-pressed", "true");
  });

  test("长按进入多选:置顶排到最前;删除进回收站", async ({ page }) => {
    const acc = await loginTestAccount(page);
    await seedThreeDocs(page, acc.token);
    await expect(page.getByText("移动MOBROOM1")).toBeVisible({ timeout: 10_000 });

    await longPress(page, /移动MOBROOM1/);
    await expect(page.getByRole("heading", { name: "已选中 1 项" })).toBeVisible();
    await expectButtonsInView(page);
    await page.getByRole("button", { name: "置顶" }).click();
    await expect(page.getByRole("heading", { name: "文档", exact: true })).toBeVisible();
    await expect(page.locator("li").first()).toContainText("移动MOBROOM1");

    // ☑ 进入多选(空选=请选择,操作条禁用)→ 选中 → 删除
    await page.getByTitle("多选").click();
    await expect(page.getByRole("heading", { name: "请选择" })).toBeVisible();
    await expect(page.getByRole("button", { name: "删除" })).toBeDisabled();
    await page.getByRole("button", { name: /移动MOBROOM3/ }).click();
    page.once("dialog", (d) => d.accept());
    await page.getByRole("button", { name: "删除" }).click();
    await expect(page.getByText("移动MOBROOM3")).toHaveCount(0, { timeout: 10_000 });
  });

  test("真机长按(松手后无 click)不吞掉下一次点击", async ({ page }) => {
    const acc = await loginTestAccount(page);
    await seedThreeDocs(page, acc.token);
    await expect(page.getByText("移动MOBROOM1")).toBeVisible({ timeout: 10_000 });

    // Android 真机长按:pointerdown → 按住 → pointerup,系统不派发 click(鼠标仿真会派发)
    const card1 = page.getByRole("button", { name: /移动MOBROOM1/ });
    await card1.dispatchEvent("pointerdown", { clientX: 40, clientY: 10, pointerType: "touch" });
    await page.waitForTimeout(650);
    await card1.dispatchEvent("pointerup", { pointerType: "touch" });
    await expect(page.getByRole("heading", { name: "已选中 1 项" })).toBeVisible();

    // 下一次正常点卡片必须生效(v4.1 真机实测:曾被残留的长按标记吞掉)
    await page.getByRole("button", { name: /移动MOBROOM2/ }).click();
    await expect(page.getByRole("heading", { name: "已选中 2 项" })).toBeVisible();
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
    await page.getByRole("button", { name: "扫码加入" }).click();
    await expect(page.getByText("或粘贴二维码内容 / 链接")).toBeVisible();
    await expectNoBreakout(page);
    await expectButtonsInView(page);
  });

  test("?join=CODE 落地:弹出加入面板并预填文档码", async ({ page }) => {
    const acc = await loginTestAccount(page);
    const code = await createDoc(acc.token, "移动加入");
    await page.goto(`/?join=${code}`);
    await expect(page.locator("#roomCode")).toHaveValue(code);
    await page.getByRole("button", { name: "加入文档" }).last().click();
    await expect(page.locator("[data-doc-title]")).toHaveValue("移动加入", { timeout: 10_000 });
  });
});

test.describe("文档页(移动原生化,v4.1)", () => {
  async function openNewDoc(page: Page) {
    await loginTestAccount(page);
    await page.goto("/");
    await page.getByRole("button", { name: "新建文档" }).click();
    await expect(page.getByText("已连接", { exact: true })).toBeVisible({ timeout: 20_000 });
  }

  test("阅读态 ↔ 编辑态:顶栏切换、悬浮工具栏、零横溢、触达达标", async ({ page }) => {
    await openNewDoc(page);
    await expectNoBreakout(page);
    await expectButtonsInView(page);
    await expectTapSize(page, ["返回", "分享", "更多"]);
    await expect(page.getByRole("button", { name: "待办清单" })).toBeHidden();

    await page.locator("[contenteditable]").click();
    await page.keyboard.type("移动正文");
    await expect(page.getByRole("button", { name: "完成" })).toBeVisible();
    await expect(page.getByRole("button", { name: "待办清单" })).toBeVisible();
    await expectTapSize(page, ["撤销", "重做", "完成", "待办清单", "文本格式"]);
    await expectNoBreakout(page);
    await expectButtonsInView(page);

    // 文本格式面板:正文 → 标题
    await page.getByRole("button", { name: "文本格式" }).click();
    await page.getByRole("button", { name: "标题", exact: true }).click();
    await expect(page.locator("[contenteditable] h1")).toHaveText("移动正文");
    await page.getByRole("button", { name: "撤销" }).click();
    await expect(page.locator("[contenteditable] h1")).toHaveCount(0);

    await page.getByRole("button", { name: "完成" }).click();
    await expect(page.getByRole("button", { name: "分享" })).toBeVisible();
    await expect(page.getByRole("button", { name: "待办清单" })).toBeHidden();
  });

  test("标题就地改名 → 返回列表可见新名", async ({ page }) => {
    await openNewDoc(page);
    await page.locator("[data-doc-title]").fill("移动改名");
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: "返回" }).click();
    await expect(page.getByRole("button", { name: /移动改名/ })).toBeVisible({ timeout: 10_000 });
  });

  test("在线用户面板:更多菜单打开 → 列表可见 → ESC 关闭", async ({ page }) => {
    await openNewDoc(page);
    const sheet = page.getByTestId("users-sheet");
    // 列表页留在下层但 inert + aria-hidden:按角色定位只命中文档页的「更多」
    await page.getByRole("button", { name: "更多" }).click();
    await page.getByRole("menuitem", { name: /在线用户 \(1\)/ }).click();
    await expect(sheet.getByText(/在线用户 \(1\)/)).toBeVisible();
    await expectNoBreakout(page);
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);
  });

  test("分享二维码弹层在移动端不破版", async ({ page }) => {
    await openNewDoc(page);
    await page.getByRole("button", { name: "分享" }).click();
    await expect(page.getByRole("heading", { name: "扫码进文档" })).toBeVisible();
    await expectNoBreakout(page);
  });

  test("/editor 在移动端转到首页文档页(扫码落地路径)", async ({ page }) => {
    const acc = await loginTestAccount(page);
    const code = await createDoc(acc.token, "移动直达");
    await page.goto(`/editor?code=${code}`);
    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator("[data-doc-title]")).toHaveValue("移动直达", { timeout: 10_000 });
    await page.getByRole("button", { name: "返回" }).click();
    await expect(page.getByRole("heading", { name: "文档", exact: true })).toBeVisible();
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

// 首页:登录守卫、双栏一屏布局、顶栏身份、创建/加入、我的文档(逐行退出)、回收站入口。
import { expect, test } from "@playwright/test";
import { captureDialogs, createAccount, createDoc, loginTestAccount, openShareSite, seedStorage } from "./helpers";

const API = "http://localhost:3001";

test.describe("守卫与顶栏身份", () => {
  test("无凭据:任意路由 → /welcome 引导", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/welcome\?next=%2F$/);
    await expect(
      page.getByRole("heading", { name: "欢迎使用 Polyphony" })
    ).toBeVisible();
  });

  test("已登录:双栏一屏 + 右上角头像菜单(不展示服务器地址)", async ({ page }) => {
    const acc = await loginTestAccount(page);
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "Polyphony", exact: true })
    ).toBeVisible();
    // 顶栏右上角:账号名 + 头像菜单;服务器地址不再常驻展示
    await expect(page.getByText(acc.name, { exact: true })).toBeVisible();
    await expect(page.getByTitle("账号菜单")).toBeVisible();
    await expect(page.getByText("http://localhost:3001")).toHaveCount(0);
    // 双栏:左操作右列表
    await expect(
      page.getByRole("button", { name: "创建新文档" })
    ).toBeVisible();
    await expect(page.getByText("我的文档", { exact: true })).toBeVisible();
    // 一屏无外滚(h-screen + 列表内部滚动)
    const overflowed = await page.evaluate(
      () =>
        document.documentElement.scrollHeight >
        document.documentElement.clientHeight
    );
    expect(overflowed).toBe(false);
  });

  test("创建新文档 → 右栏面板原地打开", async ({ page }) => {
    await loginTestAccount(page);
    await page.goto("/");
    await page.getByRole("button", { name: "创建新文档" }).click();
    // 不再跳完整编辑器:URL 不变,右栏 DocPane 打开(「完整编辑器」入口可见)
    await expect(page).toHaveURL("/");
    await expect(page.getByRole("button", { name: "完整编辑器" })).toBeVisible({ timeout: 10_000 });
  });

  test("空文档码加入:提示补全", async ({ page }) => {
    await loginTestAccount(page);
    const dialogs = captureDialogs(page);
    await page.goto("/");
    await page.getByRole("button", { name: "加入文档" }).click();
    await expect.poll(() => dialogs).toContain("请输入文档代码");
  });

  test("扫码:无摄像头环境回落粘贴表单(不静默关闭)", async ({ page }) => {
    const acc = await loginTestAccount(page);
    const code = await createDoc(acc.token, "粘贴进房");
    // http:// 直连等环境无 getUserMedia —— v4 直接切粘贴兜底,而非只报错
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "mediaDevices", {
        value: undefined,
        configurable: true,
      });
    });
    await page.goto("/");
    await page.getByTitle("扫房间二维码直接加入").click();
    await expect(page.getByText("或粘贴二维码内容 / 链接")).toBeVisible();
    // 粘贴 8 位码同样能进文档
    await page.locator("#pasteLink").fill(code);
    await page.getByRole("button", { name: "识别" }).click();
    // 加入 → 右栏面板打开(不再导航)
    await expect(page.getByRole("button", { name: "完整编辑器" })).toBeVisible({ timeout: 10_000 });
  });

  test("文档码加入 → 编辑器(不存在的码:提示缺失)", async ({ page }) => {
    const acc = await loginTestAccount(page);
    const code = await createDoc(acc.token);
    await page.goto("/");
    await page.locator("#roomCode").fill(code);
    await page.getByRole("button", { name: "加入文档" }).click();
    await expect(page.getByRole("button", { name: "完整编辑器" })).toBeVisible({ timeout: 10_000 });
  });

  test("加入不存在的文档:alert 提示且不进编辑器", async ({ page }) => {
    await loginTestAccount(page);
    const dialogs = captureDialogs(page);
    await page.goto("/");
    await page.locator("#roomCode").fill("NOSUCH99");
    await page.getByRole("button", { name: "加入文档" }).click();
    await expect.poll(() => dialogs).toContain("文档不存在或已被永久清除");
    await expect(page).toHaveURL("/");
  });
});

test.describe("我的文档(成员登记)", () => {
  test("创建→面板打开→退出面板→所有者删除→回收站→✕ 移出列表", async ({ page }) => {
    await loginTestAccount(page);
    await page.goto("/");
    await page.getByRole("button", { name: "创建新文档" }).click();
    await expect(page.getByRole("button", { name: "完整编辑器" })).toBeVisible({ timeout: 10_000 });
    // 面板人数菜单「退出文档」= 关闭面板回列表(文档已登记)
    await page.getByTitle("在线用户与更多操作").click();
    await page.getByRole("menuitem", { name: "退出文档" }).click();
    await expect(
      page.getByText("未命名文档", { exact: true })
    ).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTitle("退出该文档")).toHaveCount(0);
    await expect(page.getByTitle("删除文档（移入回收站）")).toHaveCount(1);

    // 删除(进回收站) → 主列表只放 active 文档:行直接消失,空态出现;
    // 回收站行不再混排进列表(v4 联调反馈「一列未命名·回收站全是噪音」)
    page.once("dialog", (d) => d.accept());
    await page.getByTitle("删除文档（移入回收站）").click();
    await expect(page.getByText("还没有打开过的文档")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("未命名文档", { exact: true })).toHaveCount(0);
    // 回收站弹窗里能看到它,可恢复
    await page.getByTitle("账号菜单").click();
    await page.getByRole("menuitem", { name: "回收站" }).click();
    await expect(page.getByRole("heading", { name: "回收站" })).toBeVisible();
    await page.getByRole("button", { name: "恢复" }).first().click();
    await expect(page.getByText("未命名文档", { exact: true })).toBeVisible({ timeout: 10_000 });
  });

  test("成员行逐个退出;owner 行只有删除没有退出(批量管理已移除)", async ({ page }) => {
    const other = await createAccount(); // 文档所有者(另一账号)
    const acc = await loginTestAccount(page); // 本页账号:纯成员
    for (const base of ["BATCH1", "BATCH2", "BATCH3"]) {
      const code = await createDoc(other.token, `批量${base}`);
      await fetch(`${API}/rooms/enter`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${acc.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ code }),
      });
    }
    await page.goto("/");
    await expect(page.getByText("批量BATCH1")).toBeVisible({ timeout: 10_000 });

    // 批量管理入口已移除(只对「加入别人的文档」有意义,自有文档下是空操作)
    await expect(page.getByRole("button", { name: /批量管理/ })).toHaveCount(0);
    await expect(page.locator('input[type="checkbox"]')).toHaveCount(0);

    // 成员行右侧 ✕ = 退出该文档,逐个退出
    for (const name of ["批量BATCH1", "批量BATCH2"]) {
      const row = page.locator("li", { hasText: name });
      page.once("dialog", (d) => d.accept());
      await row.getByTitle("退出该文档").click();
      await expect(page.getByText(name)).toHaveCount(0, { timeout: 10_000 });
    }
    await expect(page.getByText("批量BATCH3")).toBeVisible();
  });

  test("所有者删除:文档进回收站,回收站弹窗可恢复", async ({ page }) => {
    const acc = await loginTestAccount(page);
    await createDoc(acc.token, "待删文档");
    await page.goto("/");
    await expect(page.getByText("待删文档")).toBeVisible({ timeout: 10_000 });

    // 所有者行是 🗑(删除进回收站),confirm 自动接受
    page.once("dialog", (d) => d.accept());
    await page.getByTitle("删除文档（移入回收站）").click();
    // 主列表只放 active 文档:删除后行消失
    await expect(page.getByText("待删文档")).toHaveCount(0, { timeout: 10_000 });

    // 回收站弹窗:恢复后回到列表
    await page.getByTitle("账号菜单").click();
    await page.getByRole("menuitem", { name: "回收站" }).click();
    await expect(page.getByRole("heading", { name: "回收站" })).toBeVisible();
    await page.getByRole("button", { name: "恢复" }).first().click();
    await expect(page.getByText("待删文档").first()).toBeVisible({ timeout: 10_000 });
  });

  test("退出登录:头像菜单 confirm 后清凭据回引导页", async ({ page }) => {
    await loginTestAccount(page);
    await page.goto("/");
    page.once("dialog", (d) => d.accept());
    await page.getByTitle("账号菜单").click();
    await page.getByRole("menuitem", { name: "退出登录" }).click();
    await expect(page).toHaveURL(/\/welcome/);
  });

  test("分享本站:头像菜单 → 弹层展示服务器地址二维码", async ({ page }) => {
    await loginTestAccount(page);
    await page.goto("/");
    await openShareSite(page);
    await expect(page.getByText("http://localhost:3001")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("heading", { name: "扫码访问本站" })
    ).toBeHidden();
  });
});

test.describe("首页文档面板内容同步(回归)", () => {
  // MDXEditor 的 markdown 属性只在挂载时读一次;面板曾只靠它显示内容 → 打开已有内容的文档是空白、
  // 他人输入不出现,而在空白编辑器里敲字会按 diff 把全文删掉。两个独立 context 模拟两个用户。
  test("打开即见服务端正文;他人输入实时出现;本端输入不吞掉他人内容;切换文档无残影", async ({ browser }) => {
    const accA = await createAccount();
    const accB = await createAccount();
    const code = await createDoc(accA.token);
    await createDoc(accA.token, "另一篇");

    const ctxB = await browser.newContext();
    const b = await ctxB.newPage();
    await seedStorage(b, { token: accB.token });
    const ctxA = await browser.newContext();
    const a = await ctxA.newPage();
    await seedStorage(a, { token: accA.token });
    try {
      await b.goto(`/editor?code=${code}`);
      const eb = b.locator('[contenteditable="true"]').first();
      await eb.click();
      await b.keyboard.type("乙写的第一句");
      await expect(eb).toContainText("乙写的第一句");

      await a.goto("/");
      await a.getByRole("button", { name: /乙写的第一句|未命名文档/ }).first().click();
      const ea = a.locator('[contenteditable="true"]').first();
      await expect(ea).toContainText("乙写的第一句", { timeout: 10_000 });

      await eb.click();
      await b.keyboard.press("End");
      await b.keyboard.type("+乙续写");
      await expect(ea).toContainText("乙写的第一句+乙续写", { timeout: 10_000 });

      await ea.click();
      await a.keyboard.press("End");
      await a.keyboard.type("甲");
      await expect(eb).toContainText("乙写的第一句+乙续写甲", { timeout: 10_000 });

      // 切到另一篇:编辑器不残留上一篇正文
      await a.getByRole("button", { name: "另一篇" }).click();
      await expect(a.getByText("文档:")).toBeVisible();
      await expect(a.locator('[contenteditable="true"]').first()).not.toContainText("乙写的第一句", { timeout: 5_000 });
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });
});

test.describe("离线身份(回归)", () => {
  // 曾经:/auth/me 失败时账号为 null → 顶栏「匿名用户」、列表空、文档打不开。
  // 现在:上次在线校验的账号与房间簿按设备凭据缓存,离线冷启动照常展示。
  test("登录过一次后服务器不可达:仍是上次登录的用户,列表在,文档能打开", async ({ page }) => {
    const acc = await loginTestAccount(page);
    await createDoc(acc.token, "离线可见");
    await page.goto("/");
    await expect(page.getByText(acc.name).first()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole("button", { name: "离线可见" })).toBeVisible();

    // 服务器不可达(页面本身由 Vite 提供,只断 API/WS)
    await page.route("http://localhost:3001/**", (route) => route.abort("connectionrefused"));
    await page.reload();
    await expect(page.getByText(acc.name).first()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("匿名用户")).toHaveCount(0);
    await page.getByRole("button", { name: "离线可见" }).click();
    await expect(page.locator('[contenteditable="true"]').first()).toBeVisible({ timeout: 10_000 });
  });

  test("快照绑定设备凭据:换一个账号登录不会显示上一个账号", async ({ page }) => {
    const first = await loginTestAccount(page);
    await page.goto("/");
    await expect(page.getByText(first.name).first()).toBeVisible({ timeout: 10_000 });
    const second = await createAccount();
    // loginTestAccount 的 init script 每次加载都会写回第一个账号的凭据:再挂一个(按顺序后执行)覆盖它
    await page.addInitScript((t) => localStorage.setItem("polyphony.token", t), second.token);
    await page.route("http://localhost:3001/**", (route) => route.abort("connectionrefused"));
    await page.reload();
    await expect(page.getByText(first.name)).toHaveCount(0);
  });
});

// 真机端到端(v4 联调专用,不入 playwright 套件):
//   A. push 配对全链路:网页建号→「登录新设备」出链接→App 扫码弹层粘贴→claim→
//      网页「批准」→App 轮询 finalize 自动进入首页(此前轮询死循环必挂的主路径)
//   B. 协同收敛:App 建文档打字 → 网页同文档看到
//   C. 扫码器稳定性(截图对比)+ 取消按钮 + 返回键关弹层/退出 App
import { chromium } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";

// 用法:dev:lan 服务已起、手机 USB 连接且 App 已装,然后 `node phone-e2e.mjs`。
// LAN IP 运行时探测(仓库不落内网地址);也可 BASE 环境变量覆盖。
import { execSync as _es } from "node:child_process";
const LAN = process.env.BASE ?? _es("ipconfig getifaddr en0 || ipconfig getifaddr en1").toString().trim();
const API = `http://127.0.0.1:3001`;
const WEB = `http://${LAN}:3001`; // 与 App 保存的同源地址一致
const ADB = `${process.env.HOME}/Library/Android/sdk/platform-tools/adb`;
const PKG = "online.hengheng.polyphony";

const shot = (n) => _es(`${ADB} exec-out screencap -p > /tmp/e2e-${n}.png`);
const key4 = () => _es(`${ADB} shell input keyevent 4`);

let failures = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => { failures++; console.log(`  ✗ ${m}`); };

// ---------- 启动 App + CDP ----------
_es(`${ADB} shell am force-stop ${PKG}`);
_es(`${ADB} shell am start -n ${PKG}/.MainActivity`, { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 6000));
const pid = _es(`${ADB} shell pidof ${PKG}`).toString().trim().split(/\s+/)[0];
_es(`${ADB} forward --remove-all`, { stdio: "ignore" });
_es(`${ADB} forward tcp:9223 localabstract:webview_devtools_remote_${pid}`);
const b = await chromium.connectOverCDP("http://localhost:9223");
const app = b.contexts()[0].pages()[0];

// ---------- A. push 配对 ----------
console.log("[A] push 配对:网页批准 → App 自动登录");
const web = await chromium.launch({ channel: "chrome", headless: true });
const wp = await (await web.newContext()).newPage();

const secret = randomBytes(24).toString("hex");
const name = "e2e-" + Date.now().toString(36).slice(-6);
const cr = await fetch(`${API}/auth/create`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name, secret, platform: { client: "web", os: "macos" } }),
}).then((r) => r.json());
const token = `poly_d_${cr.deviceId}_${secret}`;
await wp.addInitScript((t) => localStorage.setItem("polyphony.token", t), token);
await wp.goto(`${WEB}/`);
await wp.getByTitle("账号菜单").click();
await wp.getByRole("menuitem", { name: "登录新设备" }).click();
await wp.getByRole("button", { name: "或复制配对链接" }).click();
const linkInput = wp.getByRole("textbox", { name: "或复制配对链接" });
await linkInput.waitFor({ timeout: 10_000 });
const pairUrl = await linkInput.inputValue();
ok(`配对链接已生成(${pairUrl.slice(0, 44)}…)`);

// App:清态回欢迎页 → 配对页签 → 扫码 → 改用粘贴 → 粘贴链接 → 识别
await app.evaluate((s) => {
  localStorage.clear();
  localStorage.setItem("polyphony.server", s);
}, WEB);
await app.reload();
await app.getByRole("button", { name: "扫码" }).waitFor({ timeout: 15_000 });
await app.getByRole("button", { name: "扫码" }).click();
await app.getByRole("button", { name: "改用粘贴" }).waitFor({ timeout: 10_000 });
await app.getByRole("button", { name: "改用粘贴" }).click();
await app.locator("#pasteLink").fill(pairUrl);
await app.getByRole("button", { name: "识别" }).click();
await app.getByRole("heading", { name: "请在发起设备上确认" }).waitFor({ timeout: 10_000 });
ok("App 已 claim,停在等待确认页");

const approve = wp.getByRole("button", { name: "批准", exact: true });
await approve.waitFor({ timeout: 10_000 });
await approve.click();
ok("网页已批准");

// 修复点:App 轮询必须接住 approved 并自动进入首页
await app.waitForURL("**/", { timeout: 20_000 }).then(
  () => ok("App 自动登录并进入首页"),
  () => bad("App 未在 20s 内自动进入首页(轮询仍未工作)")
);
const appToken = await app.evaluate(() => localStorage.getItem("polyphony.token"));
appToken?.startsWith("poly_d_") ? ok("App 已持有设备凭据") : bad("App 无凭据");
await app.getByText(name, { exact: true }).waitFor({ timeout: 10_000 }).then(
  () => ok(`顶栏显示账号 ${name}`),
  () => bad("顶栏未见账号名")
);

// ---------- B. 协同收敛 ----------
console.log("[B] 协同收敛:App 建档打字 → 网页同文档可见");
await app.getByRole("button", { name: "创建新文档" }).click();
await app.getByText("已连接", { exact: true }).waitFor({ timeout: 15_000 }).then(
  () => ok("DocPane WS 已连接"),
  () => bad("DocPane 未连接")
);
const marker = "APP-E2E-MARKER-9f3";
const ed = app.locator('[contenteditable="true"]').first();
await ed.click();
await ed.type(marker);
const codeBtn = app.locator('button[title="点击复制邀请链接"]');
const code = (await codeBtn.textContent())?.trim();
code?.length === 8 ? ok(`文档码 ${code}`) : bad(`文档码异常:${code}`);

await wp.keyboard.press("Escape");
await wp.goto(`${WEB}/editor?code=${code}&name=${encodeURIComponent("网页端")}`);
await wp.getByText("已连接", { exact: true }).waitFor({ timeout: 15_000 });
await wp
  .waitForFunction((m) => document.body.innerText.includes(m), marker, { timeout: 15_000 })
  .then(
    () => ok(`网页端看到 App 输入的「${marker}」`),
    () => bad("网页端未见 App 输入内容")
  );

// ---------- C. 扫码器稳定性 / 返回键 ----------
console.log("[C] 扫码器与返回键");
await app.goto("http://tauri.localhost/");
await app.getByTitle("扫房间二维码直接加入").waitFor({ timeout: 10_000 });
await app.getByTitle("扫房间二维码直接加入").click();
await app.getByRole("button", { name: "取消" }).waitFor({ timeout: 10_000 });
await new Promise((r) => setTimeout(r, 3500)); // 相机起稳
for (let i = 1; i <= 4; i++) { await new Promise((r) => setTimeout(r, 500)); shot(`cam${i}`); }
ok("连续 4 帧截图已存(/tmp/e2e-cam1..4.png,人工核对是否稳定不闪)");
await app.getByRole("button", { name: "取消" }).click();
(await app.getByRole("button", { name: "取消" }).count()) === 0
  ? ok("「取消」能退出扫码")
  : bad("取消后扫码弹层仍在");

// 返回键:首页根路由 → 退出 App(回桌面)
key4();
await new Promise((r) => setTimeout(r, 1500));
const focus = _es(`${ADB} shell dumpsys window | grep mCurrentFocus`).toString();
focus.includes(PKG) ? bad(`返回键未退出 App(focus=${focus.trim().slice(0, 60)})`) : ok("首页返回键 → 退出 App 到桌面");

console.log(failures === 0 ? "\n全部通过 ✓" : `\n${failures} 项失败 ✗`);
await web.close();
await b.close();
process.exit(failures === 0 ? 0 : 1);

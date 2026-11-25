// 远程语音输入 · 桌面端到端驱动(容器内运行,见 run.sh / entry.sh)。
// 真实部件:Polyphony 服务端、Polyphony 桌面壳(Tauri,经 WebDriver 操作其设置页)、Fcitx5 + 本仓库插件、真实应用。
// 扮演的只有手机:一个按线上协议说话的 WS 发送端(docs/voice-input.md §4)。
// 每个应用:聚焦输入区 → 手机逐帧发快照(含一次识别修正)→ 截图(Preedit)→ 手机「发送」→ 截图 → 读回应用里的文本。
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";

const MODE = ["wayland", "gnome"].includes(process.argv[2]) ? process.argv[2] : "x11";
const ONLY = process.argv.slice(3);
const OUT = "/out";
const BASE = "http://127.0.0.1:3001";
const APP_BIN = "/work/target/debug/polyphony";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => {
  console.log("[e2e]", ...a);
  try {
    fs.appendFileSync(`${OUT}/${MODE}-progress.log`, a.join(" ") + "\n");
    fs.copyFileSync("/tmp/fcitx5.log", `${OUT}/${MODE}-fcitx5.log`);
  } catch {
    /* 尽力而为 */
  }
};

function sh(cmd, opts = {}) {
  // 每条外部命令都有超时:xdotool/xclip 之类挂住时不拖死整轮
  const r = spawnSync("bash", ["-c", cmd], { encoding: "utf8", timeout: 15000, killSignal: "SIGKILL", ...opts });
  if (r.error) console.log("[e2e] 命令超时/失败:", cmd.slice(0, 80));
  return (r.stdout ?? "").trim();
}
function bg(cmd, name) {
  const out = fs.openSync(`/tmp/${name}.log`, "a");
  const p = spawn("bash", ["-c", cmd], { detached: true, stdio: ["ignore", out, out] });
  p.unref();
  return p;
}
function killGroup(p) {
  try {
    process.kill(-p.pid, "SIGKILL");
  } catch {
    /* 已退出 */
  }
}
async function until(fn, what, timeoutMs = 20000, stepMs = 200) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timeout: ${what}`);
    await sleep(stepMs);
  }
}

// ---------------------------------------------------------------- 显示服务器适配(X11 / sway)

/** GNOME Shell(--unsafe-mode)里执行 JS;返回其字符串结果 */
function shellEval(js) {
  const out = sh(`gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell --method org.gnome.Shell.Eval ${JSON.stringify(js).replace(/\$/g, "\\$").replace(/`/g, "\\`")}`);
  const m = out.match(/^\((true|false), '(.*)'\)$/s);
  return m && m[1] === "true" ? m[2].replace(/^"|"$/g, "") : "";
}
const GKEY = { ctrl: "Control_L", shift: "Shift_L" };
const gnomeWm = {
  shot: (file) => sh(`gdbus call --session --dest org.gnome.Shell.Screenshot --object-path /org/gnome/Shell/Screenshot --method org.gnome.Shell.Screenshot.Screenshot false false ${OUT}/${file} >/dev/null`),
  find: (pattern) =>
    shellEval(
      `(() => { const re = new RegExp(${JSON.stringify(pattern)}, "i"); const w = global.get_window_actors().map(a => a.meta_window).filter(w => re.test((w.get_wm_class() || "") + " " + (w.get_title() || ""))).pop(); return w ? String(w.get_id()) : ""; })()`
    ),
  place: (id) => gnomeWm.activate(id),
  click: () => "",
  activate: (id) =>
    shellEval(
      `(() => { if (Main.overview.visible) Main.overview.hide(); const w = global.get_window_actors().map(a => a.meta_window).find(w => String(w.get_id()) === "${id}"); if (w) w.activate(global.get_current_time()); return "ok"; })()`
    ),
  title: (id) =>
    shellEval(`(() => { const w = global.get_window_actors().map(a => a.meta_window).find(w => String(w.get_id()) === "${id}"); return w ? w.get_title() : ""; })()`),
  /** 通过合成器的虚拟键盘设备按键(等同真实键盘:会经过输入法) */
  key: (keys) => {
    for (const combo of keys.split(" ")) {
      const parts = combo.split("+").map((k) => GKEY[k] ?? k);
      shellEval(
        `(() => { const C = imports.gi.Clutter; if (!global._e2eKb) global._e2eKb = C.get_default_backend().get_default_seat().create_virtual_device(C.InputDeviceType.KEYBOARD_DEVICE); const kb = global._e2eKb; const ks = ${JSON.stringify(parts)}.map(k => C["KEY_" + k]); let t = global.get_current_time() || Math.floor(Date.now() / 1000) * 1000; for (const k of ks) kb.notify_keyval(t++ * 1000, k, C.KeyState.PRESSED); for (const k of ks.reverse()) kb.notify_keyval(t++ * 1000, k, C.KeyState.RELEASED); return "ok"; })()`
      );
      sh("sleep 0.15");
    }
  },
  type: (text) => gnomeWm.key([...text].join(" ")),
  clipboard: () => "",
  clearClipboard: () => "",
};

const wm =
  MODE === "gnome"
    ? gnomeWm
    : MODE === "x11"
    ? {
        shot: (file) => sh(`import -window root ${OUT}/${file}`),
        /** 等待窗口出现并返回 id */
        find: (pattern) => sh(`xdotool search --onlyvisible ${pattern} 2>/dev/null | tail -1`),
        place: (id) => sh(`xdotool windowactivate --sync ${id}; xdotool windowmove ${id} 10 10; xdotool windowsize ${id} 900 600`),
        click: (id, x, y) => sh(`xdotool mousemove --window ${id} ${x} ${y} click 1`),
        activate: (id) => sh(`xdotool windowactivate --sync ${id}`),
        key: (keys) => sh(`xdotool key --clearmodifiers ${keys}`),
        type: (text) => sh(`xdotool type --delay 30 ${JSON.stringify(text)}`),
        clipboard: () => sh(`xclip -o -selection clipboard 2>/dev/null`),
        // xclip 会留在后台持有选区:必须断开它的标准流,否则 spawnSync 永远等不到管道关闭
        clearClipboard: () => sh(`xclip -i -selection clipboard /dev/null >/dev/null 2>&1 </dev/null`),
      }
    : {
        shot: (file) => sh(`grim ${OUT}/${file}`),
        find: (pattern) =>
          sh(`swaymsg -t get_tree | node -e '
            let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
              const re=new RegExp(${JSON.stringify(pattern)},"i");let hit="";
              const walk=n=>{const id=(n.app_id||"")+" "+((n.window_properties||{}).class||"")+" "+(n.name||"");
                if(n.pid&&(n.type==="con"||n.type==="floating_con")&&re.test(id))hit=String(n.id);
                (n.nodes||[]).concat(n.floating_nodes||[]).forEach(walk)};
              walk(JSON.parse(s));console.log(hit)})'`),
        place: (id) => sh(`swaymsg '[con_id=${id}] focus' >/dev/null`),
        // sway 无头没有指针设备:窗口全屏后靠应用自身的初始焦点(各应用启动即聚焦文本区)
        click: () => "",
        activate: (id) => sh(`swaymsg '[con_id=${id}] focus' >/dev/null`),
        key: (keys) =>
          sh(
            keys
              .split(" ")
              .map((k) => {
                const parts = k.split("+");
                const key = parts.pop();
                const mods = parts.map((m) => `-M ${m}`).join(" ");
                return `wtype ${mods} -k ${key}`;
              })
              .join("; ")
          ),
        type: (text) => sh(`wtype -d 30 ${JSON.stringify(text)}`),
        clipboard: () => sh(`timeout 2 wl-paste -n 2>/dev/null`),
        clearClipboard: () => sh(`wl-copy --clear 2>/dev/null`),
      };

// ---------------------------------------------------------------- 服务端与账号

async function startServer() {
  bg(`cd /work/src/server && PORT=3001 DATA_DIR=/tmp/e2e-data node --disable-warning=ExperimentalWarning index.js`, "server");
  await until(() => fetch(`${BASE}/health`).then((r) => r.ok).catch(() => false), "server up");
}

async function createAccounts() {
  const post = (path, body) =>
    fetch(`${BASE}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
  const s1 = crypto.randomBytes(24).toString("hex");
  const acc = await post("/auth/create", { name: `e2e-${Date.now()}`, secret: s1, platform: { client: "app", os: "linux" } });
  const s2 = crypto.randomBytes(24).toString("hex");
  const phone = await post("/auth/exchange", { key: acc.recoveryKey, secret: s2, platform: { client: "app", os: "android" } });
  return { desktopToken: `poly_d_${acc.deviceId}_${s1}`, phoneToken: `poly_d_${phone.deviceId}_${s2}` };
}

// ---------------------------------------------------------------- 真实桌面壳(WebDriver)

class Desktop {
  async start(token) {
    bg(`tauri-driver --port 4444`, "tauri-driver");
    await until(() => fetch("http://127.0.0.1:4444/status").then((r) => r.ok).catch(() => false), "tauri-driver up");
    const res = await this.wd("POST", "/session", {
      capabilities: { alwaysMatch: { browserName: "wry", "tauri:options": { application: APP_BIN } } },
    });
    this.sid = res.sessionId;
    // 登录态与服务器地址:直接写桌面壳自己的 localStorage(等价于在欢迎页登录过)
    await this.exec(
      `localStorage.setItem("polyphony.token", arguments[0]);
       localStorage.setItem("polyphony.server", arguments[1]);
       localStorage.setItem("polyphony.locale", JSON.stringify("zh"));
       window.location.assign("/settings");`,
      [token, BASE]
    );
    await until(() => this.text().then((t) => t.includes("远程语音输入")), "settings page with voice section");
    // 真实点击设置页的开关
    const el = await this.wd("POST", `/session/${this.sid}/element`, {
      using: "xpath",
      value: `//label[contains(., "允许这台电脑接收")]/input`,
    });
    const elId = Object.values(el)[0];
    await this.wd("POST", `/session/${this.sid}/element/${elId}/click`, {});
    await until(() => this.text().then((t) => t.includes("已连接服务器")), "desktop connected to server");
    await until(() => this.text().then((t) => t.includes("输入法插件已连接")), "fcitx5 plugin connected to desktop socket", 15000);
  }
  async wd(method, path, body) {
    const r = await fetch(`http://127.0.0.1:4444${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const j = await r.json();
    if (j.value && j.value.error) throw new Error(`webdriver ${path}: ${j.value.message}`);
    return j.value;
  }
  exec(script, args = []) {
    return this.wd("POST", `/session/${this.sid}/execute/sync`, { script, args });
  }
  text() {
    return this.exec("return document.body.innerText;").catch(() => "");
  }
  async screenshot(file) {
    await this.exec(`[...document.querySelectorAll("label")].find((l) => l.textContent.includes("允许这台电脑接收"))?.scrollIntoView({ block: "center" });`).catch(() => {});
    await sleep(300);
    const b64 = await this.wd("GET", `/session/${this.sid}/screenshot`);
    fs.writeFileSync(`${OUT}/${file}`, Buffer.from(b64, "base64"));
  }
}

// ---------------------------------------------------------------- 扮演手机

class Phone {
  async connect(token) {
    this.inbox = [];
    this.ws = new WebSocket(`${BASE.replace("http", "ws")}/_input?role=sender`, ["polyphony.v1", `auth.${token}`]);
    this.ws.onmessage = (e) => this.inbox.push(JSON.parse(e.data));
    await new Promise((res, rej) => {
      this.ws.onopen = res;
      this.ws.onerror = () => rej(new Error("phone ws failed"));
    });
    await until(() => this.inbox.find((m) => m.type === "peers" && m.target), "phone sees the desktop as target");
  }
  begin() {
    this.session = crypto.randomUUID();
    this.seq = 0;
    this.rev = 0;
    this.mark = this.inbox.length;
    this.send({ type: "session.start" });
  }
  send(extra) {
    this.ws.send(JSON.stringify({ v: 1, session_id: this.session, seq: this.seq++, ...extra }));
  }
  async snapshot(text) {
    const seq = this.seq;
    this.send({
      type: "text.snapshot",
      revision: ++this.rev,
      text,
      selection_start: text.length,
      selection_end: text.length,
      composing_start: 0,
      composing_end: text.length,
      timestamp_ms: Date.now(),
    });
    return until(() => this.since().find((m) => m.type === "ack" && m.seq === seq), `ack for snapshot seq=${seq}`, 5000, 20);
  }
  finish(text) {
    this.send({ type: "session.finish", revision: ++this.rev, text });
  }
  cancel() {
    this.send({ type: "session.cancel" });
  }
  since() {
    return this.inbox.slice(this.mark).filter((m) => m.session_id === this.session);
  }
  statuses() {
    return this.since().filter((m) => m.type === "session.status").map((m) => (m.reason ? `${m.status}/${m.reason}` : m.status));
  }
  waitStatus(status, timeoutMs = 5000) {
    return until(() => this.statuses().find((s) => s.startsWith(status)), `status ${status}`, timeoutMs, 20).catch(() => null);
  }
}

// ---------------------------------------------------------------- 应用清单

const CHROME = sh(`ls -d /opt/pw/chromium-*/chrome-linux/chrome | head -1`);
const PAGE = `data:text/html,<meta charset=utf-8><title>e2e-chromium</title><textarea id=t autofocus style="width:95vw;height:85vh;font-size:22px" oninput="${process.argv[2] === "gnome" ? "document.title=String.fromCharCode(69,50,69,58)+this.value" : ""}"></textarea>`;
const copyAll = async () => {
  wm.clearClipboard();
  wm.key("ctrl+a");
  await sleep(200);
  wm.key("ctrl+c");
  await sleep(400);
  return wm.clipboard();
};
/** 终端类:应用里跑 `cat > 文件`,提交后回车 + Ctrl-D,读文件 */
const catFile = (id) => async () => {
  wm.key("Return");
  await sleep(200);
  wm.key("ctrl+d");
  await sleep(500);
  return fs.existsSync(`/tmp/out-${id}.txt`) ? fs.readFileSync(`/tmp/out-${id}.txt`, "utf8") : "";
};
const wl = MODE === "wayland"; // sway
const gn = MODE === "gnome";
/** 读回:保存到文件再读(GNOME 无头会话没有可用的剪贴板工具) */
const saveAndRead = (path) => async () => {
  wm.key("ctrl+s");
  await sleep(1200);
  return fs.existsSync(path) ? fs.readFileSync(path, "utf8") : "";
};
const readFile = (path) => async () => {
  await sleep(300);
  return fs.existsSync(path) ? fs.readFileSync(path, "utf8") : "";
};

const APPS = [
  {
    id: "gedit",
    desc: "GTK3 编辑器 gedit",
    cmd: "gedit --standalone /tmp/gedit-e2e.txt",
    // GNOME Wayland 下 gedit 的新窗口要等第一次按键后才向输入法登记焦点(实测):先按一个键再删掉
    primeKey: gn,
    match: wl || gn ? "gedit" : "--class gedit",
    // 读回走「保存到文件」:sway 下 wtype 的 Ctrl+A/C 在 gedit 里读不回
    read: async () => {
      wm.key("ctrl+s");
      await sleep(1000);
      return fs.existsSync("/tmp/gedit-e2e.txt") ? fs.readFileSync("/tmp/gedit-e2e.txt", "utf8") : "";
    },
  },
  {
    id: "gnome-text-editor",
    desc: "GTK4 编辑器 gnome-text-editor",
    cmd: gn ? "echo -n > /tmp/gte-e2e.txt; gnome-text-editor --standalone /tmp/gte-e2e.txt" : "gnome-text-editor --standalone",
    match: wl || gn ? "TextEditor|gte-e2e" : "--class gnome-text-editor",
    refocus: true,
    read: gn ? saveAndRead("/tmp/gte-e2e.txt") : copyAll,
  },
  { id: "gtk4-textview", desc: "纯 GTK4 TextView(对照样本)", cmd: "python3 /work/src/fcitx5/e2e/gtk4-textview.py", match: gn ? "e2e-gtk4-textview" : wl ? "e2e.gtk4" : "--name e2e-gtk4-textview", read: gn ? readFile("/tmp/out-gtk4.txt") : copyAll },
  {
    id: "featherpad",
    desc: "Qt 编辑器 FeatherPad",
    cmd: gn ? "echo -n > /tmp/fp-e2e.txt; featherpad --standalone /tmp/fp-e2e.txt" : "featherpad --standalone",
    match: wl || gn ? "featherpad" : "--class featherpad",
    read: gn ? saveAndRead("/tmp/fp-e2e.txt") : copyAll,
  },
  !wl && { id: "xterm", desc: "终端 xterm(XIM)", cmd: `xterm -fa 'Noto Sans Mono CJK SC' -fs 14 -e sh -c 'cat > /tmp/out-xterm.txt'`, match: gn ? "xterm" : "--class XTerm", read: catFile("xterm") },
  { id: "xfce4-terminal", desc: "终端 xfce4-terminal(VTE)", cmd: `xfce4-terminal --disable-server -x sh -c 'cat > /tmp/out-xfce4-terminal.txt'`, match: wl || gn ? "xfce4-terminal" : "--class xfce4-terminal", read: catFile("xfce4-terminal") },
  (wl || gn) && { id: "foot", desc: "终端 foot(Wayland 原生)", cmd: `foot sh -c 'cat > /tmp/out-foot.txt'`, match: "foot", read: catFile("foot") },
  {
    id: "chromium",
    desc: "Chromium 网页 textarea",
    cmd: `${CHROME} --no-sandbox --no-first-run --no-default-browser-check --user-data-dir=/tmp/chromium-profile ${wl ? "--ozone-platform=wayland --enable-wayland-ime --wayland-text-input-version=3" : ""} --window-size=900,600 '${PAGE}'`,
    match: gn ? "e2e-chromium|E2E:" : wl ? "chrom" : "--name e2e-chromium",
    // GNOME:页面把 textarea 的值同步到标题,从窗口标题读回
    read: gn
      ? async function () {
          await sleep(400);
          return wm.title(this.winId).replace(/^E2E:/, "").replace(/ - Chromium$/, "");
        }
      : copyAll,
  },
  {
    id: "vscode",
    desc: "VS Code(Electron)编辑器",
    cmd: `echo -n > /tmp/vscode-e2e.txt; code --no-sandbox --user-data-dir=/tmp/vscode-profile --disable-workspace-trust --skip-welcome --skip-release-notes --disable-telemetry ${wl ? "--ozone-platform=wayland --enable-wayland-ime --wayland-text-input-version=3" : ""} --wait /tmp/vscode-e2e.txt`,
    match: gn ? "vscode-e2e" : wl ? "code" : "--name vscode-e2e.txt",
    settle: 6000,
    read: async () => {
      wm.key("ctrl+s");
      await sleep(1200);
      return fs.readFileSync("/tmp/vscode-e2e.txt", "utf8");
    },
  },
].filter(Boolean);

// ---------------------------------------------------------------- 场景

const STEPS = ["今天", "今天天气", "今天天气真好", "今天天气真好我们去", "今天天气真不错,我们去公园"]; // 最后一帧是识别修正(改写中段)
const FINAL = "今天天气真不错,我们去公园散步。";

async function open(app) {
  if (app.id === "gedit") fs.rmSync("/tmp/gedit-e2e.txt", { force: true });
  const proc = bg(app.cmd, `app-${app.id}`);
  const id = await until(() => wm.find(app.match), `${app.id} window`, 40000, 500).catch((e) => {
    try {
      fs.copyFileSync(`/tmp/app-${app.id}.log`, `${OUT}/${MODE}-app-${app.id}.log`);
      if (wl) fs.writeFileSync(`${OUT}/${MODE}-tree-${app.id}.json`, sh("swaymsg -t get_tree"));
    } catch {
      /* 尽力而为 */
    }
    killGroup(proc);
    throw e;
  });
  await sleep(app.settle ?? 1500);
  wm.place(id);
  await sleep(600);
  wm.click(id, 400, 320);
  await sleep(600);
  if (app.refocus || gn) {
    // GNOME Text Editor 刚启动时不向输入法报告焦点(实测;纯 GTK4 TextView 无此问题),
    // 切走再切回(= 用户 Alt-Tab 到这个窗口)之后才正常。测试按真实使用方式先切一次窗口。
    // GNOME 会话下一律先切一次:会话启动时的系统通知会抢走第一个应用的输入焦点(实测 gedit)。
    const other = wm.find(wl || gn ? "polyphony" : "--name ^Polyphony$");
    if (other) {
      wm.activate(other);
      await sleep(700);
      wm.activate(id);
      await sleep(900);
    }
  }
  if (app.primeKey) {
    wm.key("a BackSpace");
    await sleep(600);
  }
  app.winId = id;
  return { proc, id };
}

async function basicScenario(app, phone) {
  const result = { app: app.id, desc: app.desc };
  const { proc } = await open(app);
  try {
    phone.begin();
    const acks = [];
    for (const text of STEPS) {
      acks.push(await phone.snapshot(text));
      await sleep(250);
    }
    await sleep(600);
    wm.shot(`${MODE}-${app.id}-1-preedit.png`);
    result.injected = acks.every((a) => a.injected === true);
    result.duringPreedit = phone.statuses().join(",") || "-";

    phone.finish(FINAL);
    result.commitStatus = (await phone.waitStatus("committed")) ?? phone.statuses().join(",");
    await sleep(700);
    wm.shot(`${MODE}-${app.id}-2-committed.png`);
    result.readback = (await app.read.call(app)).replace(/\n+$/, "");
    result.visualOnly = Boolean(wl && app.id === "gedit");
    result.pass = result.injected && result.commitStatus === "committed" && (result.visualOnly || result.readback === FINAL);
  } catch (e) {
    result.error = e.message;
    result.pass = false;
    try {
      fs.copyFileSync(`/tmp/app-${app.id}.log`, `${OUT}/${MODE}-app-${app.id}.log`);
    } catch {
      /* 没有日志 */
    }
    wm.shot(`${MODE}-${app.id}-error.png`);
  } finally {
    killGroup(proc);
    await sleep(800);
  }
  return result;
}

/** 焦点保护 / 键盘干预 / 取消 / 长文本:在 gedit(两个窗口)上做 */
async function protectionScenarios(phone) {
  const out = [];
  const a = await open(
    wl || gn
      ? { id: "gtk4-a", cmd: "python3 /work/src/fcitx5/e2e/gtk4-textview.py", match: gn ? "e2e-gtk4-textview" : "e2e.gtk4", settle: 1500 }
      : { id: "gedit-a", cmd: "gedit --standalone", match: "--class gedit", settle: 1500 }
  );
  const read = async () => (gn ? await readFile("/tmp/out-gtk4.txt")() : await copyAll()).replace(/\n+$/, "");
  fs.rmSync("/tmp/out-gtk4.txt", { force: true });
  fs.rmSync("/tmp/fp-b.txt", { force: true });
  try {
    // 键盘干预:显示 Preedit 期间在电脑上敲键盘
    phone.begin();
    await phone.snapshot("语音输入中");
    await sleep(500);
    wm.type("x");
    const st = await phone.waitStatus("suspended");
    await phone.snapshot("语音输入中,继续说");
    await sleep(500);
    wm.shot(`${MODE}-protect-1-keyboard.png`);
    phone.cancel();
    await sleep(400);
    const text = await read();
    out.push({ case: "键盘干预:撤掉 Preedit,键盘输入保留,后续快照不覆盖", status: st, readback: text, pass: st === "suspended/user_interference" && text === "x" });
    wm.key("ctrl+a BackSpace");

    log("  键盘干预 done");
    // 取消
    phone.begin();
    await phone.snapshot("这句不要了");
    await sleep(400);
    phone.cancel();
    await phone.waitStatus("cancelled");
    await sleep(400);
    const afterCancel = await read();
    out.push({ case: "取消:清掉 Preedit,不提交", readback: afterCancel, pass: afterCancel === "" });

    log("  取消 done");
    // 长文本:1000 字 Preedit 后提交
    const long = "这是一段用于验证长文本预编辑显示效果的语音输入内容。".repeat(40).slice(0, 1000);
    phone.begin();
    for (const n of [100, 400, 700, 1000]) await phone.snapshot(long.slice(0, n));
    await sleep(800);
    wm.shot(`${MODE}-protect-2-long-preedit.png`);
    log("  长文本 preedit 已显示,提交 …");
    phone.finish(long);
    const longStatus = await phone.waitStatus("committed");
    await sleep(800);
    log("  长文本已提交,读回 …");
    const longBack = await read();
    out.push({ case: "长文本:1000 字 Preedit 并提交", status: longStatus, readbackLength: longBack.length, pass: longStatus === "committed" && longBack === long });
    wm.key("ctrl+a BackSpace");

    log("  长文本 done");
    // 焦点切换:说到一半切到另一个应用
    phone.begin();
    await phone.snapshot("写给第一个窗口");
    await sleep(500);
    const b = await open({
      id: "featherpad-b",
      cmd: gn ? "echo -n > /tmp/fp-b.txt; featherpad --standalone /tmp/fp-b.txt" : "featherpad --standalone",
      match: wl || gn ? "featherpad" : "--class featherpad",
      settle: 1500,
    });
    const suspended = await phone.waitStatus("suspended");
    await phone.snapshot("写给第一个窗口的后半句");
    await sleep(500);
    wm.shot(`${MODE}-protect-3-focus-switched.png`);
    phone.finish("写给第一个窗口的后半句");
    const rejected = await phone.waitStatus("rejected");
    await sleep(500);
    const inB = gn ? (await saveAndRead("/tmp/fp-b.txt")()).replace(/\n+$/, "") : await read();
    killGroup(b.proc);
    await sleep(800);
    wm.activate(a.id);
    await sleep(600);
    wm.click(a.id, 400, 320);
    await sleep(400);
    const inA = await read();
    out.push({
      case: "焦点切换:新窗口不被注入,提交被拒绝,原窗口不残留",
      status: `${suspended} → ${rejected}`,
      newWindow: inB,
      oldWindow: inA,
      pass: suspended === "suspended/focus_lost" && rejected === "rejected/focus_lost" && inB === "" && inA === "",
    });
  } catch (e) {
    out.push({ case: "保护场景中断", error: e.message, pass: false });
    wm.shot(`${MODE}-protect-error.png`);
  } finally {
    killGroup(a.proc);
  }
  return out;
}

// ---------------------------------------------------------------- 主流程

const results = { mode: MODE, apps: [], protection: [] };
try {
  await startServer();
  const { desktopToken, phoneToken } = await createAccounts();
  log("启动真实桌面壳并在设置页打开接收开关 …");
  const desktop = new Desktop();
  await desktop.start(desktopToken);
  await desktop.screenshot(`${MODE}-desktop-settings-enabled.png`);
  log("桌面壳:已连接服务器,输入法插件已连接 ✓");

  if (gn) {
    // GNOME 会话启动后默认停在「活动概览」:先退出概览,再开应用(否则第一个应用拿不到正常的输入焦点)
    shellEval(`(() => { Main.overview.hide(); return "ok"; })()`);
    await sleep(1500);
  }
  const phone = new Phone();
  await phone.connect(phoneToken);
  log("手机(模拟):已连接,目标电脑已就绪 ✓");

  // 指定了应用名时按命令行给出的顺序跑(排查「第一个应用」类问题用)
  const queue = ONLY.length ? ONLY.map((id) => APPS.find((a) => a.id === id)).filter(Boolean) : APPS;
  for (const app of queue) {
    log(`应用:${app.desc}`);
    const r = await basicScenario(app, phone).catch((e) => ({ app: app.id, desc: app.desc, error: e.message, pass: false }));
    results.apps.push(r);
    log(`  → ${r.pass ? "PASS" : "FAIL"} injected=${r.injected} commit=${r.commitStatus} readback=${JSON.stringify(r.readback)} ${r.error ?? ""}`);
  }
  if (!ONLY.length || ONLY.includes("protect")) {
    log("保护场景 …");
    results.protection = await protectionScenarios(phone);
    for (const p of results.protection) log(`  → ${p.pass ? "PASS" : "FAIL"} ${p.case} ${JSON.stringify({ ...p, case: undefined, pass: undefined })}`);
  }
  // 收尾再截一次设置页:确认桌面壳在后台(非焦点窗口)期间一直在工作
  await desktop.screenshot(`${MODE}-desktop-settings-after.png`);
} catch (e) {
  results.fatal = e.message;
  log("FATAL", e.message);
  try {
    wm.shot(`${MODE}-fatal.png`);
  } catch {
    /* 忽略 */
  }
}

for (const f of ["fcitx5", "server", "tauri-driver", "gnome-shell", "mock-logind"]) {
  try {
    fs.copyFileSync(`/tmp/${f}.log`, `${OUT}/${MODE}-${f}.log`);
  } catch {
    /* 没有该日志 */
  }
}
fs.writeFileSync(`${OUT}/${MODE}-results.json`, JSON.stringify(results, null, 2));
const all = [...results.apps, ...results.protection];
const failed = all.filter((r) => !r.pass).length;
log(`完成:${all.length - failed}/${all.length} 通过${results.fatal ? "(中途中断)" : ""}`);
process.exit(results.fatal || failed ? 1 : 0);

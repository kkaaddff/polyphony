// 收敛冒烟：双客户端交错写 → 断言内容一致 + 计数完整；删除轮 + meta + awareness + v4 凭据往返。
// 用法：起服后 `node convergence-smoke.mjs [httpBase]`（默认 http://localhost:8101）。
// v4 凭据：本地生成 secret → /auth/create → 拼 poly_d_ 凭据(响应不含 secret)。
import crypto from "crypto";
import WebSocket from "ws";
globalThis.WebSocket = WebSocket;
import { Doc } from "yjs";
import { WebsocketProvider } from "y-websocket";

const BASE = (process.argv[2] || "http://localhost:8101").replace(/\/+$/, "");
const SERVER = BASE.replace(/^http/, "ws");
const ROOM = "SMOKE" + Math.floor(Math.random() * 100000);

const secret = crypto.randomBytes(24).toString("hex");
const res = await fetch(`${BASE}/auth/create`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    name: `smoke-${Date.now()}`,
    secret,
    platform: { client: "web", os: "macos" },
  }),
});
if (!res.ok) {
  console.error("FAIL: 创建冒烟账号失败", res.status, await res.text());
  process.exit(1);
}
const { deviceId, recoveryKey } = await res.json();
if (!deviceId || !recoveryKey.startsWith("poly_r_")) {
  console.error("FAIL: create 应返回 deviceId 与恢复密钥");
  process.exit(1);
}
const token = `poly_d_${deviceId}_${secret}`;
const authParams = { token };

// v4:凭据经子协议头注入(与 useCollaboration 的 WebSocketPolyfill 同构)
class AuthedWS extends WebSocket {
  constructor(url) {
    super(url, ["polyphony.v1", `auth.${token}`]);
  }
}
const wsOpts = { disableBc: true, params: { userId: "smoke" }, WebSocketPolyfill: AuthedWS };

const docA = new Doc();
const docB = new Doc();
const pA = new WebsocketProvider(SERVER, ROOM, docA, wsOpts);
const pB = new WebsocketProvider(SERVER, ROOM, docB, wsOpts);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const postJson = (path, body) =>
  fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
const fail = (msg) => {
  console.error("FAIL:", msg);
  process.exit(1);
};

await new Promise((res) => {
  let n = 0;
  const done = () => {
    if (++n === 2) res();
  };
  pA.on("sync", done);
  pB.on("sync", done);
  setTimeout(() => fail("初始同步超时"), 8000);
});

const textA = docA.getText("content");
const textB = docB.getText("content");

// 100 次交错随机位置插入（A/B 两端混写）
for (let i = 0; i < 100; i++) {
  const t = i % 2 === 0 ? textA : textB;
  const pos = Math.floor(Math.random() * (t.length + 1));
  t.insert(pos, `[${i % 2 === 0 ? "A" : "B"}${i}]`);
}
await wait(1500);

const a = textA.toString();
const b = textB.toString();
if (a !== b) fail(`内容发散 A=${a.length} B=${b.length}`);
// 交错插入会把标记拆开（如 [A[B5]2]），必须数括号而不是找子串
const opens = (a.match(/\[/g) || []).length;
const closes = (a.match(/\]/g) || []).length;
if (opens !== 100 || closes !== 100) fail(`标记数不对 [ ${opens} ] ${closes}`);

// 删除轮：两端交错随机删
for (let i = 0; i < 20; i++) {
  const t = i % 2 === 0 ? textA : textB;
  if (t.length > 10) {
    const pos = Math.floor(Math.random() * (t.length - 10));
    t.delete(pos, 8);
  }
}
await wait(1200);
if (textA.toString() !== textB.toString()) fail("删除后发散");

// meta 同步
docA.getMap("meta").set("roomName", "冒烟测试");
await wait(800);
if (docB.getMap("meta").get("roomName") !== "冒烟测试") fail("meta 未同步");

// awareness 可见性
pA.awareness.setLocalStateField("user", { name: "A", color: "#111111" });
await wait(800);
const states = [...pB.awareness.getStates().values()];
if (!states.some((s) => s.user?.name === "A")) fail("awareness 不可见");

// ---------- v4 凭据往返(设计 §7:响应不含 secret;恢复密钥可兑换;错钥 401) ----------
{
  const post = postJson;

  const me = await fetch(`${BASE}/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
  if (!me.ok) fail("设备凭据未过 /auth/me");

  const secret2 = crypto.randomBytes(24).toString("hex");
  const exchanged = await post("/auth/exchange", {
    key: recoveryKey,
    secret: secret2,
    platform: { client: "web", os: "macos" },
  });
  if (!exchanged.ok) fail(`恢复密钥兑换失败 ${exchanged.status}`);
  const { deviceId: d2 } = await exchanged.json();
  const me2 = await fetch(`${BASE}/auth/me`, {
    headers: { Authorization: `Bearer poly_d_${d2}_${secret2}` },
  });
  if (!me2.ok) fail("兑换所得设备凭据未过 /auth/me");

  const bad = await post("/auth/exchange", {
    key: "poly_r_" + "0".repeat(48),
    secret: crypto.randomBytes(24).toString("hex"),
  });
  if (bad.status !== 401) fail(`错误恢复密钥应 401,得 ${bad.status}`);

  // 恢复密钥不可直接作会话
  const asSession = await fetch(`${BASE}/auth/me`, {
    headers: { Authorization: `Bearer ${recoveryKey}` },
  });
  if (asSession.status !== 401) fail("恢复密钥直接作会话应 401");
}

// ---------- WS 鉴权(子协议;设计 §4.5) ----------
{
  // 1) 只回显 polyphony.v1,绝不回显凭据
  const ws = new WebSocket(`${SERVER}/wsproto`, ["polyphony.v1", `auth.${token}`]);
  const proto = await new Promise((resolve) => {
    ws.on("open", () => { resolve(ws.protocol); ws.close(); });
    ws.on("error", () => resolve(null));
    setTimeout(() => resolve(undefined), 5000);
  });
  if (proto !== "polyphony.v1") fail(`子协议应只回显 polyphony.v1,得 ${proto}`);

  // 2) 带 v1 子协议但无凭据 → 握手后 close 4001
  const noAuth = new WebSocket(`${SERVER}/wsproto`, ["polyphony.v1"]);
  const code1 = await new Promise((resolve) => {
    noAuth.on("close", (c) => resolve(c));
    noAuth.on("error", () => resolve(-1));
    setTimeout(() => resolve(undefined), 5000);
  });
  if (code1 !== 4001) fail(`无凭据应 close 4001,得 ${code1}`);

  // 3) ?token= 查询参数回落已移除:即使带上有效凭据也不认 → 4001
  const legacy = new WebSocket(`${SERVER}/wsproto?token=${encodeURIComponent(token)}`);
  const codeLegacy = await new Promise((resolve) => {
    legacy.on("close", (c) => resolve(c));
    legacy.on("error", () => resolve(-1));
    setTimeout(() => resolve(undefined), 5000);
  });
  if (codeLegacy !== 4001) fail(`?token= 回落应 4001,得 ${codeLegacy}`);

  // 4) 吊销设备 → 其在线 WS 立即 4001
  const secret2 = crypto.randomBytes(24).toString("hex");
  const { deviceId: d3 } = await postJson("/auth/exchange", {
    key: recoveryKey,
    secret: secret2,
    platform: { client: "web", os: "macos" },
  }).then((r) => r.json());
  const token3 = `poly_d_${d3}_${secret2}`;
  class Authed3 extends WebSocket {
    constructor(url) {
      super(url, ["polyphony.v1", `auth.${token3}`]);
    }
  }
  const doc3 = new Doc();
  const p3 = new WebsocketProvider(SERVER, "WSREVOKE", doc3, {
    disableBc: true,
    WebSocketPolyfill: Authed3,
  });
  await new Promise((res) => {
    p3.on("status", (e) => { if (e.status === "connected") res(); });
    setTimeout(res, 5000);
  });
  const revoked = await fetch(`${BASE}/auth/devices/${d3}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!revoked.ok) fail(`吊销失败 ${revoked.status}`);
  const code3 = await new Promise((resolve) => {
    p3.ws?.on("close", (c) => resolve(c));
    setTimeout(() => resolve(undefined), 5000);
  });
  if (code3 !== 4001) fail(`被吊销设备的 WS 应 4001,得 ${code3}`);
}

console.log(
  `PASS 收敛冒烟：${a.length} 字符，标记 ${opens} 对，删除后 ${textA.toString().length} 字符，meta/awareness OK，v4 凭据/WS 鉴权往返 OK`
);
process.exit(0);

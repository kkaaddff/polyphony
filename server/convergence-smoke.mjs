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

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

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

const postJson = (path, body, authed = false) =>
  fetch(`${BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(authed ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });

// v4:房间必须显式创建(不再隐式);CRDT 主测试用房
const roomRes = await postJson("/docs", {}, true);
if (!roomRes.ok) {
  console.error("FAIL: 创建冒烟文档失败", roomRes.status, await roomRes.text());
  process.exit(1);
}
const ROOM = (await roomRes.json()).code;

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

const meName = async () => {
  const r = await fetch(`${BASE}/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
  return (await r.json()).name;
};
const fail = (msg) => {
  console.error("FAIL:", msg);
  process.exit(1);
};

await new Promise((res) => {
  let n = 0;
  const done = () => {
    if (++n === 2) {
      clearTimeout(timer); // 成功后必须清定时器(总时长超 8s 后曾误杀整轮冒烟)
      res();
    }
  };
  pA.on("sync", done);
  pB.on("sync", done);
  const timer = setTimeout(() => fail("初始同步超时"), 8000);
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
  const { code: revokeRoom } = await postJson("/docs", {}, true).then((r) => r.json());
  const doc3 = new Doc();
  const p3 = new WebsocketProvider(SERVER, revokeRoom, doc3, {
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

// ---------- 配对 v2 双向往返(设计 §4.4:轮询无秘密;凭据本地拼装) ----------
{
  const secretNew = crypto.randomBytes(24).toString("hex");
  const platform = { client: "app", os: "android" };

  // push:create(qr)→claim→approve→poll approved→本地凭据过 /auth/me
  const { code } = await postJson("/auth/pair/create", { kind: "qr" }, true).then((r) => {
    if (!r.ok) throw new Error("pair/create 失败 " + r.status);
    return r.json();
  });
  const claim = await postJson("/auth/pair/claim", { code, secret: secretNew, platform }).then((r) => r.json());
  if (!claim.deviceId) fail("claim 应返回 deviceId");
  const dup = await postJson("/auth/pair/claim", { code, secret: crypto.randomBytes(24).toString("hex"), platform });
  if (dup.status !== 409) fail(`双 claim 应 409,得 ${dup.status}`);
  const approved = await postJson("/auth/pair/approve", { code, accept: true }, true);
  if (!approved.ok) fail(`approve 失败 ${approved.status}`);
  const poll = await postJson("/auth/pair/poll", { code, deviceId: claim.deviceId }).then((r) => r.json());
  if (poll.status !== "approved" || poll.accountName !== (await meName()))
    fail(`push poll 应 approved 且账号名一致,得 ${JSON.stringify(poll)}`);
  if (JSON.stringify(poll).includes(secretNew)) fail("poll 响应不得含 secret");
  const newcomerToken = `poly_d_${claim.deviceId}_${secretNew}`;
  const newcomerMe = await fetch(`${BASE}/auth/me`, { headers: { Authorization: `Bearer ${newcomerToken}` } });
  if (!newcomerMe.ok) fail("push 配对所得凭据未过 /auth/me");

  // pull:request→info 不含账号→approve 绑定→poll approved→凭据可登录
  const secretPull = crypto.randomBytes(24).toString("hex");
  const req = await postJson("/auth/pair/request", { secret: secretPull, platform }).then((r) => r.json());
  const info = await fetch(`${BASE}/auth/pair/info?code=${req.code}`).then((r) => r.json());
  if (info.direction !== "pull" || "accountName" in info) fail("pull info 不得含账号信息");
  const wrongPoll = await postJson("/auth/pair/poll", { code: req.code, deviceId: claim.deviceId });
  if (wrongPoll.status !== 410) fail(`deviceId 不符应 410,得 ${wrongPoll.status}`);
  const okPull = await postJson("/auth/pair/approve", { code: req.code, accept: true }, true);
  if (!okPull.ok) fail(`pull approve 失败 ${okPull.status}`);
  const pollPull = await postJson("/auth/pair/poll", { code: req.code, deviceId: req.deviceId }).then((r) => r.json());
  if (pollPull.status !== "approved") fail(`pull poll 应 approved,得 ${JSON.stringify(pollPull)}`);
  const pullToken = `poly_d_${req.deviceId}_${secretPull}`;
  const pullMe = await fetch(`${BASE}/auth/me`, { headers: { Authorization: `Bearer ${pullToken}` } });
  if (!pullMe.ok) fail("pull 配对所得凭据未过 /auth/me");

  // pendingPairings 随 /rooms 回(红点来源)
  const rooms = await fetch(`${BASE}/auth/rooms`, { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.json());
  if (typeof rooms.pendingPairings !== "number") fail("/rooms 应含 pendingPairings");
}

// ---------- 文档生命周期(§7 L1/L2):显式创建/门控/删除/回收站 ----------
{
  const authed = { Authorization: `Bearer ${token}` };
  const { code } = await postJson("/docs", {}, true).then((r) => r.json());
  if (!/^[A-Z0-9]{8}$/.test(code)) fail(`文档码格式不对: ${code}`);

  // 未知码 → 4004(不再隐式创建空文档)
  const unknown = new WebSocket(`${SERVER}/NOSUCH01`, ["polyphony.v1", `auth.${token}`]);
  const code404 = await new Promise((resolve) => {
    unknown.on("close", (c) => resolve(c));
    unknown.on("error", () => resolve(-1));
    setTimeout(() => resolve(undefined), 5000);
  });
  if (code404 !== 4004) fail(`未知文档码应 4004,得 ${code404}`);

  // 进入显式创建的文档并写入(防抖落库);close 监听须在连接建立时挂上
  const dd = new Doc();
  const pd = new WebsocketProvider(SERVER, code, dd, wsOpts);
  await new Promise((res) => {
    pd.on("status", (e) => { if (e.status === "connected") res(); });
    setTimeout(res, 5000);
  });
  const closeCode = new Promise((resolve) => {
    pd.ws?.on("close", (c) => resolve(c));
    setTimeout(() => resolve(undefined), 15000);
  });
  dd.getText("document").insert(0, "生命周期冒烟");
  dd.getMap("meta").set("roomName", "生命周期文档");
  await wait(2500);

  // 所有者删除 → 在线连接立即 4010
  const del = await fetch(`${BASE}/docs/${code}`, { method: "DELETE", headers: authed });
  if (del.status !== 204) fail(`删除应 204,得 ${del.status}`);
  if ((await closeCode) !== 4010) fail(`删除后在线连接应 4010,得 ${await closeCode}`);

  // 回收站:列表 → 恢复 → 重新可进
  const trash = await fetch(`${BASE}/docs/trash/list`, { headers: authed }).then((r) => r.json());
  if (!trash.docs.some((x) => x.code === code)) fail("回收站应含被删文档");
  const restore = await fetch(`${BASE}/docs/${code}/restore`, { method: "POST", headers: authed });
  if (restore.status !== 204) fail(`恢复应 204,得 ${restore.status}`);
  const d3 = new Doc();
  const p3 = new WebsocketProvider(SERVER, code, d3, wsOpts);
  const reentered = await new Promise((resolve) => {
    p3.on("status", (e) => { if (e.status === "connected") resolve(true); });
    setTimeout(() => resolve(false), 5000);
  });
  if (!reentered) fail("恢复后应能重新进入");
  await wait(1200);
  if (d3.getText("document").toString() !== "生命周期冒烟") fail("恢复后内容应仍在(持久化)");

  // 附件:上传→登记→读取→文档删除后 404;旧 /upload 404
  {
    const { code: acode } = await postJson("/docs", {}, true).then((r) => r.json());
    const form = new FormData();
    form.append("image", new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" }), "t.png");
    const up = await fetch(`${BASE}/docs/${acode}/attachments`, {
      method: "POST",
      headers: authed,
      body: form,
    });
    if (up.status !== 201) fail(`上传应 201,得 ${up.status} ${await up.text()}`);
    const { url: aurl } = await up.json();
    if (!new RegExp(`^/uploads/${acode}/[a-f0-9]{32}\\.png$`).test(aurl)) fail(`附件路径形态不对: ${aurl}`);
    const got = await fetch(`${BASE}${aurl}`);
    if (got.status !== 200) fail(`附件读取应 200,得 ${got.status}`);
    if (got.headers.get("cache-control") !== "private, max-age=86400") fail("附件缓存头不对");
    // 未带凭据也能读(免登录);文档删除后 404
    const del2 = await fetch(`${BASE}/docs/${acode}`, { method: "DELETE", headers: authed });
    if (del2.status !== 204) fail("删除附件宿主文档失败");
    const gone = await fetch(`${BASE}${aurl}`);
    if (gone.status !== 404) fail(`删除后附件应 404,得 ${gone.status}`);
    const legacy = await fetch(`${BASE}/upload`, { method: "POST", headers: authed });
    if (legacy.status !== 404) fail(`旧 /upload 应已移除(404),得 ${legacy.status}`);
  }

  // /health 收敛:不列文档码,带数量
  const health = await fetch(`${BASE}/health`).then((r) => r.json());
  if ("rooms" in health) fail("/health 不应再列出文档码");
  if (typeof health.docs !== "number") fail("/health 应含 docs 数量");
}

console.log(
  `PASS 收敛冒烟：${a.length} 字符，标记 ${opens} 对，删除后 ${textA.toString().length} 字符，meta/awareness OK，v4 凭据/WS 鉴权/配对双向往返/文档生命周期 OK`
);
process.exit(0);

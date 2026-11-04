// 收敛冒烟：双客户端交错写 → 断言内容一致 + 计数完整；删除轮 + meta + awareness。
// 用法：起服后 `node convergence-smoke.mjs [httpBase]`（默认 http://localhost:8101）。
// WS 已强制 token 鉴权：先建临时账号（无 Origin 的工具客户端可创建），再带 token 连接。
import WebSocket from "ws";
globalThis.WebSocket = WebSocket;
import { Doc } from "yjs";
import { WebsocketProvider } from "y-websocket";

const BASE = (process.argv[2] || "http://localhost:8101").replace(/\/+$/, "");
const SERVER = BASE.replace(/^http/, "ws");
const ROOM = "SMOKE" + Math.floor(Math.random() * 100000);

const res = await fetch(`${BASE}/auth/create`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: `smoke-${Date.now()}` }),
});
if (!res.ok) {
  console.error("FAIL: 创建冒烟账号失败", res.status, await res.text());
  process.exit(1);
}
const { token } = await res.json();
const authParams = { token };

const docA = new Doc();
const docB = new Doc();
const pA = new WebsocketProvider(SERVER, ROOM, docA, { disableBc: true, params: authParams });
const pB = new WebsocketProvider(SERVER, ROOM, docB, { disableBc: true, params: authParams });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
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

// ---------- 配对登录往返(docs/pairing-login.md §7) ----------
{
  const json = (r) => r.json();
  const post = (path, body, authed) =>
    fetch(`${BASE}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(authed ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });

  // QR 配对:create→info(pending)→claim→双claim 409→confirm→poll 取 token 过 /auth/me
  const { code } = await post("/auth/pair/create", { kind: "qr" }, true).then(json);
  const info = await fetch(`${BASE}/auth/pair/info?code=${code}`).then(json);
  if (info.status !== "pending" || !info.accountName) fail("pair info 应为 pending 且带账号名");

  const { claimKey } = await post("/auth/pair/claim", { code }).then(json);
  const claimAgain = await post("/auth/pair/claim", { code });
  if (claimAgain.status !== 409) fail(`双 claim 应 409,得 ${claimAgain.status}`);

  // 非持钥 poll 拿不到 token(D4)
  const pollStranger = await post("/auth/pair/poll", { code, key: "wrong" });
  if (pollStranger.status !== 410) fail(`无钥 poll 应 410,得 ${pollStranger.status}`);

  const confirmed = await post("/auth/pair/confirm", { code, accept: true, token }, true);
  if (!confirmed.ok) fail(`confirm 失败 ${confirmed.status}`);
  const poll = await post("/auth/pair/poll", { code, key: claimKey }).then(json);
  if (poll.status !== "approved" || poll.token !== token) fail("poll 未取到 token");
  const me = await fetch(`${BASE}/auth/me`, {
    headers: { Authorization: `Bearer ${poll.token}` },
  });
  if (!me.ok) fail("配对取得的 token 未过 /auth/me");

  // 撤销:链接配对 claim 后 cancel → poll 得 cancelled;未知码 410
  const { code: code2 } = await post("/auth/pair/create", { kind: "link", ttlMinutes: 5 }, true).then(json);
  const { claimKey: key2 } = await post("/auth/pair/claim", { code: code2 }).then(json);
  const cancelled = await post("/auth/pair/cancel", { code: code2 }, true);
  if (!cancelled.ok) fail(`cancel 失败 ${cancelled.status}`);
  const poll2 = await post("/auth/pair/poll", { code: code2, key: key2 }).then(json);
  if (poll2.status !== "cancelled") fail(`cancel 后 poll 应 cancelled,得 ${poll2.status}`);

  const unknown = await post("/auth/pair/claim", { code: "no-such-code" });
  if (unknown.status !== 410) fail(`未知码应 410,得 ${unknown.status}`);
}

console.log(
  `PASS 收敛冒烟：${a.length} 字符，标记 ${opens} 对，删除后 ${textA.toString().length} 字符，meta/awareness OK，配对往返 OK`
);
process.exit(0);

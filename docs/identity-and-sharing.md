# 身份与分享（v4.0）设计

状态：**已实现**（2026-11-04 定稿，2026-11-05 实现于 v4 分支：服务端 `auth.js`/`pairing.js`/`routes/` + SQLite `db.js` + 客户端 `lib/auth.ts`/`lib/pairing.ts`/Welcome/Pair/Settings；单测 44 + 收敛冒烟 + e2e 77 全绿。实现与设计的三处对齐修订：房间簿端点挂顶层 `/rooms`（非 `/auth/rooms`）；`/rooms` 行内直接返回 `isOwner`；回收站行的 owner 书签可经 leave 移出列表（active 文档的 owner 行保护不变））
取代：`docs/pairing-login.md`（v3.6.0 配对登录，未发版；其状态机、一次性、人工确认、撤销、红点、落地页在本方案中保留并扩展；claimKey 被「设备本地生成凭据」取代。D1–D15 仍有效，除非下文 §9 明确推翻）
姊妹篇：`docs/document-lifecycle.md`（同属 v4.0）
前置决策：ADR #4（QR 载荷 = Web URL）、#14（内网/受信威胁模型）、#24（账号体系，本方案推翻）

> **v4 全新开始**（用户拍板「不管历史数据，全部扔掉」）：v3 的账号、文档、图片在 v4 服务端首次启动时自动归档并清空，所有人重新注册；服务端与客户端均**不含任何 v3 兼容逻辑**，v3 客户端必须升级。见 §6。
>
> **存储**：全部持久数据存于单个 SQLite 文件 `data/polyphony.db`（Node 内置 `node:sqlite`），本文 §4.2 定义账号与设备表，姊妹篇 §4.1 定义文档相关表。

---

## 1. 背景与目标

### 问题

用户原话：「手机端首页不仅通过 token 登录，是不是也可以通过扫码登录；桌面端不仅可以创建或输入 token，是不是也可以通过链接登录？web 端除了创建账号、邀请别人加入文档，是不是还应该可以发起一个（邀请）自己的其他设备登录的逻辑？底层反思这个逻辑，按第一性原则，使用终局实现。」

第一性原则拆解后，系统里能跨设备传递的只有三种能力，通道本质只有一种：

| 能力 | 载体 | 给谁 |
|---|---|---|
| 服务器（去哪连） | server URL | 任何人 |
| 房间（进哪篇） | server + 房间码 | 别人 |
| 身份（我是谁） | server + 一次性配对码 | **只给自己** |

通道 = URL；二维码 = URL 的图形形态（同处一地且对方有摄像头时用），链接 = URL 的文本形态（异地/无摄像头时用）。

现状（§2）把「通道」和「功能/平台」绑死了，并且存在五个根因问题：

1. **接收不对称**：链接只能被浏览器消费；桌面/Android App 收到链接无路可走（打开 = 登录了浏览器而不是 App）。
2. **配对单向**：只有「已登录端出码 → 新设备扫」。摄像头在手机上，最常见的「手机已登录、新电脑要登录」反而扫不了；Android 端「登录其他设备」入口被无理由隐藏。
3. **全设备共享一个 token**：丢一台设备 = 账号永久失守（无轮换、无单设备吊销，「退出登录」只删本地）；配对只能由网页把明文 token 经服务器中转（服务端只存哈希）。
4. **token 是用户必须理解和搬运的概念**：这是最初痛点的根源。
5. **「仅 Web 创建账号」不是安全控制**：无 Origin 请求放行，curl 随时能建；它只制造死路——App 新用户扫到房间邀请 → 没账号 → App 不能建 → 去浏览器建 → 复制 token → 回 App 粘贴。

### 成功判据

- [ ] 任何已登录端（Web / 桌面 App / Android App）都能发起：邀请别人进房间、登录我的其他设备、分享本站——每个都同时给二维码和可复制链接。
- [ ] 任何端（含未登录）都能通过「扫码」或「粘贴链接」接收上述任一链接。
- [ ] 手机已登录时，新电脑无需摄像头、无需复制任何字符串即可登录（反向配对）。
- [ ] 每台设备持有独立凭据；任一已登录设备可查看「已登录设备」并逐台吊销，吊销即时断开该设备的协同连接；退出登录 = 服务端吊销本机凭据。
- [ ] 任何端都能创建账号；App 新用户从房间邀请到进房全程不离开 App。
- [ ] 日常登录全程不出现 token；用户唯一接触的秘密是注册时强制显示一次的恢复密钥。
- [ ] 设备凭据的秘密由设备本地生成；除恢复密钥外，服务端不在任何响应中返回凭据秘密。
- [ ] 180 天未上线的设备自动吊销。
- [ ] 用户可注销账号：所有设备立即登出、自有文档进回收站；30 天内可用恢复密钥撤销，到期彻底删除并释放用户名。
- [ ] 协同 WebSocket 连接的凭据不出现在 URL 中。
- [ ] v4 全新开始：v3 数据在首次启动时自动归档（可人工恢复）并清空；代码中无 v3 兼容分支。

### 非目标

- **不做** `polyphony://` 自定义协议唤起 / deep link（用户拍板：App 只做粘贴链接）。
- **不做** 房间级权限（房间码仍是永久 bearer 码，见 §10）。
- **不做** 设备改名、同网络提示、数字比对、新设备冷静期。
- **不做** OS keychain 存储凭据、创建账号限流。
- **不做** v3 账号 / token / 客户端的任何兼容或迁移。

---

## 2. 现状（相关模块）

| 位置 | 现状 | 本方案影响 |
|---|---|---|
| `server/auth.js:51` `createAccount` | 每账号一个 `salt`+`tokenHash`，明文 token 仅创建响应出现一次；存 `accounts.json` 整份重写 | 重写：设备凭据 + 恢复密钥；存 SQLite |
| `server/auth.js:106` 房间簿 | 每账号 50 条，超出挤掉最旧——**所有者自己的文档也会被挤出列表，从此无法在界面上删除** | 由姊妹篇 `memberships` 表取代，所有者条目永不被挤掉 |
| `server/auth.js:80` `verifyToken` | 线性扫全部账号比对哈希 | 重写：按设备 ID 直查 |
| `server/index.js:47` `allowCreateOrigin` | 拦 Tauri Origin，无 Origin 放行 | **删除** |
| `server/index.js`（整体） | 路由、上传、WS、健康检查全在一个文件；错误码 `ERR_` / `E_` 前缀混用 | 拆为 `server/routes/{auth,pair,docs,uploads}.js` + `db.js` + `sweeper.js`；错误码统一 `E_` |
| `server/index.js:335` WS 鉴权 | `?token=` 查询参数 | 改：只认 WS 子协议 |
| `server/pairing.js` + `server/index.js:114-230` | 单向配对，确认时网页上传明文 token，服务端中转 | 重写：双向；新设备本地生成凭据，批准即写入，轮询不带秘密 |
| `client/src/lib/auth.ts` | localStorage 存 token；`createAccount` 返回明文 | 改：本地生成秘密、登出吊销、v3 本地残留一次性清理 |
| `client/src/lib/useCollaboration.ts:83-89` | `params: { token, userId }` | 改：`WebSocketPolyfill` 子类注入子协议 |
| `client/src/pages/Welcome.tsx:32,368` | App 默认登录 tab；创建 tab 注明仅 Web | 改：三入口结构，全端可建 |
| `client/src/pages/Home.tsx:204-207` | 退出登录只 `clearToken()` | 改：先吊销本机凭据 |
| `client/src/pages/Home.tsx:272` | `!isAndroidTauri()` 隐藏「登录新设备」 | **删除门控** |
| `client/src/pages/Home.tsx:85` | `/rooms` 每 15s 刷新 | 复用：携带待确认数 |
| `client/src/components/QrModal.tsx:53` | 只显示 URL 文本，无复制按钮 | 加「复制链接」 |
| `client/src/components/ScanModal.tsx` | 仅摄像头 | 改：「扫码或粘贴链接」 |
| `client/src/pages/Settings.tsx` | 语言 + 服务器 | 加「已登录设备」「恢复密钥」 |

---

## 3. 方案总览

一句话：**账号 = N 个设备凭据 + 1 个恢复密钥；所有分享都是 URL；所有接收都走一个「扫码或粘贴链接」入口；配对双向、批准永远在已登录端；设备凭据的秘密由设备本地生成，服务端只存哈希、从不下发。**

```mermaid
flowchart LR
  subgraph 已登录端（任一平台）
    S1[邀请进房间<br/>/join]
    S2[登录我的其他设备<br/>/pair 正向]
    S3[分享本站]
    AP[批准反向请求]
  end
  subgraph 任一端
    IN[扫码或粘贴链接<br/>统一 intake]
  end
  subgraph 未登录新设备
    RQ[显示本机二维码<br/>/pair 反向]
    RK[使用恢复密钥]
    CR[创建账号]
  end
  S1 & S2 & S3 -->|QR / 链接| IN
  RQ -->|QR| AP
  IN -->|/pair 正向| DEV[本机生成秘密 → 服务端只登记哈希<br/>批准/兑换/创建后生效]
  AP --> DEV
  RK -->|/auth/exchange| DEV
  CR --> DEV
```

六个主场景（§4.6 逐步展开）：

| # | 场景 | 走法 |
|---|---|---|
| 1 | App 新用户收到房间邀请 | 扫码/粘贴 → 无账号 → 就地创建 → 恢复密钥显示一次 → 进房 |
| 2 | 手机已登录，新电脑登录 | 电脑显示本机码 → 手机 App 扫（或已登录的手机浏览器扫）→ 批准 → 电脑登录 |
| 3 | 电脑已登录，新手机登录 | 电脑出码 → 手机扫 → 手机点「在此设备登录」→ 任一已登录端确认 → 手机登录 |
| 4 | 两台设备不在一起 | 已登录端生成链接（5/15/30/60 分）→ 发给自己 → 新设备粘贴或浏览器打开 → 同 #3 |
| 5 | 手头没有任何已登录设备 | 欢迎页「使用恢复密钥」→ 兑换本机凭据 |
| 6 | 设备丢失 | 任一已登录端 设置 → 已登录设备 → 吊销；必要时重新生成恢复密钥 |

---

## 4. 详细设计

### 4.1 凭据模型

**核心原则：设备凭据的秘密部分永远由设备本地生成，服务端只存其哈希、从不在任何响应中下发。** 全系统唯一由服务端生成并下发的秘密，是注册 / 重新生成时显示一次的恢复密钥。

| 类型 | 格式 | 谁生成 | 用途 | 可作会话凭据 |
|---|---|---|---|---|
| 设备凭据 | `poly_d_<deviceId>_<secret>` | `deviceId`：服务端分配（UUID）；`secret`：**设备本地** `crypto.getRandomValues` 生成 24 字节 → 48 hex | 日常一切请求（HTTP Bearer、WS） | ✓ |
| 恢复密钥 | `poly_r_<48 hex>` | 服务端 `crypto.randomBytes(24)` | 仅用于 `/auth/exchange` 兑换设备凭据 | ✗（401） |

- 设备在注册 / 兑换 / 配对时**提交一次 `secret` 原文**，服务端立即计算 `sha256(secret)` 存储，丢弃原文。之所以提交原文而非客户端自算哈希：`crypto.subtle` 只在安全上下文可用，`http://IP` 直连部署下不可用；而 `secret` 本就随每次请求作为 Bearer 发出，提交一次不增加暴露面。`getRandomValues` 在非安全上下文同样可用。
- 两种秘密均为 192-bit 随机数，哈希一律 `sha256`、**不加盐**（无字典攻击面）。
- 客户端拿到 `deviceId` 后在本地拼出完整凭据存入 localStorage；服务端响应中永远只有 `deviceId`。
- `deviceId` 为 UUID（`-` 与 `_` 均为 RFC 7230 tchar，可放进 WS 子协议）。

### 4.2 数据模型（SQLite：`data/polyphony.db`）

存储统一为 Node 内置 `node:sqlite`（零原生依赖；`PRAGMA journal_mode=WAL; foreign_keys=ON; synchronous=NORMAL`），连接与建表在 `server/db.js`。文档相关表（`docs`、`memberships`、`attachments`、`doc_refs`）见姊妹篇 §4.1；本文只定义账号与设备：

```sql
CREATE TABLE accounts (
  id            TEXT PRIMARY KEY,           -- UUID
  name          TEXT NOT NULL UNIQUE,       -- 1–20 字符；注销中的账号仍占用，彻底删除后释放
  recovery_hash TEXT NOT NULL,              -- sha256(恢复密钥)
  created_at    INTEGER NOT NULL,
  deleted_at    INTEGER                     -- 非空 = 注销中（§4.7）
);
CREATE TABLE devices (
  id           TEXT PRIMARY KEY,            -- UUID（即 deviceId）
  account_id   TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  hash         TEXT NOT NULL,               -- sha256(secret)
  client       TEXT NOT NULL,               -- app | web
  os           TEXT NOT NULL,               -- android | ios | macos | windows | linux | other
  label        TEXT NOT NULL,               -- 服务端由 client/os + UA 拼出，非客户端文本
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER                      -- 从未上线为 NULL
);
CREATE INDEX devices_by_account ON devices(account_id);
```

- 原 `accounts.json` 的 `rooms[]`（房间簿）由姊妹篇的 `memberships` 表取代。
- **设备名不接受自由文本**：客户端只上报 `platform = { client: 'app'|'web', os: 'android'|'ios'|'macos'|'windows'|'linux'|'other' }`，非法值归 `other`。服务端拼名：`app` → `App · <OS>`；`web` → `<浏览器> · <OS>`，浏览器名从 UA 按白名单识别（Edge / Chrome / Firefox / Safari，余者为「浏览器」）。批准页与设备列表上不出现任何对方可自定义的文字。
- 设备上限：每账号 **20** 台。达上限时，批准配对与兑换恢复密钥返回 `E_DEVICE_LIMIT`，**不静默淘汰**（创建账号只产生第 1 台，不涉及）。
- `last_seen_at`：每次鉴权成功在内存更新；距上次写库值超过 1 小时才 `UPDATE`（避免每请求写库）。
- 清扫（统一调度器 `server/sweeper.js`，每小时）：
  - **孤儿**：`last_seen_at IS NULL` 且 `created_at` 超过 24 小时 → 删除（批准后新设备从未上线）。
  - **长期不活动**：`last_seen_at` 超过 **180 天** → 自动吊销（删除）。该设备再打开时 401 → 回欢迎页，重新配对即可。
  - 两种删除均记日志（§7）。

### 4.3 鉴权规则

`authenticate(credential) → { account, device } | null`：

1. `poly_d_<id>_<secret>` → 索引直查设备 → 比对 `sha256(secret) === hash` → `{account, device}`。
2. 其他任何格式（含 `poly_r_` 恢复密钥）→ `null`（401）。

只有一种会话：设备会话，拥有全部功能。HTTP：`Authorization: Bearer`（不变）。WS：见 §4.5。

### 4.4 接口契约

所有 `/auth/*` 响应加 `Cache-Control: no-store`（沿用 D15，从 `/auth/pair` 扩大到 `/auth`）。**除恢复密钥外，没有任何接口在响应中返回凭据秘密。**

#### 账号与设备

| 方法 路径 | 鉴权 | 入参 | 出参 | 错误 |
|---|---|---|---|---|
| `POST /auth/create` | 无（**全端**） | `{ name, secret, platform }` | `201 { name, deviceId, recoveryKey }`；`recoveryKey` 仅此一次 | `E_NAME_INVALID` / `E_NAME_TAKEN` 422；`E_SECRET_INVALID` 400 |
| `POST /auth/exchange` | 无 | `{ key, secret, platform }`：`key` 为恢复密钥 | `{ name, deviceId }` | `E_UNAUTHORIZED` 401；`E_DEVICE_LIMIT` 409；`E_SECRET_INVALID` 400；`E_ACCOUNT_DELETED` 409 |
| `GET /auth/me` | 会话 | — | `{ id, name, deviceId }` | 401 |
| `GET /auth/devices` | 会话 | — | `{ devices: [{ id, label, createdAt, lastSeenAt, current }] }` | 401 |
| `DELETE /auth/devices/:id` | 会话 | — | `204`；立即关闭该设备 WS（4001） | 404 |
| `POST /auth/logout` | 会话 | — | `204`：吊销本机并关闭其 WS | 401 |
| `POST /auth/recovery/regenerate` | 会话 | — | `{ recoveryKey }` 仅此一次；旧恢复密钥立即作废 | 401 |
| `POST /auth/account/delete` | 会话 | `{ name }`（须与账号名一致） | `204`（§4.7） | `E_NAME_MISMATCH` 400 |
| `POST /auth/account/restore` | 无 | `{ key, secret, platform }` | `{ name, deviceId }`（§4.7） | `E_UNAUTHORIZED` 401；`E_ACCOUNT_ACTIVE` 409（未在注销中） |

`secret` 校验：必须为 48 位小写 hex，否则 `E_SECRET_INVALID` 400。`platform` 非法字段归 `other`，不报错。

#### 配对（双向，取代 v3.6.0 的 7 个路由）

配对记录（纯内存，沿用 D10）：

```ts
{
  code: string,                 // 128-bit，进 URL
  direction: 'push' | 'pull',   // push=已登录端发起（正向）；pull=新设备发起（反向）
  kind: 'qr' | 'link',          // pull 恒为 qr
  accountId: string | null,     // push: 创建时绑定；pull: 批准时绑定
  accountName: string | null,
  pendingDevice: { id, hash, platform, label } | null, // push: claim 时登记；pull: request 时登记
  status: 'pending' | 'claimed' | 'approved' | 'denied' | 'cancelled',
  createdAt, expiresAt, decidedAt
}
```

| 方法 路径 | 鉴权 | 方向 | 说明 |
|---|---|---|---|
| `POST /auth/pair/create` | 会话 | push | `{ kind, ttlMinutes? }` → `201 { code, expiresAt }`。QR 固定 120s；link 档 5/15/30/60（默认 5）。每账号活跃 push ≤3，超出静默淘汰最旧（沿用） |
| `POST /auth/pair/request` | 无 | pull | `{ secret, platform }` → `201 { code, deviceId, expiresAt }`，固定 120s。登记 `pendingDevice`。全局活跃 pull 上限 **500**，超出 `E_PAIR_BUSY` 503 |
| `GET /auth/pair/info?code=` | 无 | 双向 | push → `{ direction, status, accountName, expiresAt }`；pull → `{ direction, status, newcomerLabel, expiresAt }`（不暴露任何账号信息） |
| `POST /auth/pair/claim` | 无 | push | `{ code, secret, platform }` → `{ deviceId, accountName, expiresAt }`；pending→claimed，登记 `pendingDevice`；重复 `E_PAIR_CLAIMED` 409 |
| `POST /auth/pair/approve` | 会话 | 双向 | `{ code, accept }`。push：要求 claimed 且同账号（**该账号任一设备均可**）；pull：要求 pending，批准时绑定当前账号。accept → 检查设备上限 → **把 `pendingDevice` 写入账号 `devices`** → approved；否则 denied |
| `POST /auth/pair/poll` | 无 | 双向 | `{ code, deviceId }`（deviceId 不符 410，防状态探测）→ `{ status, accountName? }`。**幂等、不含任何秘密**；approved 时新设备用本地 `secret` 拼出凭据即完成登录 |
| `POST /auth/pair/cancel` | 会话 | push | pending/claimed → cancelled；approved → 同时吊销已写入的设备（等价于设备吊销） |
| `GET /auth/pair/status` | 会话 | 双向 | 本账号全部未清扫记录；approved 记录附 `deviceOnline: bool`（= 该设备 `last_seen_at IS NOT NULL`），供弹窗显示「✓ 该设备已登录」 |

- `GET /rooms` 响应新增 `pendingPairings: number`（本账号 status=claimed 的 push 记录数），首页每 15s 刷新本就会取到——**任一已登录设备亮红点、可确认**，无额外请求。
- **轮询不承载秘密**，因此：原 D3（中转明文）、D4（claimKey 取件密钥）、D12（取件截止）、`GRACE_MS`、`consumed` 状态一并删除。「成功」以新设备首次上线（`last_seen_at` 被写）为准，取代 D14 的 consumed 语义。
- 清扫（惰性，沿用）：未决记录按 `expiresAt`；已决记录按 `decidedAt + 120s`。记录被清扫不影响已写入的设备——新设备即使错过轮询，也可直接用本地凭据登录（§4.6）。
- 删除旧路由 `/auth/pair/confirm`（并入 approve）。

错误码（`err.code`）：`E_PAIR_EXPIRED` 410、`E_PAIR_CLAIMED` 409、`E_PAIR_STATE` 409、`E_PAIR_KIND` 400、`E_PAIR_BUSY` 503、`E_PAIR_DIRECTION` 400（如对 pull 调 claim）、`E_DEVICE_LIMIT` 409、`E_SECRET_INVALID` 400。删除 `E_PAIR_TOKEN`、`ERR_WEB_ONLY`。

**错误码统一**：全部使用 `E_` 前缀（`ERR_NAME_TAKEN` → `E_NAME_TAKEN`、`ERR_UNAUTHORIZED` → `E_UNAUTHORIZED`、`ERR_NAME_INVALID` → `E_NAME_INVALID`），客户端 i18n 错误表同步。

日志（沿用）：只打 code 前 6 位 + 账号名 + 方向，绝不打凭据、`secret`、完整 code、请求体。

### 4.5 WS 鉴权（凭据不进 URL）

- 客户端：`useCollaboration.ts` 传 `WebSocketPolyfill`：

  ```ts
  class AuthedWS extends WebSocket {
    constructor(url: string) { super(url, ["polyphony.v1", `auth.${getToken()}`]); }
  }
  ```

  `params` 只保留 `userId`。
- 服务端：`new WebSocketServer({ server, handleProtocols: (set) => set.has('polyphony.v1') ? 'polyphony.v1' : false })`——**只回显 `polyphony.v1`，绝不回显凭据**。凭据只取 `auth.` 前缀子协议；缺失或无效 → `close(4001)`。不接受 `?token=`。
- 每个 ws 记录 `{ accountId, deviceId }`，供吊销 / 不活动清扫时定向关闭（4001）。
- 涉及 `useCollaboration.ts` 与服务端 relay → **必须跑收敛冒烟**。

### 4.6 客户端

#### 统一接收：`client/src/lib/intake.ts`（新）

```ts
type Intake =
  | { type: "join"; server: string; code: string }
  | { type: "pair"; server: string; code: string }
  | { type: "server"; server: string };
export function parseIntake(text: string): Intake | null;
```

吸收现有 `parseJoinPayload` / `parsePairPayload`；接受完整 URL（含首尾空白、聊天软件附带的前后文字取第一个 URL）。

#### `ScanModal` → 「扫码或粘贴链接」

- 上方摄像头区（有摄像头时），下方「粘贴链接」输入框 + 确定按钮；无摄像头（桌面常态）时直接展示粘贴框为主。
- 结果统一交给调用方的 intake 分派。所有现存「扫码」入口因此自动支持粘贴。

#### Welcome（未登录）——三入口

1. **创建账号**（全端；删除「仅 Web」说明）→ 本地生成 `secret` → 成功后进入「恢复密钥」页：显示一次，提供复制按钮，须勾选「我已妥善保存」才能继续 → 跳 `next` 或首页。
2. **从已登录设备登录**（App 默认 tab）：
   - 本机二维码：进入该 tab 时本地生成 `secret`，`POST /auth/pair/request`，显示 QR + 倒计时，过期自动刷新（每次刷新换新 `secret`）；tab 隐藏/页面不可见时停止刷新与轮询；poll 1.5s→30s 后 5s（沿用 D13）。
   - 「扫码或粘贴链接」按钮（push 落地流程，沿用现 PairView）。
   - 排序：移动端「扫码或粘贴链接」在上，桌面端本机二维码在上。
3. **使用恢复密钥**（次要文字链接）→ 输入框 → 本地生成 `secret` → `/auth/exchange`。

#### `/pair` 落地页（`Pair.tsx`）

按 `info.direction` 分支：
- `push`：沿用（预览 → 「在此设备登录」→ 本地生成 `secret` 并 claim → 等待 → 成功）。
- `pull`：已登录 → **批准页**：大字显示「`<newcomerLabel>`（服务端拼出的平台名，见 §4.2）请求登录你的账号 `<name>`」、发起时间、醒目警示「只批准你眼前、你本人正在操作的设备。若有人发给你这个二维码，请拒绝。」、倒计时、批准/拒绝；未登录 → 「请在已登录的设备上扫此码」。
- 已登录设备扫到 `push` 码：同账号 → 「本机已登录该账号」；不同账号 → 「本机已登录 X，如需切换请先退出」。

#### Home（已登录）

- 头像菜单「登录其他设备」**全端可见**（删 `isAndroidTauri` 门控）；菜单另有「扫码或粘贴链接」（已有扫码入口改造），intake 分派：`join` → 进房；`pair` → 按 direction（pull → 批准页；push → 上述提示）。
- 红点来源：`/rooms` 的 `pendingPairings > 0`；>0 时启动配对状态轮询（开弹窗 1s / 关 5s，沿用 D13），列表展示本账号全部 push 记录，任一设备均可确认/拒绝/撤销。
- 退出登录：`POST /auth/logout`（失败也继续）→ 清本地（凭据 + 文档缓存，见姊妹篇 §4.8）。

#### Settings —— 新增两段

- **已登录设备**：列表（设备名、最后在线、「本机」标记）；非本机项「吊销」（二次确认）；本机项显示「退出登录」；底部注明「180 天未上线的设备会自动移除」。
- **恢复密钥**：「重新生成」（二次确认：旧密钥立即作废）→ 显示一次 + 复制 + 勾选确认。
- **注销账号**（危险区，§4.7）。

#### 分享弹窗

`QrModal`（邀请进房间、分享本站）加「复制链接」按钮（复用现有 clipboard 降级逻辑）；`PairModal` 已有。

#### `auth.ts`

- `newDeviceSecret()`：`crypto.getRandomValues(new Uint8Array(24))` → 48 hex；`assembleToken(deviceId, secret)` → `poly_d_<deviceId>_<secret>`。`secret` 在拿到 `deviceId` 前只存在于内存，拼好后整体存 localStorage。
- `platformInfo()`（在 `platform/` 中）：返回 `{ client, os }` 枚举。
- **v3 本地残留一次性清理**（应用启动时）：本地存有凭据但不是 `poly_d_` 格式 → 清除凭据、全部 `polyphony-room-*` IndexedDB 库、本地最近房间 → 欢迎页。无凭据时不做任何事。
- 配对等待中：poll 得 `approved` → 拼凭据 → `/auth/me` 验证 → 进入。poll 得 410（记录已清扫，如设备休眠错过）→ 用已持有的 `deviceId + secret` 直接试一次 `/auth/me`：200 即登录成功，401 才报「已过期」。
- `createAccount` 返回 `{ token(本地拼好), recoveryKey }`；`exchangeRecovery(key)` 新增。

### 4.7 注销账号

**服务端**（`POST /auth/account/delete`，会话，入参 `{ name }` 须与账号名一致）——单个事务：

1. `accounts.deleted_at = now`。
2. 删除该账号全部设备（关闭其 WS，4001）；撤销其全部配对记录。
3. 本人拥有的 **active** 文档 → trashed（`trash_reason = 'account_deleted'`，`trashed_at = now`），关闭这些文档的 WS（4010）。本人拥有、已在回收站中的文档按各自原有期限处理。

**30 天内撤销注销**（`POST /auth/account/restore`，无会话，入参 `{ key, secret, platform }`，`key` 为恢复密钥）：`deleted_at` 置空；`trash_reason = 'account_deleted'` 的自有文档恢复为 active；为本机登记新设备 → `{ name, deviceId }`。

**30 天到期**（调度器）：先按姊妹篇 §4.6 purge 该账号 `account_deleted` 的文档（与账号同日到期），再删除账号行（级联删除设备与成员关系），用户名释放。

**注销中的账号**：一切会话不存在（设备已删）；`/auth/exchange` 返回 409 `E_ACCOUNT_DELETED { purgeAt }`；同名注册返回 `E_NAME_TAKEN`。

**客户端**：Settings 底部「注销账号」（危险区）→ 说明后果（所有设备登出、自有文档进回收站、30 天后彻底删除、期间可用恢复密钥撤销）→ 输入账号名确认 → 清本地 → 欢迎页。欢迎页「使用恢复密钥」收到 `E_ACCOUNT_DELETED` → 显示「该账号正在注销（N 天后彻底删除）」+「撤销注销」按钮。

---

## 5. 边界与失败路径

| 场景 | 处理 |
|---|---|
| 轮询响应丢失 / 新设备休眠错过 | 轮询幂等，再问一次即可；记录已被清扫（410）时直接用本地 `deviceId + secret` 试 `/auth/me`，成功即登录 |
| 批准后新设备再未出现 | 设备已写入但 `last_seen_at` 为 NULL，24h 后孤儿清理；发起端列表显示「等待该设备上线」 |
| 设备 180 天未上线 | 清扫时自动吊销；该设备下次打开 401 → 欢迎页，重新配对 |
| 设备达 20 台上限 | 批准 / 兑换返回 `E_DEVICE_LIMIT`，提示「请先在设置中吊销不用的设备」 |
| pull 请求被大量匿名创建 | 全局 500 上限 + 120s 自然过期；Welcome 仅在 tab 可见时创建 |
| 新设备离开 Welcome | 停止轮询，记录 120s 内过期（不提供 abandon 接口） |
| 批准方扫到已过期 pull 码 | 410 → 「二维码已过期，请让对方刷新」 |
| 已登录设备扫到 push 码 | 不 claim，提示本机已登录（§4.6） |
| 吊销正在编辑的设备 | 其 WS 立即 4001 断开；该设备下次 HTTP 401 → 回欢迎页（现有 `authFetch` 逻辑） |
| 离线时退出登录 | logout 请求失败也清本地；设备留在列表，可在别处吊销 |
| 恢复密钥被直接用作会话 | 401；客户端粘贴入口只走 exchange，不会触发 |
| 客户端提交非法 `secret` | 400 `E_SECRET_INVALID`（非 48 位小写 hex） |
| 客户端伪造 `platform` | 非法值归 `other`；只能在固定枚举里「冒充」平台，无法写入任意文字 |
| 恢复密钥丢失且无其他已登录设备 | 账号无法找回，只能新建账号（V3 的已知代价；注册页强制确认已保存） |
| 注销后想反悔 | 30 天内恢复密钥 →「撤销注销」；自有文档中因注销进回收站的随之恢复，注销前已在回收站的不受影响 |
| 注销中的账号被他人尝试注册同名 | `E_NAME_TAKEN`，到期后才释放 |
| 注销时他人正在编辑其文档 | 这些文档进回收站，在线连接 4010 断开（同所有者删除） |
| v3 老 App 连 v4 服务器 | 旧 token 401 → 欢迎页；老 App 的注册/登录流程与 v4 接口不兼容 → 提示升级（发版说明强调） |
| 新 App 连 v3 服务器 | 创建/兑换/配对接口不存在或格式不符 → 「服务器版本过低，请升级」 |
| WS 未携带子协议凭据 | 4001 |

---

## 6. 上线：v4 全新开始

**服务端首次启动（`server/resetV3.js`，在加载任何数据前执行，幂等）**：

1. 若 `data/accounts.json` 存在（v4 从不写此文件）→ 判定为 v3 数据。
2. 创建 `data/_v3-archive-<时间戳>/`，把 `data/accounts.json` 移入；创建 `uploads/_v3-archive-<时间戳>/`，把 `uploads/` 根目录下的平铺图片移入。全部为同卷内 `rename`，原子、不复制。
3. 随后 `db.js` 新建 `data/polyphony.db`；日志 `[reset] v3 data archived to <路径>`。
4. 归档目录不被任何路由访问；确认无误后由运维手工删除（`docs/deploy-and-ops.md` 写明命令）。

**客户端**：首次启动 v4 时执行 §4.6 的本地残留清理。

**上线顺序与影响**：
- **合入 `main` 即触发 Gitea CI 自动部署 → 生产数据立即被归档清空**。因此 v4 全程在分支开发；合入时机 = 计划好的切换时刻，并同时推 `v4.0.0` tag 触发 GitHub Release 出全套安装包。
- 切换后所有人需：升级 App（v3 App 不可用）→ 重新注册 → 重新创建文档。发版说明与 CHANGELOG 顶部醒目写明。

**回滚**：回退到 v3 镜像，并把 `_v3-archive-*` 中的文件移回原位（v3 读取原数组格式）。v4 期间产生的数据对 v3 不可见。

---

## 7. 可观测性与测试

### 日志

- 账号：`[auth] create <name>` / `exchange <name>` / `revoke <name> <deviceId前8>` / `logout` / `regenerate <name>` / `account-delete <name>` / `account-restore <name>` / `account-purge <name>`。
- 配对：沿用 code 前 6 位 + 方向 + 账号名。
- 清扫：`[auth] sweep orphan=<n> inactive=<n>`（附账号名，不附设备凭据）。
- 重置：`[reset] v3 data archived to <路径>`。
- 绝不记录任何凭据明文、`secret`、恢复密钥、完整 code、请求体。

### 验收清单

服务端单测（`node --test`，可注入时钟与临时目录）：
- [ ] create 只返回 `deviceId` + 恢复密钥，**响应体不含提交的 `secret`**；拼出的设备凭据过 `/auth/me`；恢复密钥直接作会话 401
- [ ] exchange：正确恢复密钥得新设备；错误密钥 401；达上限 409
- [ ] 吊销后该凭据 401；logout 后本机凭据 401
- [ ] regenerate：新密钥可兑换、旧密钥 401
- [ ] 非法 `secret` 400；非法 `platform` 归 other；设备名只由枚举 + UA 白名单拼出
- [ ] push：create→claim→approve（**同账号另一设备**）→ 设备写入 → poll approved 且**全部配对响应均不含 `secret`**；重复 poll 结果一致（幂等）；异账号 approve 拒绝
- [ ] pull：request→info 不含账号→approve 绑定并写入设备→poll approved；deny；过期 410；500 上限 503
- [ ] deviceId 不符的 poll 410；pull 调 claim → `E_PAIR_DIRECTION`
- [ ] 记录清扫后，本地 `deviceId + secret` 拼出的凭据仍可过 `/auth/me`
- [ ] cancel approved 记录 → 对应设备被吊销
- [ ] `deviceOnline` 在新设备首次鉴权后变 true
- [ ] 孤儿设备 24h 清理；180 天不活动自动吊销（注入时钟）；`last_seen_at` 写库节流
- [ ] `/rooms` 含 `pendingPairings`
- [ ] 重置：`accounts.json` + 平铺图片 → 均移入归档目录、新建空数据库；再次启动不重复归档；无 v3 数据时不动作
- [ ] 注销：设备全删且旧凭据 401；自有 active 文档 → trashed(account_deleted)，已在回收站的不变；exchange 返回 `E_ACCOUNT_DELETED`；同名注册 `E_NAME_TAKEN`
- [ ] 撤销注销：恢复密钥 → 账号恢复、`account_deleted` 文档恢复 active、得新设备；对未注销账号调用 409
- [ ] 注销满 30 天：自有文档 purge、账号行删除（级联设备与成员关系）、用户名可再注册
- [ ] 事务性：注销事务中途失败（注入异常）→ 账号、设备、文档状态均未改变
- [ ] 错误码全部为 `E_` 前缀

收敛冒烟（`server/convergence-smoke.mjs`，**必跑**）：
- [ ] 双客户端经子协议鉴权，100 次交错插入 + 删除轮 + meta + awareness 断言通过
- [ ] `?token=` 连接被拒（4001）；子协议响应头只含 `polyphony.v1`
- [ ] 吊销设备 → 其 ws 收到 4001
- [ ] 配对双向往返

E2E（`cd e2e && npx playwright test`，本地）：
- [ ] 创建账号 → 恢复密钥页（未勾选不能继续）→ 首页
- [ ] 正向：A 出码 → B 粘贴链接 → B 点登录 → **A 的另一个 context（同账号第二设备）** 看到红点并确认 → B 进首页
- [ ] 反向：B 欢迎页显示本机码（从 DOM 读 URL）→ A 打开该 URL 批准页 → 批准 → B 自动进入首页
- [ ] 设置页吊销 B → B 下次操作回欢迎页
- [ ] 注销账号 → 回欢迎页；恢复密钥登录提示「正在注销」→ 撤销注销 → 回到首页，文档仍在
- [ ] 恢复密钥登录；重新生成后旧密钥失败
- [ ] 邀请进房间 / 分享本站弹窗有「复制链接」
- [ ] 无凭据打开 `/join` → 欢迎页创建账号 → 回到房间
- [ ] localStorage 预置 v3 格式 token → 启动后被清除并回欢迎页
- [ ] 更新受影响的既有用例（账号创建辅助函数、`ui-mobile` 欢迎页按钮文案、`pairing.spec.ts`）

手工（发版前）：
- [ ] 真机：Android App 扫桌面 App 欢迎页本机码 → 批准 → 桌面登录
- [ ] 真机：Android App「登录其他设备」→ 桌面 App 粘贴链接
- [ ] 真机：从 v3.5.0 APK 覆盖安装 v4 APK → 本地残留被清理 → 欢迎页
- [ ] 真实时钟跑一次 5 分钟档链接过期
- [ ] 本地用生产数据卷副本演练重置：归档目录内容完整、v4 从空启动

---

## 8. 分期与工作量

**一次发版 v4.0.0**（用户拍板：去 web 化交互 + 新图标 + CI 改动 + 本方案 + 文档生命周期合并发版）。内部按依赖顺序实施，每步可独立验证：

| 步 | 内容 | 验证 |
|---|---|---|
| 1 | 服务端骨架与凭据模型：`index.js` 拆分为 `routes/*` + `db.js`（SQLite 建表）+ `sweeper.js`（统一调度器）；`resetV3.js`；`auth.js` 重写（设备 / 恢复密钥 / 节流 / 孤儿与 180 天清扫 / 平台枚举拼名）；create / exchange / devices / logout / regenerate / 注销与撤销；删 Origin 门控；错误码统一 `E_` | 单测 |
| 2 | WS 子协议鉴权 + 定向关闭；`useCollaboration.ts` | 收敛冒烟 |
| 3 | 配对 v2：`pairing.js` 双向 + pendingDevice 批准即写入 + 无秘密幂等轮询 + approve 统一 + pull 上限；`/rooms.pendingPairings` | 单测 + 冒烟 |
| 4 | 客户端基础：`auth.ts` 本地 secret / 拼凭据 / v3 残留清理 / 登出、`platformInfo()`、`intake.ts`、`ScanModal` 粘贴、`QrModal` 复制 | tsc/eslint |
| 5 | 页面：Welcome 三入口 + 恢复密钥页、`Pair.tsx` 双分支、Home 门控 / 红点 / 登出、Settings 两段、i18n | e2e |
| 6 | 文档：本文件状态更新、`pairing-login.md` 标注取代、ADR（#34 起）、CHANGELOG（顶部醒目写明全新开始）、AGENTS.md 账号相关描述、`docs/architecture.md`、`docs/deploy-and-ops.md`（归档目录与清理命令、SQLite 备份 `VACUUM INTO`） | — |
| 7 | 版本号 3.5.0 → 4.0.0；全量 lint/build/单测/冒烟/e2e；真机手工清单；择时合入 `main` + 推 tag | §7 |

姊妹篇 `docs/document-lifecycle.md` 的 L1–L6 步插入本表：L1–L4 在第 3 步之后、第 4 步之前；L5 与第 4–5 步合并；L6 与第 6–7 步合并（两边都改 WS 连接与服务端同一批文件，按此顺序避免返工）。

**明确推迟**：`polyphony://` 唤起、设备改名、同网络提示、数字比对、新设备冷静期、OS keychain、创建限流。

---

## 9. 已定决策与被否方案

| # | 决定 | 理由 | 被否方案及理由 |
|---|---|---|---|
| V1 | 每台设备独立凭据 | 可逐台吊销、真退出登录；配对不再需要中转明文 | 维持共享 token：丢设备即永久失守 |
| V2 | **设备凭据的秘密由设备本地生成**，注册/兑换/配对时提交一次，服务端只存 `sha256`；除恢复密钥外无任何响应返回秘密；批准即写入设备，轮询幂等不含秘密 | 消灭 D3（中转明文）/D4（claimKey）/D12（取件截止）/宽限期/取件丢失；轮询被截获也无用（第二轮评审改进 1） | ①服务端取件时现铸、在 poll 响应中返回：响应丢失须重新配对，且仍需 claimKey 防截取；②客户端只提交哈希：`crypto.subtle` 在 `http://IP` 非安全上下文不可用，而 secret 本就随 Bearer 发出，提交原文不增加暴露面 |
| V3 | 恢复密钥注册时**强制**生成，只显示一次，可在设置页重新生成（旧的立即作废） | 用户拍板「只有一次机会，必选」；可轮换才能在泄露时止损 | 可选、按需生成（用户否）；终身不可轮换：泄露即永久失守 |
| V4 | **v4 全新开始**：v3 账号/文档/图片首次启动时归档清空，代码不含任何 v3 兼容 | 用户拍板「不管历史数据，全部扔掉」（第三轮评审）；删除旧 token 会话、自动兑换迁移、`?token=` 回落、回滚兼容字段等一整层复杂度 | 兼容迁移（上一版）：旧 token 兼作 legacy 会话直至轮换、客户端启动自动兑换、恢复密钥复用 v3 字段保回滚——每条都要额外的状态、测试与权限规则 |
| V5 | 恢复密钥存独立字段 `accounts.recovery_hash` | V4 后无回滚兼容需求 | 复用 v3 `salt/tokenHash` 字段（上一版，为回滚无损；随 V4 作废） |
| V6 | 全端可创建账号，删 Origin 门控 | 门控挡不住 curl，不是安全控制；只制造 App 新用户死路 | 保持仅 Web（ADR #24，本条推翻） |
| V7 | 双向配对共用 `/pair` URL、一套状态机、统一 `approve` 接口 | 一套载荷/解析/落地页；批准永远在已登录端 | 反向另立 `/approve` 路由与状态机：重复实现 |
| V8 | 反向防钓鱼 = 设备名 + 醒目警示 + 120s 有效期 | 与微信/Discord 同级，零额外步骤 | 同网络 IP 提示：蜂窝/WiFi 误报，反代需配可信代理；数字比对：挡不住连数字一起转发的钓鱼 |
| V9 | App 只做粘贴链接 | 用户拍板；零插件 | `polyphony://` + deep-link/single-instance 插件（推迟） |
| V10 | 统一接收入口「扫码或粘贴链接」 | 所有扫码入口自动支持链接；桌面无摄像头时有路可走 | 各页面各自加粘贴框：重复、易漏 |
| V11 | 待确认请求在账号任一已登录设备处理，数量挂 `/rooms` 响应 | 生成链接的设备未必在手边；复用 15s 刷新零额外请求（第一轮评审改进 2） | 仅发起设备可确认（v3.6.0 现状） |
| V12 | WS 凭据只走 `Sec-WebSocket-Protocol`，只回显 `polyphony.v1` | 凭据不进 URL / 代理访问日志（第一轮评审改进 4；D15 遗留）；V4 后无需 `?token=` 回落 | 维持查询参数 |
| V13 | 吊销立即关闭相关 WS | 丢失设备不能继续编辑到下次重连 | 等重连自然失效 |
| V14 | 每账号 20 台设备，超出报错 | 不静默踢掉用户的设备 | 静默淘汰最旧：用户莫名被登出 |
| V15 | 设备名由服务端按 `platform` 枚举 + UA 浏览器白名单拼出，**不接受客户端自由文本**；v1 不可改名 | 批准页是反向配对唯一的防钓鱼手段（V8），自由文本能写成「你的 MacBook（请批准）」（第二轮评审改进 2） | 客户端自报任意 label：可被用于社工话术；可改名（推迟） |
| V16 | 批准后从未上线的设备 24h 清理 | 新设备可能在批准后消失，留下孤儿 | 永久保留：列表堆垃圾 |
| V17 | ~~legacy 会话不能做设备管理~~（**已作废**：随 V4 不再存在 legacy 会话） | — | — |
| V18 | v4.0.0 一次合并发版 | 用户拍板 | 先发 v3.6.0（去 web 化 + 图标）再做 v4 |
| V19 | 恢复密钥注册时强制显示，须勾选「已妥善保存」 | 「只有一次机会」需要显式确认 | 仅显示不确认：易被直接点过 |
| V20 | 180 天未上线的设备自动吊销 | 抽屉里的旧手机凭据不应永久有效（第二轮评审改进 4） | 永不过期：被遗忘的设备是长期攻击面；更短（如 30 天）：间歇使用的协作工具会频繁要求重新配对 |
| V21 | 所有秘密哈希一律 `sha256`、不加盐 | 192-bit 随机秘密无字典攻击面 | 加盐：无收益 |
| V22 | v3 数据归档（同卷 rename）而非直接删除 | 「扔掉」落地为可人工撤回的动作；零复制成本 | 直接删除：误操作不可逆；保留原地：v4 代码需识别并忽略旧格式 |
| V23 | 全部持久数据存单个 SQLite 文件（Node 内置 `node:sqlite`），文档快照也作为 BLOB 存入 | 跨实体操作（建文档 + 成员关系、注销、清除）可放进一个事务；清扫变成查询；备份一个文件；零原生依赖（第四轮评审） | JSON 文件整份重写（上一版）：跨文件非原子，需「落盘纪律」等补丁；快照仍存文件：清除时删文件游离在事务外。代价：`node:sqlite` 仍为实验特性，启动参数加 `--disable-warning=ExperimentalWarning`，升级 Node 大版本时复核 API |
| V24 | 提供注销账号：立即登出全部设备、自有文档进回收站；30 天内恢复密钥可撤销；到期彻底删除并释放用户名 | 账号与文档一样要有完整的一生；30 天与文档回收站同一节奏（第四轮评审） | 不提供注销：账号只生不死；立即彻底删除：误操作不可逆 |
| V25 | 错误码统一 `E_` 前缀；`server/index.js` 按领域拆分；三类清扫合并为一个调度器 | 全新开始无兼容负担，顺手清理 | 维持现状 |

沿用自 `pairing-login.md` 且仍有效：D1（码内不放凭据）、D2（两种方式都须人工确认；确认方从「发起的网页端」推广为「该账号任一已登录设备」，见 V11）、D5（确认窗口 = 至过期）、D6（QR 与链接同 URL）、D7（严格一次性）、D8（落地页显式按钮才 claim）、D9（弹窗可关、红点召回）、D10（纯内存）、D11（可撤销）、D13（条件化轮询与退避）、D14（approved ≠ 成功；「成功」改以新设备首次上线判定）、D15（POST + no-store）。**推翻**：D3、D4、D12（均被 V2 取代）。

---

## 10. 遗留问题

| 问题 | 默认假设 / 处理 |
|---|---|
| 房间邀请码是永久有效、不可撤销的 bearer 码（与共享 token 同类问题） | 本次不做；需房间成员/权限模型，另立项 |
| 新设备冷静期（Telegram 式：新设备 24h 内不能吊销他人、不能轮换恢复密钥），防钓鱼得手后锁死主人 | 默认不做（ADR #14 内网/受信威胁模型）；公网部署出现滥用再加 |
| 凭据存 localStorage，XSS 可读 | 默认不做；App 端将来可迁 OS keychain |
| 创建账号无限流 | 默认不做；公网部署建议在反代层限流 |
| 归档目录何时删除 | 运维确认 v4 稳定后手工删除；不做自动清理 |

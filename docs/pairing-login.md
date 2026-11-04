# 配对登录（扫码 / 邀请链接）设计

状态：**已实现**（2026-11-02 定稿并同日实现：`server/pairing.js` + 7 路由、`PairModal`、`/pair` 落地页、Welcome 扫码、单测×11 + e2e×4 + 冒烟扩展；评审三轮记录见 §9。实现与文档的两处对齐修订：claim 响应补 `expiresAt`（等待屏倒计时），cancel 保留 claimKey 至清扫（否则手机端无法报「已被撤销」））
前置决策：ADR #24（账号体系）、#4（QR 载荷 = Web URL）、#14（内网/受信威胁模型）

## 1. 背景与目标

移动端（Android App / 手机浏览器）登录目前唯一路径是「从别处复制 token → 粘贴」：
token 是 48+5 字符的随机串，跨设备复制（微信传话/手抄）既麻烦又让永久凭据途经聊天记录。

目标：**Web 端（已登录会话）生成二维码或邀请链接，手机扫码/点开即登录，
token 明文永不出现在二维码或链接里。**

成功判据：
- 手机装好 App 后 30 秒内完成登录，全程无复制粘贴；
- 二维码/链接被拍照、截图、转发，都不能直接换来 token（须网页端人工确认）；
- 旧客户端（粘贴登录、现有 WS/房间流程）行为零变化。

非目标（v1 明确不做，见 §8）：
- 每设备独立 token、设备列表、吊销；
- 免确认快登模式；
- 邀请**他人**注册（链接语义 = 把「我」的登录态带到新设备，不是拉新账号）；
- Android 深链（App Links）；
- claim 接口限流（128 位随机码，在线猜测不可行，见 §5）。

## 2. 现状（相关模块）

| 模块 | 位置 | 要点 |
|---|---|---|
| token 模型 | `server/auth.js:64-87` | `poly_`+48hex 一次性展示；服务端只存 `sha256(salt+token)`，**没有明文可发** |
| 登录入口 | `client/src/pages/Welcome.tsx` | create/login 两 Tab（App 隐藏 create）；`?next=` 回跳机制已有 |
| WS 鉴权 | `server/index.js:217` | `?token=` 查询参数；本次不触碰 |
| QR 基建 | `client/src/lib/qr.ts` | 载荷=Web URL（ADR #4）；`parseJoinPayload` 会吞**任何**带 `?code=` 的 URL（本设计需修） |
| 出码组件 | `client/src/components/QrModal.tsx` | canvas 渲染，可复用 |
| 扫码组件 | `client/src/components/ScanModal.tsx` + `client/src/platform/scanQr.ts` | Android 原生插件 / 其余 jsQR；可直接复用 |
| 头像菜单 | `client/src/pages/Home.tsx:234`（`Menu`/`MenuItem`） | v3.5.0 设置收敛处，新入口挂这里 |
| 落地页先例 | `client/src/pages/Join.tsx` | `/join?code=&server=` 的固化 server + next 回跳模式，`/pair` 照此办理 |
| 测试 | `e2e/tests/auth.spec.ts`、`server/convergence-smoke.mjs` | e2e 双 context 模式已有（见 `e2e/README.md`） |

## 3. 方案总览

**一个配对原语（pairing），两种发放方式，统一要网页端确认。**
二维码和邀请链接是**同一个 URL** `<server>/pair?code=<code>&server=<serverBase>`——
二维码只是这个 URL 的渲染形态，链接是它的文本形态；区别仅在 TTL。

```text
  Web(已登录, 有token)                    Server(内存Map)                 手机(App扫码/浏览器点链接)
  ─────────────────────                  ───────────────                 ─────────────────────────
  头像菜单→「登录新设备」
  ├─ POST /pair/create ──────────────→  生成 code(128bit)
  │    QR: TTL 2min 固定                 {accountId,kind,expiresAt,
  │    链接: 5/15/30/60min                status:pending}
  │←──── code + expiresAt ──────────┤
  出码/复制链接, 轮询 status(开1s/关5s)   (任何人持 code)
  │                                      ←──── POST claim{code} ──────── 欢迎页扫码 / /pair 页按钮
  │                                      status→claimed, 发 claimKey
  │←──── status=claimed+设备UA ──────┤   ←──── poll POST(1.5s→5s) ──── 页面停「等待网页确认」+剩余时间
  人工核对 → [确认][拒绝]
  ├─ POST confirm{code,accept,token} →   claimed→approved
  │   (token 此刻进内存)                  token 存入记录
  │                                      ───── {status:approved, ──────→ setToken → /auth/me 校验
  显示「等待取件」→✓(手机取走)                          │       token, account}          → ?next 回跳
  │                                      approved→consumed(首次取走)
  │                                      30s 宽限/取件截止后擦除
```

token 暴露面分析（相对现状的增量）：
- 码/链接只含 `code`——拍照、截图、转发得到的都只是一个短命一次性占位符；
- token 明文只在两处过网络：Web 的 confirm 请求体（与既有 Bearer 请求同级）、
  手机的一次 poll 响应；服务端内存驻留 ≤ min(过期, 确认后 2 分钟)+30s 宽限（D12）；
- 服务端本来就能在每个 Bearer 请求里看到 token，中转**不新增**服务端可见面。

## 4. 详细设计

### 4.1 服务端数据模型（纯内存，单进程）

`server/auth.js` 旁新增 `server/pairing.js`：

```js
// Map<code, record>，code = 22 字符 base64url（16 字节 CSPRNG ≈ 128 位）
{
  code, accountId, kind: 'qr'|'link',
  createdAt, expiresAt,            // qr: now+120s；link: now+tier
  status: 'pending'|'claimed'|'approved'|'denied'|'consumed'|'cancelled',
  claimedMeta: { ua, at } | null,  // claim 请求的 User-Agent，确认 UI 展示
  claimKey: string | null,         // claim 时签发的第二个 128 位随机串
  token: string | null,            // confirm 时由 Web 存入；cancel 立即置 null
  pickupDeadline: number | null,   // confirm 时 = min(expiresAt, confirmedAt+120s)（D12）
  consumedAt: number | null,       // 首次取走时间
}
```

- **过期判定惰性化**：所有读写入口先 `sweep()`——未确认态 `now > expiresAt`、
  已确认态 `now > max(consumedAt, pickupDeadline)+30s`（取件宽限）即删除；无定时器。
  **取件截止（D12）**：confirm 时写 `pickupDeadline = min(expiresAt, confirmedAt+120s)`——
  手机 1.5s 一轮询，2 分钟没取走即失联，明文 token 不陪整个 TTL 驻留内存。
- **并发上限**：单账号活跃（pending/claimed/approved）配对 ≤ 3，create 时静默淘汰最旧。
- **持久化：无。** 服务重启 = 全部配对丢失，双端表现为「已过期，重新生成」。
  配对是秒~分钟级瞬态，不配进 `accounts.json`。

### 4.2 接口契约（`server/index.js` 新增七个路由）

| 接口 | 鉴权 | 请求 | 成功响应 | 错误 |
|---|---|---|---|---|
| `POST /auth/pair/create` | Bearer | `{kind:'qr'\|'link', ttlMinutes?:5\|15\|30\|60}` | `201 {code, kind, expiresAt}` | `400 E_PAIR_KIND`（非法 kind/tier；qr 忽略 ttlMinutes 固定 120s） |
| `GET /auth/pair/status` | Bearer | — | `{pairings:[{code,kind,status,expiresAt,claimedMeta?}]}`（本账号全部**未清扫**记录，含终态 consumed/denied/cancelled——弹窗靠它显示最终结果，sweep 后自然消失） | 401 |
| `GET /auth/pair/info` | 无 | `?code=` | `{accountName, kind, expiresAt, status}`（`/pair` 落地页预览用） | `410 E_PAIR_EXPIRED`（不存在/已过期/已终态） |
| `POST /auth/pair/claim` | 无 | `{code}` | `200 {claimKey, accountName, expiresAt}`（status→claimed；accountName/expiresAt 供扫码路径等待屏显示「正在为某人登录」与剩余时间倒计时） | `409 E_PAIR_CLAIMED`（已被 claim）；`410 E_PAIR_EXPIRED`（其余） |
| `POST /auth/pair/poll` | code+claimKey | `{code, key}`（走 body：claimKey 不进 URL/代理日志；含 token 的响应绝不可 GET 化） | claimed→`{status:'claimed'}`；approved/宽限内 consumed→`{status:'approved', token, account:{id,name}}`（首次命中即置 consumed）；denied→`{status:'denied'}`；cancelled→`{status:'cancelled'}` | `410 E_PAIR_EXPIRED`；key 不符一律 `410`（不区分，避免探测） |
| `POST /auth/pair/confirm` | Bearer | `{code, accept:boolean, token?}` | `200 {status:'approved'\|'denied'}` | 仅 owner（accountId 匹配）且 status=claimed 时有效，否则 `409 E_PAIR_STATE`；accept=true 必须带合法 token（过 `verifyToken` 且属本账号），否则 `400 E_PAIR_TOKEN` |
| `POST /auth/pair/cancel` | Bearer | `{code}` | `200 {status:'cancelled'}`——pending/claimed/approved 均可撤；立即清 token（claimKey 保留至清扫，手机端 poll 才能报「已被撤销」）（D11） | 终态或非 owner → `409 E_PAIR_STATE` |

约束：
- **全部 `/auth/pair/*` 响应加 `Cache-Control: no-store`**（D15：poll 响应含 token，
  可被中间盒/浏览器启发式缓存属事故级；POST 化是纵深，no-store 是底线）；
- `claim`、`poll` 无鉴权——安全性由 code/claimKey 各 128 位熵承担（§5）；
- `status`/`confirm` 是唯一需要 Bearer 的两个；`confirm` 是唯一写 token 的入口；
- 所有 `E_PAIR_*` 错误码进客户端 i18n（zh/en 同步，参照 ADR #22 稳定码模式）。

### 4.3 状态机

```text
pending ──claim──→ claimed ──confirm(accept)──→ approved ──首次poll取走──→ consumed
                      │                            │
                      ├──confirm(reject)──→ denied │ 取件截止 = min(expiresAt, 确认+120s)：
                      │                            └─ 逾期未取作废，+30s 宽限后 sweep
pending / claimed / approved ──cancel(owner)──→ cancelled（终态，立即清 token/claimKey）
pending / claimed ──expiresAt 到点──→ （读取时判定）expired，sweep 删除
```

- 确认窗口 = **claim 之后直到 expiresAt**（QR ≤2min，链接到所选档位）。这是
  「长 TTL 链接 + 必须网页确认」能共存的关键：链接第 30 分钟被点开，回到电脑前确认仍有效；
- 严格一次性：`claimed` 后其他设备 claim 一律 `409`；`consumed` 后原码作废。
- 撤销即救济（D11）：发错链接/反悔随时 cancel，手机端下次 poll 得 `cancelled` 显示「已被撤销」。

### 4.4 客户端改动

**发起端（Web + 桌面 Tauri；Android App 隐藏入口）**
- `Home.tsx` 头像菜单加「登录新设备」`MenuItem` → 新组件 `PairModal`：
  - 打开即 `create(kind:'qr')` 出码（复用 `QrModal` 的 canvas 渲染），倒计时 mm:ss；
    到期且未被 claim 时**自动重生成**（屏显码常新，无需手动点；链接永不自动重生成——
    发出去的码不能变）；
  - 「改发邀请链接」区：档位下拉（默认 5 分钟）+ 生成按钮；生成后**只读展示 URL +
    复制按钮**（用户可核对去向；e2e 直接从 DOM 取 URL，不依赖系统剪贴板）；
  - 活跃配对列表（来自 `status`）：每项显示 kind/状态/剩余时间/已 claim 设备的 UA
    （解析成「Chrome · Android」式短标签）；操作随状态分化（D14）：
    pending → `[撤销]`；claimed → `[确认登录] [拒绝] [撤销]`（确认把 `getToken()`
    放进 confirm 请求体）；approved → 「已确认，等待设备获取」（**不是**成功）；
    consumed → ✓ 该设备已登录（手机真取到 token 才报成功）；
  - 关闭弹窗不放弃配对：红点条件 = 存在 `claimed`（待你确认才值得打扰；
    pending/终态不亮）。轮询生命周期（D13）：**有未清扫配对才轮询**——
    弹窗开 1s、关 5s，全部终态且清扫后即停；
  - 重开弹窗用 `status` 返回的 `code` 对未过期 QR 配对**直接重渲染二维码**，无需重新生成。
- 桌面端入口天然可用（`authFetch` 同构），无额外适配。

**接收端 A：App 内扫码（主路径）**
- `Welcome.tsx` login Tab 粘贴框下方加「扫码登录」按钮（全平台可见，桌面摄像头走
  jsQR 亦可）→ 复用 `ScanModal`；
- 扫码结果分发顺序：**先 `parsePairPayload`（path === `/pair`）再 `parseJoinPayload`**，
  同时修 `parseJoinPayload`：path 为 `/pair` 时返回 null（当前实现会吞掉任何 `?code=`）；
- 命中 pair：`saveServer(server)` → `claim` → 持 claimKey 轮询（前 30s 每 1.5s，
  后退避 5s——长 TTL 链接可能等几分钟才确认），UI 停在「请在网页端确认」+
  **剩余有效期倒计时**（来自 `info.expiresAt`，用户知道还值不值得等）→
  取到 token 后 `setToken` → `/auth/me` 校验 → `goNext()`；
- 扫到的是**房间码**（join URL/裸 8 位码）：不跳 `/join`（未登录会被弹回 Welcome 打转），
  就地暂存 `next=/join?...&server=...` 并提示「登录后将自动进入房间」，登录成功续走。

**接收端 B：手机浏览器 `/pair` 落地页（系统相机/点链接兜底）**
- 新路由 `/pair?code=&server=`（照 `Join.tsx` 模式：固化 server、支持 `?next=`）；
- 页面加载先 `info` 预览：显示服务器地址、账号名、类型、剩余有效期；
  **显式按钮「在此设备登录」** 点击才 `claim`（防手滑/防发送端自己点开烧码）；
  claim 后同 A 的等待-轮询-落库流程；成功后进首页（该浏览器即登录态），
  移动 UA 下成功页提示「已登录网页版；要在 App 中使用，请用 App 欢迎页的
  扫码登录」——在微信里点链接登录的是微信内置浏览器，这是装 APK 用户最易踩的混淆。

### 4.5 时间与轮询参数（非分叉，拍板值）

| 参数 | 值 |
|---|---|
| QR TTL | 120s（固定，忽略入参） |
| 链接 TTL 档位 | 5/15/30/60 分钟，默认 5 |
| 取件截止 | confirm 时 = min(expiresAt, 确认+120s)（D12：手机失联不陪跑整个 TTL） |
| 取回宽限 | 截止/取走后 30s（防 poll 响应丢失），期内同 claimKey 重取返回同 token |
| Web status 轮询 | 有活跃配对才轮询：弹窗开 1s / 关 5s，全终态即停（D13） |
| 手机 poll 轮询 | claim 后前 30s 每 1.5s，其后退避 5s（长 TTL 链接可能等数分钟确认） |
| 单账号活跃上限 | 3，create 静默淘汰最旧 |

## 5. 边界与失败路径

| 场景 | 行为 |
|---|---|
| 码过期未被 claim | 手机端 `410 E_PAIR_EXPIRED` → 提示 + Web 列表项「已过期 [重新生成]」 |
| claim 后无人确认至过期 | 同上；双方自然终结，无需取消接口 |
| 两设备抢扫/抢点 | 先到者得 claimKey；后到 `409 E_PAIR_CLAIMED`；Web 确认界面显示先到者 UA，主人可「拒绝」终结 |
| **持码者非 claim 者轮询** | poll 必须持 claimKey；抢扫失败者拿不到 token——确认环节的安全锚因此闭合 |
| poll 响应丢失 | 30s 宽限内同 claimKey 重取幂等返回；宽限后整条擦除 |
| Web 点「拒绝」 | 手机端 poll 得 `denied` → 显示「已被拒绝」；终态 |
| 发送端自己点开链接 | `/pair` 页是显式按钮，点开不烧码；即便真点了「登录」，拿到的也是自己已有 token（幂等无害） |
| 服务重启 | 内存全清，双端见过期；重新生成即可（无持久化 = 无脏状态） |
| 链接发错人/中途反悔 | 弹窗「撤销」→ cancelled：token/claimKey 立即清，手机端显示已被撤销（D11） |
| 确认后手机失联没来取 | 取件截止（确认+120s）后作废随 sweep 消失；Web 停「等待设备获取」不假报成功（D12/D14） |
| code 在线猜测 | 128 位 CSPRNG，10^3 次/秒穷举到宇宙热寂；故不做限流（与 ADR #14 威胁模型一致） |
| 多标签页同账号同时 create | 上限 3 + 淘汰最旧，无锁（单进程同步代码段内完成判定） |

## 6. 兼容、迁移与回滚

- **纯增量**：6 个新路由 + `/pair` 页 + 3 处 UI 入口；不改 `accounts.json`、不碰
  y-websocket/`useCollaboration`；旧客户端（含旧 APK）行为零变化。
- **发布**：server+Web 随 Gitea CI 推 main 自动部署；App 端「扫码登录」按钮等下一次
  GitHub release 出包；CHANGELOG 需写明「旧 APK 粘贴登录仍可用」。
  **顺序不变式**：新 UI（桌面/App 包）永远晚于新路由（server+Web 同 CI 先行）上线，
  天然无版本偏斜；反向（旧端 + 新服务端）多出的路由无人调用亦兼容。
  将来不得先发调用 `/auth/pair/*` 的桌面包。
- **回滚**：revert + 重启即回；无持久化数据需要清理，配对态随重启蒸发。

## 7. 可观测性与测试

**服务端日志**（console 一行/迁移，self-hosted 排障够用）：
`[pair] create/claim/confirm/consume kind=link code=Ab3xY9… account=zhang status=claimed`——
只打 code 前 6 位与账号名，**不打 token、不打完整 code**。

**e2e**（`e2e/tests/pairing.spec.ts`，双 browser context，走 `/pair` URL 路径不碰摄像头）：
- [ ] ctx1 打开头像菜单→登录新设备→生成链接并复制 URL；
- [ ] ctx2 打开该 URL：预览信息正确（账号名/有效期）→ 点「在此设备登录」；
- [ ] ctx1 出现待确认项 → 点确认 → ctx2 断言跳转后处于登录态（顶栏显示账号名）；
- [ ] 拒绝路径：ctx2 显示「已被拒绝」且未登录；
- [ ] 撤销路径：ctx1 生成后撤销 → ctx2 显示「已被撤销」且未登录；
- [ ] 双开路径：第二个 context 对同码 claim → 「已被使用」。

**convergence-smoke 扩展**（`server/convergence-smoke.mjs`）：
- [ ] create(qr)→info→claim→confirm(accept)→poll 拿到的 token 能过 `/auth/me` 且账号一致；
- [ ] 同码二次 claim → 409；随机码 claim → 410；confirm 非 owner → 409；
- [ ] cancel：pending/claimed 撤销后 poll 得 cancelled、再 claim 得 410。

**单元测试**（`server/pairing.test.js`，Node 内置 `node --test`，零新依赖；时间作参数注入
`pairing.js` 纯函数，时间性路径全自动化）：
- [ ] 状态机：合法迁移全表 + 非法迁移（重复 claim / 非 claimed 态 confirm / 终态再操作）→ 409；
- [ ] 过期：pending/claimed 跨 expiresAt → sweep 删除，claim/poll → 410；
- [ ] 取件截止与宽限：confirm 后 min(expiresAt, +120s) 生效、逾期作废；取走后 30s 内
  同 claimKey 幂等返回，宽限外 410；
- [ ] cancel：三态可撤、立即清 token、终态拒撤；
- [ ] 并发上限：第 4 个 create 静默淘汰最旧。

**手工清单**（时间逻辑已被单测覆盖，只留真实时钟全链路一条）：
- [ ] 发布前用真实服务器走一遍 5 分钟链接：到期前登录成功、到期后打开见过期。

## 8. 分期与工作量

v1（本设计全部，一次做完）：
- 服务端 `pairing.js` + 7 路由（含 cancel，~170 行）；
- `PairModal` + 头像菜单项 + 红点轮询（~250 行）；
- `Welcome` 扫码按钮 + App 内配对流程 + `/pair` 落地页 + 路由（~200 行）；
- `qr.ts` 加 `buildPairUrl`/`parsePairPayload` 并修 join 解析（~40 行）；
- `pairing.test.js` 单测（~60 行；`server/package.json` 加 `test` script 指向 `node --test`）；
- i18n zh/en 文案、e2e、smoke、CHANGELOG、本文档随代码更新。
- 估：2 天（含双端联调与手工清单）。

明确推迟（YAGNI）：
- 每设备独立 token / 设备列表 / 单设备吊销（需 `accounts.json` 迁移，等真实需求）；
- 配对时可选 token 轮换（换新值、旧 token 作废，清理疑似泄露；代价是踢掉所有其他端，需要时再论证）；
- 免确认快登模式（屏显码有偷拍窗口，已被否）；
- 邀请他人注册（不同问题：账号创建邀请，非登录态转移）;
- App Links 深链（维持 ADR #4 结论）；
- claim 限流。

## 9. 已定决策与被否方案

| # | 决定 | 理由 | 被否方案 / 否的理由 |
|---|---|---|---|
| D1 | 码内只放一次性配对码，不放 token | token 是永久凭据，进码即随截图/拍照泄露 | — |
| D2 | **两种方式都须网页端确认**（用户拍板，较推荐更严） | 屏显码有偷拍窗口；链接可能被转发；确认是唯一人工信任锚 | 免确认纯短时效码：扫码即得 token，最顺但 120s 内抢扫即失守 |
| D3 | 转发现有 token，服务端内存中转 | 服务端只存哈希没有明文可发；token 本就随每个 Bearer 请求过服务器，不新增可见面 | ①端到端加密中转（Web 用配对码加密，服务器只见密文）：多一套 WebCrypto，收益≈0；②独立设备 token：动 accounts.json 结构，为吊销铺路过早 |
| D4 | claim 签发 claimKey，poll 凭 code+claimKey | 否则抢扫失败者持 code 轮询，approved 后照样偷走 token，确认锚失效 | poll 仅凭 code（简单但漏） |
| D5 | 确认窗口 = claim 后至 expiresAt（统一规则） | QR 的 TTL=2min 自然收紧；长档链接可「早点开、晚确认」，与 D2 共存 | 固定 120s 确认窗：长 TTL 档名存实亡 |
| D6 | QR 与链接是同一 URL 的两种形态 | 一套载荷/解析/落地页；`buildPairUrl`/`parsePairPayload` 复用 | 分开两套 URL 格式：无收益纯复杂度 |
| D7 | 严格一次性 + 409 | 转发到群的链接不会扩散登录态 | TTL 内可多用：方便多设备，但=批量身份泄露，与「不泄露」初衷相悖 |
| D8 | 落地页显式按钮才 claim | 手滑打开不烧码；发送端自己点开也无害 | 打开即自动 claim 登录：误触消耗一次性码，App 再扫报「已使用」莫名 |
| D9 | 弹窗可关，红点召回 | 链接分钟级 TTL 下，确认可能几分钟后才发生，必须有处可回 | 关弹窗即作废：与长 TTL 使用节奏相悖 |
| D10 | 配对态纯内存、重启即失 | 秒~分钟级瞬态不值得持久化；无脏状态 | 写 accounts.json / SQLite：纯增复杂度 |
| D11 | 活跃配对可由 owner 随时撤销（cancel 接口） | 60 分钟档链接发错群/反悔，现状最长裸奔一小时；撤销立即清 token | 只能等 TTL 或等 claim 后再拒绝：救济缺位 |
| D12 | 确认即写取件截止 min(expiresAt, 确认+120s) | 手机失联时明文 token 内存驻留从整个 TTL 压到 ≤2 分钟（+30s 宽限） | 驻留到 TTL：无谓放大泄漏面 |
| D13 | 轮询条件化+退避（Home 有活跃才轮询：开 1s/关 5s；手机 30s 后 1.5s→5s） | 红点不该是常驻 1s 后台请求；链接场景手机可能空等数分钟（~2400 次/小时 → ~700） | 恒定高频轮询：纯浪费 |
| D14 | approved ≠ 成功：consumed 才显示「✓ 已登录」；status 返回含终态的未清扫全量（否则弹窗永远等不到 ✓） | 手机断网没取到时 Web 假报成功是可见的坑 | approved 即 ✓：状态说谎；status 只回非终态：终态对 UI 不可见 |
| D15 | poll 用 POST + 全部 pair 路由 `Cache-Control: no-store` | 含 token 的响应绝不可被中间盒/浏览器缓存；claimKey 不进 URL/代理日志 | GET+query：延续 WS `?token=` 的旧例，且把 token 响应暴露给缓存 |

## 10. 遗留问题

无未决项。三个「实现时留意」级别的备注：
1. `parseJoinPayload` 的修复（排除 `/pair` 路径）必须与 pair 解析**同 PR** 落地，
   否则 App 扫 pair 码会被当房间码误进房；
2. `status` 轮询挂 `Home`（红点依赖），但**有活跃配对才启动**、全终态即停（D13）；卸载时清理 interval；
3. `confirm` 请求体携带 token，确保该请求不进任何日志（现有层无 body 日志，保持）。

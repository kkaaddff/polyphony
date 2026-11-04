# 架构设计

## 总体拓扑

三端客户端共享一套 React 代码（`client/src/`），全部通过**运行时解析**的服务器地址连到独立 Node 服务。
任何一端都能直连 `http://IP:PORT`，也能走生产 nginx 同源反代。

```text
+----------------------+  +----------------------+  +----------------------+
| Desktop (Tauri 2)    |  | Android (Tauri 2)    |  | Web (Vite dist)      |
| mac dmg  aarch64     |  | arm64-v8a apk (v1)   |  | any browser          |
| win nsis  x64        |  | barcode-scan plugin  |  | jsQR + getUserMedia  |
| linux deb (x64)      |  | jsQR camera fallback |  | camera qr fallback   |
| tray + offline idb   |  | cleartext ws allowed |  | same-origin ws       |
+-----------|----------+  +-----------|----------+  +-----------|----------+
            |                         |                         |
            +-------------------------+-------------------------+
                                      | ws (subprotocol auth) + http (Bearer)
                                      v
+---------------------------------------------------------+
| Node service   server/index.js                          |
| express + ws + y-websocket relay (Yjs docs + awareness) |
| SQLite data/polyphony.db (accounts/docs/memberships)    |
| /auth/* /pair/* /docs/* /rooms/* /uploads (multer)      |
| STATIC_DIR static hosting + SPA fallback (same origin)  |
| dev :3001   |   docker all-in-one :9091         |
+-------------------------------------|-------------------+
                                      |
                                      | docker compose up -d --build
                                      v
+-----------------------------------------------+
| Production host (any docker host)             |
| container: polyphony  (web static + ws :9091) |
| volumes: polyphony-data (db) polyphony-uploads|
| optional: nginx TLS reverse proxy in front    |
+-----------------------------------------------+
```

（框内标签为纯 ASCII 保证任意等宽字体对齐；中文说明一律写在代码块外。）

## 分层与目录

```
client/                     # 唯一的前端工程（三端共享）
├── src/
│   ├── pages/             # Welcome / Home / Join / Pair / Editor / Settings（React Router）
│   ├── components/        # RoomHeader / UsersPanel / QrModal / ScanModal / PairModal / TrashModal / editorConfig
│   ├── lib/               # useCollaboration / auth / pairing / docs / intake / imagePrep / clipboard / serverConfig / storage / qr
│   ├── platform/          # ★ Tauri 与 Web 差异的唯一收口：isTauri / platformInfo / scanQr / tray
│   └── types/
├── src-tauri/             # Tauri 2 shell（Rust；gen/ 生成物不入库）
└── scripts/android-patch.mjs  # 生成后的 Android 清单补丁（cleartext + CAMERA + INTERNET）
server/                     # 独立 Node 服务（node:sqlite，零原生依赖）
├── index.js               # 装配：路由挂载 + WS(子协议鉴权) + 静态托管 + SIGTERM 落盘
├── db.js                  # SQLite 单例（WAL、外键、withTx savepoint 嵌套）
├── auth.js / pairing.js   # 身份域：账号/设备/恢复密钥；配对 v2 状态机
├── docStore.js            # 文档域：生命周期 + 快照持久化(bindState/防抖落盘)
├── attachments.js / exporter.js  # 附件登记与引用回收；导出 zip
├── rooms.js               # 房间簿（memberships ⨝ docs，/rooms）
├── sweeper.js             # 统一清理调度（设备/文档/附件，每小时）
├── resetV3.js             # v3 残留归档（首启 _v3-archive-*）
├── routes/                # auth / pair / docs / attachments 四组 Express 路由
└── *.test.js + convergence-smoke.mjs  # 单测(44) + 收敛冒烟
e2e/                        # Playwright UI 回归（仅本地，绝不进 CI）
.gitea/workflows/           # server+Web 一体机构建部署（自建 runner；端产物归 GitHub）
```

## 子系统设计

### 1. 运行时服务器配置（直连的核心）— `client/src/lib/serverConfig.ts`

服务器地址**绝不在构建期内联**，取值优先级：

```
?server= URL 参数（扫码进入）
  > 本机已保存配置（localStorage / Tauri store）
    > VITE_SERVER_URL（仅 dev，client/.env.local = http://localhost:3001）
      > 同源 location.origin（Web 生产兜底）
```

- `getServerBase()` 是唯一出口，`useCollaboration`、图片上传、`/health` 拉取三处调用零分歧。
- Settings 页：地址输入 + 测试连接（GET `/health`，显示延迟/文档数/在线数）+ 保存/清除。
- 设计动机：v2 时代构建期内联地址导致"换服务器必须重构建"；v3 手机扫码带 `server` 参数即可直连任意部署。

### 2. 身份与登录（v4，详见 [identity-and-sharing.md](identity-and-sharing.md)）

- **每设备独立凭据** `poly_d_<uuid>_<48hex>`：secret 由设备本地生成，服务端只存 sha256、从不下发；HTTP 走 `authFetch`（Bearer），WS 走子协议头 `["polyphony.v1", "auth.<token>"]`（不进 URL/代理日志）。
- **恢复密钥** `poly_r_…` 服务端生成、注册时只显示一次、可重生成；用于在新设备兑换本机凭据。账号注销有 30 天宽限（可用恢复密钥找回）。
- **配对 v2 双向**：push（已登录端出 QR/链接，新设备认领）+ pull（新设备出本机码，已登录端扫开 `/pair` 批准）；设备标签由服务端按平台枚举 + UA 组合，无自由文本（防钓鱼锚点）。
- **Welcome 三入口**：新建账号 / 已有账号配对 / 恢复密钥；无凭据的任何路由重定向到 `/welcome?next=`。

### 3. 文档生命周期（v4，详见 [document-lifecycle.md](document-lifecycle.md)）

- 文档码服务端生成（8 位 [A-Z0-9]，tombstone 去重）；**显式创建**，不再"进房即建"。
- 状态机 active → trashed（30 天）→ purged；owner 删除 / 1 年不活跃 / 账号注销三路进回收站；回收站可恢复、可立即清除、可导出。
- 快照持久化：`bindState` 同步读（首客户端不闪空文档）、2s 防抖落盘、最后一个客户端断开时写盘并卸载（内存不泄漏）、SIGTERM 全量刷盘。
- 附件按文档目录存放（`uploads/<码>/`），上传前客户端重编码（EXIF/GPS 剥离、长边 ≤2560px），服务端按文档内引用计数回收（30 天无引用回收、清除时无条件删除）。

### 4. 扫码与粘贴入口（QR 双向 + 粘贴兜底）

- **载荷是 Web URL**：`<server>/join?code=<文档码>&server=<直连地址>` 与 `<server>/pair?code=<配对码>&server=`。任何手机系统相机扫都进 Web 版（兜底），App 内扫则解析参数直连。
- 生成：`lib/qr.ts`（qrcode npm 包 canvas 渲染）；编辑器顶栏、首页文档列表、配对弹窗、欢迎页本机码均可出码。
- 消费：`lib/intake.ts` 统一解析（裸 8 位码 / join URL / pair URL / 服务器地址），`/join`、`/pair` 路由分流。
- 扫码实现按平台分支（`platform/scanQr.ts`）：Android 用 `@tauri-apps/plugin-barcode-scanner`（原生），其余平台 jsQR + getUserMedia；**无摄像头（http 直连等）自动切粘贴表单**，不再只报错。
- v1 不配深链（官方 deep-link 插件不支持自定义 scheme，App Links 需域名 + assetlinks；扫码流程不依赖它）。

### 5. 平台抽象层 — `client/src/platform/`

**规则：页面/组件禁止直接 import `@tauri-apps/*`**，一律走 platform 收口：

- `index.ts`：`isTauri()`（UA 探测）、`isDesktopTauri()`（Tauri 且非移动 UA——托盘等桌面能力的前置判断）、`platformInfo()`（client: app|web + os 枚举，配对设备标签的服务端原料）。
- `scanQr.ts`：扫码统一接口，内部按平台选原生插件 / jsQR。
- `tray.ts`：托盘菜单（最近 5 房间 + 新建 + 显示/退出），数据与 UI 共用 `lib/storage.ts` 的最近房间。

### 6. Tauri 2 shell — `client/src-tauri/`

- **`#[cfg(desktop)]` 门控是铁律**：`tauri::menu` / `tauri::tray` / `WebviewWindow::unminimize` 都是桌面-only API，不门控则 Android 目标编译失败（E0432/E0599，实踩过）。tauri-build 会在编译时设置 desktop/mobile cfg 别名。
- `gen/`（android 工程与 schemas）永不入库，由 `android:init`（本地）或 `tauri android init`（CI）生成；`scripts/android-patch.mjs` 随后给清单加 `usesCleartextTraffic="true"` + CAMERA + INTERNET。
- Android 明文 ws 是有意为之（v1 直连全为无证书 `ws://IP:PORT`），仅限内网/受信场景。
- iOS 只预留（`Info.plist` ATS 注意事项见 README），不出包。

### 7. 离线缓存 — y-indexeddb

`useCollaboration` 内一行接入：`new IndexeddbPersistence(\`polyphony-room-${roomCode}\`, doc)`。

- 断网可编辑，重连后 CRDT 自动合并（Yjs 强项）。
- 隐私模式等 IndexedDB 不可用场景 try/catch 静默跳过，不影响在线协同。
- 已知边界：同浏览器双标签进同一房间时共享该库（BroadcastChannel 联动），会放大 awareness 归属问题，见 [collaboration.md](collaboration.md#已知边界)。

### 8. 服务端 — `server/`

Node 服务，模块按域拆分（v4）：

- **WS 中继**：`ws` WebSocketServer + `setPersistence`（y-websocket），文档码即 pathname；连接先过双重门——子协议 `auth.<token>` 校验（失败 close 4001）+ 文档存在性/状态检查（purged/不存在 4004、回收站 4010）。凭据吊销即时断开（`closeDeviceWs`）。
- **HTTP 路由**（`routes/`）：`/auth/*`（账号/设备/恢复密钥/注销）+ `/auth/pair/*`（配对 v2 状态机）+ `/docs/*`（创建/状态/删除/恢复/清除/导出令牌）+ `/rooms`（房间簿，响应附 `pendingPairings` 红点数）+ `/docs/:code/attachments`（multer，按文档目录落盘）+ `/uploads/:code/:file`（免鉴权读，128 位熵 + 文档必须 active）。
- **存储**：`db.js` 单文件 SQLite（`node:sqlite`，WAL + 外键 + savepoint 嵌套事务），六表 accounts/devices/docs/memberships/attachments/doc_refs；文档快照是 `docs.state` BLOB。
- **持久化**：`docStore.js` 快照防抖写盘 + 最后断开卸载 + SIGTERM 全量刷盘；**服务重启不再清空文档**。
- **清理调度**：`sweeper.js` 每小时统一跑三把扫帚（180 天不上线设备、1 年不活跃文档 + 30 天回收站 + 注销宽限到期、30 天无引用附件）。
- **v3 归档**：`resetV3.js` 首启把 v3 的 `accounts.json` / 平铺 `uploads/` 改名进 `_v3-archive-<时间戳>/`（同卷 rename，零拷贝）。
- **健康检查**：`GET /health` 只回数量（在线房间数/在线人数/文档数/附件字节），**不含任何文档码**。
- **静态托管**：`STATIC_DIR` 环境变量指定前端产物目录（存在才启用），含 SPA fallback。同端口同源的意义：适配 fnos 等随机四级域名反代场景，Web 端 `location.origin` 兜底天然成立。
- **CORS 全开**：直连 IP 的客户端跨源访问必需（内网/受信前提）。

## 数据流小结

- 文档内容：`Y.Doc` 的 `document` Y.Text；本地编辑经 diff（`diffText`）转 CRDT 增删，事务 origin = userId。
- 文档名：`meta` Y.Map 的 `roomName`，一人改名全员 observe 生效；**服务端落盘时从 meta 同步到 `docs.name`**（单一事实来源，房间簿/回收站/导出文件名共用）。
- 在线状态：y-websocket awareness（`user: {id, name, color}`），详见 [collaboration.md](collaboration.md)。
- 图片：编辑器先在**客户端重编码**（`lib/imagePrep.ts`，EXIF/GPS 剥离 + 长边 ≤2560px）→ 上传到 `/docs/<码>/attachments` → 返回 `/uploads/<码>/<32hex>.<ext>` 相对 URL 存进文档 → 预览时按当前服务器地址补全（多地址访问不裂图）。

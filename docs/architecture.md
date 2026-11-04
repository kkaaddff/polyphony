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
                                      | ws + http  (y-websocket CRDT relay)
                                      v
+---------------------------------------------------------+
| Node service   server/index.js                          |
| express + ws + y-websocket relay (Yjs docs + awareness) |
| POST /upload multer <=5MB   GET /health room stats      |
| STATIC_DIR static hosting + SPA fallback (same origin)  |
| dev :3001   |   docker all-in-one :9091         |
+-------------------------------------|-------------------+
                                      |
                                      | docker compose up -d --build
                                      v
+-----------------------------------------------+
| Production host (any docker host)             |
| container: polyphony  (web static + ws :9091) |
| optional: nginx TLS reverse proxy in front    |
+-----------------------------------------------+
```

（框内标签为纯 ASCII 保证任意等宽字体对齐；中文说明一律写在代码块外。）

## 分层与目录

```
client/                     # 唯一的前端工程（三端共享）
├── src/
│   ├── pages/             # Home / Join / Editor / Settings（React Router）
│   ├── components/        # RoomHeader / UsersPanel / QrModal / ScanModal / editorConfig
│   ├── lib/               # useCollaboration / serverConfig / storage / qr / roomCode / fixTableCopy
│   ├── platform/          # ★ Tauri 与 Web 差异的唯一收口：isTauri / isDesktopTauri / scanQr / tray
│   └── types/
├── src-tauri/             # Tauri 2 shell（Rust；gen/ 生成物不入库）
└── scripts/android-patch.mjs  # 生成后的 Android 清单补丁（cleartext + CAMERA + INTERNET）
server/                     # 独立 Node 服务（零框架依赖升级压力）
├── index.js               # express + ws + y-websocket + multer + STATIC_DIR 静态托管
└── convergence-smoke.mjs  # 收敛冒烟脚本
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
- Settings 页：地址输入 + 测试连接（GET `/health`，显示延迟/房间数/在线数）+ 保存/清除。
- 设计动机：v2 时代构建期内联地址导致"换服务器必须重构建"；v3 手机扫码带 `server` 参数即可直连任意部署。

### 2. 扫码进房（QR 双向）

- **载荷是 Web URL**：`<server>/join?code=<房间码>&server=<直连地址>`。任何手机系统相机扫都进 Web 版（兜底），App 内扫则解析参数直连。
- 生成：`lib/qr.ts`（qrcode npm 包 canvas 渲染）；编辑器顶栏与首页房间列表均可出码。
- 消费：`/join` 路由分流——已有用户名 → 固化 server 配置直进 `/editor?code=`；无用户名 → 回首页 `?join=` 预填；无 code → 回首页。
- 扫码实现按平台分支（`platform/scanQr.ts`）：Android 用 `@tauri-apps/plugin-barcode-scanner`（原生），其余平台 jsQR + getUserMedia（Web 摄像头）。
- v1 不配深链（官方 deep-link 插件不支持自定义 scheme，App Links 需域名 + assetlinks；扫码流程不依赖它）。

### 3. 平台抽象层 — `client/src/platform/`

**规则：页面/组件禁止直接 import `@tauri-apps/*`**，一律走 platform 收口：

- `index.ts`：`isTauri()`（UA 探测）、`isDesktopTauri()`（Tauri 且非移动 UA——托盘等桌面能力的前置判断）。
- `scanQr.ts`：扫码统一接口，内部按平台选原生插件 / jsQR。
- `tray.ts`：托盘菜单（最近 5 房间 + 新建 + 显示/退出），数据与 UI 共用 `lib/storage.ts` 的最近房间。

### 4. Tauri 2 shell — `client/src-tauri/`

- **`#[cfg(desktop)]` 门控是铁律**：`tauri::menu` / `tauri::tray` / `WebviewWindow::unminimize` 都是桌面-only API，不门控则 Android 目标编译失败（E0432/E0599，实踩过）。tauri-build 会在编译时设置 desktop/mobile cfg 别名。
- `gen/`（android 工程与 schemas）永不入库，由 `android:init`（本地）或 `tauri android init`（CI）生成；`scripts/android-patch.mjs` 随后给清单加 `usesCleartextTraffic="true"` + CAMERA + INTERNET。
- Android 明文 ws 是有意为之（v1 直连全为无证书 `ws://IP:PORT`），仅限内网/受信场景。
- iOS 只预留（`Info.plist` ATS 注意事项见 README），不出包。

### 5. 离线缓存 — y-indexeddb

`useCollaboration` 内一行接入：`new IndexeddbPersistence(\`polyphony-room-${roomCode}\`, doc)`。

- 断网可编辑，重连后 CRDT 自动合并（Yjs 强项）。
- 隐私模式等 IndexedDB 不可用场景 try/catch 静默跳过，不影响在线协同。
- 已知边界：同浏览器双标签进同一房间时共享该库（BroadcastChannel 联动），会放大 awareness 归属问题，见 [collaboration.md](collaboration.md#已知边界)。

### 6. 服务端 — `server/index.js`

单文件 Node 服务，职责刻意收敛：

- **WS 中继**：`ws` WebSocketServer + `setupWSConnection`（y-websocket），房间码即 URL pathname（`/ws/<room>` 经 nginx 剥前缀后到后端就是 `/<room>`）。
- **图片上传**：`POST /upload`（multer 磁盘存储，仅图片类型，≤5MB），存 `server/uploads/`，`/uploads/` 静态托管。
- **健康检查**：`GET /health` 返回房间数/在线数/每房人数（`roomStats` Map 维护，靠 ws 连接事件增减），首页在线房间列表与 Settings 测试连接共用。
- **静态托管**：`STATIC_DIR` 环境变量指定前端产物目录（存在才启用），含 SPA fallback（先试 `<route>.html` 再回 `index.html`，与 nginx `try_files` 语义对齐）。同端口同源的意义：适配 fnos 等随机四级域名反代场景，Web 端 `location.origin` 兜底天然成立。
- **CORS 全开**：直连 IP 的客户端跨源访问必需（内网/受信前提）。

## 数据流小结

- 文档内容：`Y.Doc` 的 `document` Y.Text；本地编辑经 diff（`diffText`）转 CRDT 增删，事务 origin = userId。
- 房间名：`meta` Y.Map 的 `roomName`，一人改名全员 observe 生效。
- 在线状态：y-websocket awareness（`user: {id, name, color}`），详见 [collaboration.md](collaboration.md)。
- 图片：编辑器上传到 `/upload` → 返回 `/uploads/<file>` 相对 URL → 存进文档。

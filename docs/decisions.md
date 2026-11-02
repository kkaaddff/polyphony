# 决策记录与坑清单

## ADR 简表（为什么是现在这个样子）

| # | 决策 | 理由 / 放弃的方案 |
|---|---|---|
| 1 | 一套 React 代码出三端（Web + Tauri 桌面 + Tauri Android） | 上一版 Next.js 静态导出只有 Web；CS 直连 + 扫码需要原生壳。放弃 Electron（重、Linux 打包痛苦）与 RN（编辑器组件生态不匹配 MDXEditor） |
| 2 | 服务端零改动保留 express + y-websocket | 它本就是独立 CS 里的 S，监听 0.0.0.0 天然可直连；换 `@y/websocket-server` 留作 awareness 修复的备选 |
| 3 | 服务器地址运行时解析（`?server=` > saved > dev env > 同源） | v2 构建期内联地址 = 换服务器必须重构建；扫码带参即可直连任意部署 |
| 4 | QR 载荷 = Web URL（`/join?code=&server=`） | 任何手机系统相机都能兜底进 Web 版；深链 v1 不做（官方插件不支持自定义 scheme，App Links 要域名） |
| 5 | 出包全在 GitHub Actions，本机不装 Rust/JDK | 本地只需 `tsc`/`eslint`/`vite build` + 冒烟；CI runner 路径天然 ASCII，绕开 em-dash 坑 |
| 6 | Android 只出 arm64-v8a 单 apk（不拆 abi、不出 aab） | 用户拍板：只兼容最新 Android 设备；debug 签名可直接装机 |
| 7 | 不出 Intel mac dmg | 用户拍板：只要 Apple Silicon |
| 8 | 手动触发 CI 也创建 Release（v+版本号，非 draft） | 用户要求"触发即出全套可取回"；重复触发 `--clobber` 覆盖同名附件 |
| 9 | CRDT（Yjs）而非 OT/Socket.IO | 离线可编辑、重连自动合并、服务端零语义只中继；与 v2 一致平滑迁移 |
| 10 | e2e 只在本地，绝不进 CI | 依赖本机 Chrome/真实端口/系统剪贴板，CI 慢且不稳；CI 定位是"只出包" |
| 11 | 托盘/菜单代码 `#[cfg(desktop)]` 门控 | 这些 API 桌面-only，不门控 android 目标编译失败（实踩 E0432/E0599） |
| 12 | Tauri 差异全部收口 `client/src/platform/` | 页面/组件禁止直接 import `@tauri-apps/*`，保证 Web 构建不被原生依赖污染 |
| 13 | 部署内化 `deploy/` + `npm run deploy` | tar over ssh（不依赖远端 rsync）+ nginx conf 版本化进仓库 + PM2 单进程（v3.1 起被 #18 取代，脚本删除、git 历史留档） |
| 14 | CORS 全开、房间码即凭据、明文 ws | 内网/受信场景的产品定位；公网使用需自行 TLS 反代（如实文档化，不做假安全） |
| 15 | 项目更名 coordination-v2 → **Polyphony/复调**（v3.1.0） | 巴赫复调：多独立声部无指挥收敛为一份总谱 = CRDT 语义；品牌/包名/identifier/存储键全量更名 |
| 16 | 双仓流：私有 Gitea 开发主仓 + GitHub 发布仓 | dev push 即 CI 部署（含内部拓扑不外泄）；GitHub 只收 tag/release 面向公众；Gitea push mirror 自动灾备到 GitHub 私有镜像仓 |
| 17 | 存储键 `coordination.*` → `polyphony.*` 不做迁移 | 个人产品、成本大于收益；升级后重填用户名/服务器即可；已记入 CHANGELOG 升级说明 |
| 18 | 自托管统一 Docker all-in-one（退役 PM2+OpenResty 链路） | 单容器=全功能、可复现、换机零成本；Yjs 房间态本就在内存（客户端 IndexedDB 兜底），容器化不引入新数据风险；上传图片进具名卷 |
| 19 | Gitea CI：纯文档推送不部署 + 验证失败自动回滚 | README 错字不该踢在线用户下线；health+收敛冒烟双验证挡住坏构建；镜像按 git SHA 版本化 |
| 20 | `.github/workflows` 加 `vars.DEPLOY_ENV == 'github'` 守卫 | Gitea 会同时读取 `.github/workflows/`，无守卫则推 tag 在自建 runner 上跑端产物流水线（ubuntu-latest 标签无人认领，永远排队）。`server_url` 守卫不可靠：Gitea 的 DEFAULT_ACTIONS_URL 常默认 github.com；仓库变量只在 GitHub 仓配置，确定性生效 |
| 21 | 公开文档不出现内网 IP/域名/路径 | 仓库公开于 GitHub，运维细节只留在私有 Gitea；git 历史不重写（无密钥，仅旧拓扑，接受残留） |
| 22 | i18n 自研轻量方案（v3.2.0），不用 react-i18next | 仅 zh/en 两种、~90 条文案：zh.ts 完本类型 + en.ts `satisfies` 同构校验 + `useT()` 复用 storage.ts 的 useSyncExternalStore/跨标签页订阅，零依赖零包体积；标准库 ~40KB gzip 与双套心智模型不值。相对时间直接用 `Intl.RelativeTimeFormat`。服务端错误走稳定码（`E_FILE_TYPE` 等）客户端本地化，`error` 字段保留兼容旧客户端 |
| 23 | 协同错误在 hook 内置稳定码、渲染层翻译 | `useT` 若进 useCollaboration 的事件闭包，locale 变化会重建 provider（全员断线）；稳定码（`ERR_COLLAB_CONNECT`）+ Editor 映射使文案随语言即时切换而连接不动 |
| 24 | 账号体系（v3.3.0）：web 独占创建 + token 一次性展示 + 全端粘贴登录，WS/上传**硬切**强制鉴权 | token 明文仅创建响应出现一次（服务端 sha256(salt+token) 哈希 + timingSafeEqual，accounts.json 原子写挂 `polyphony-data` 卷）；「仅 Web 创建」= 服务端按 Origin 拦 Tauri 形态（`tauri://`、`tauri.localhost`），同源/跨源 dev/无 Origin 工具放行；硬切旧端断连，随 v3.3.0 全套安装包同步发布。双凭据模型：token=身份、房间码=准入 |
| 25 | 房间簿放服务端（账号→rooms），非本地「最近房间」 | 换设备/换端登录列表一致；退出（单个/批量）服务端生效；容量 50/号淘汰最旧。本地 recentRooms 仅作托盘与 IndexedDB 兼容保留 |
| 27 | 移动优先响应式 + 程序化布局断言(v3.4.0) | 真机审计驱动:vw=369 时双栏/固定宽侧栏/24px 图标全崩,「退出房间」被遮挡属交互级损坏。断言用程序化指标(溢出/裁切/触达)而非像素比对——免维护、防抖动;UI 测试双 project(desktop+Pixel 7),桌面用例零改动 |
| 26 | 房间名登记不加防抖 | 实踩：改名后 <500ms 退出编辑器，防抖定时器被卸载取消，服务端房间名丢失；改名本身离散触发，两次 POST 成本可忽略 |
| 28 | Android 固定 debug 签名（v3.4.1）：keystore 存 GitHub secret，CI 构建前恢复到 `~/.android/debug.keystore` | 实踩：GitHub runner 每次现生成一次性 debug keystore，APK 签名互不匹配，每次发版只能卸载重装。PKCS12 用 openssl 本地生成（alias `androiddebugkey`/口令 `android`，JDK9+ 的 JKS 加载器自动识别），base64 进 secret `ANDROID_DEBUG_KEYSTORE_BASE64`；本地备份 `secrets/android-debug.keystore`（gitignored）。放弃提交进仓库：GitHub 仓公开，签名材料不可入库 |
| 29 | 顶部安全区：`viewport-fit=cover` + 页面根 `pt-[env(safe-area-inset-top)] box-border`（v3.4.1） | targetSdk≥35 强制 edge-to-edge，WebView 延伸进状态栏压住顶栏。按页根加而非 `#root` 统一加：`box-border` 让 padding 计入 `h-screen`/`min-h-screen`，不产生整页滚动；桌面/测试浏览器 env()=0 零影响，e2e 断言不变 |
| 30 | UI 精简（v3.5.0，验收评审驱动）：品牌去中文（仅 UI 串/窗口/托盘）、首页设置收敛进头像菜单、编辑器顶栏收敛为「👥 n ▾」菜单 + 房间号点击复制（toast）、工具栏双行换行、在线用户底部面板、IME `interactive-widget=resizes-content` | localStorage 键/`polyphony:open-users` 事件名/仓库名不动（迁移成本）；软键盘走 Web 标准方案，manifest `adjustResize` 仅兜底且必须打在 `<activity>` 上（写 `<application>` 静默失效）；toast 手写不引依赖，`pointer-events-none` 不挡 e2e 点击 |

## 坑清单（按"再遇到怎么识别"组织）

### 构建/依赖

| 坑 | 症状 | 规避 |
|---|---|---|
| 本地 npm install 写回私有镜像 URL | `client/package-lock.json` 出现 `amh-group` 域 | **push 前必查** `rg -c amh-group client/package-lock.json`；e2e/ 已配 npmmirror `.npmrc` |
| rollup optional 平台原生包被裁剪 | 其它平台 `npm ci` 缺 `@rollup/*-gnu/msvc`（npm/cli#4828） | CI 用 `npm install`；升级 rollup 时 `optionalDependencies` 三项必须严格同步同版 |
| npmmirror 在海外 runner 不稳 | `npm ci` 中途崩且退出码 0 → 半残 node_modules | CI `NPM_CONFIG_REGISTRY` 覆盖回官方源 + `test -x node_modules/.bin/tsc` 兜底 |
| 本地路径 em-dash | 非 ASCII 路径下 Android Gradle 直接挂 | 本地 checkout 必须 ASCII（现 `polyphony`）；旧 PM2 链路的远端目录曾含 em-dash，凡遇此类路径引用必须双引号 |
| tauri-action 无 tagName 跳过上传 | 手动触发 Release 空 | 显式 upload-artifact 兜底 + `gh release create ... || true` + `--clobber` |
| gh CLI 不展开 glob | `**/*.apk` 传给 gh 报找不到 | `shopt -s globstar nullglob` |

### 协同（y-websocket）

| 坑 | 症状 | 规避 |
|---|---|---|
| destroy() 的 awareness 置空舞步 | 关页后其他端人数挂 ~30s | 卸载先 `provider.ws?.close()` 再 destroy（见 collaboration.md） |
| 同 context 双标签 awareness 归属错位 | 同上，且是上游语义 | e2e 双用户各开独立 context；单人双标签接受 30s 过期语义 |
| 交错插入拆散标记 | substring 断言假失败 | 冒烟按括号对计数断言 |
| e2e 共享房间码 | 并行 worker 人数互相串扰 | 每用例 `uniqRoom()` |
| `useLocalStorageState` 存 JSON | 裸读 localStorage 拿到带引号的 `"张三"` | 一律走 `storage.ts` 解析函数（getSavedUsername 等） |

### 运维/网络

| 坑 | 症状 | 规避 |
|---|---|---|
| nginx `/_next/static/` 遗留 | v3 的 `/assets/` 吃不到 immutable 缓存 | 下次部署改 `location /assets/`（不影响正确性） |
| fake-IP 代理到 GitHub 抖动 | git push SSH/HTTPS 失败、`gh api` EOF | GitHub 操作一律 `gh`（origin 已 HTTPS + gh 凭据）；EOF 多为网络抖动，隔秒重试，别急着查凭据 |
| 多 GitHub 实例并存 | 找不到本仓库 | 本仓库只在 github.com/kkaaddff；其它 GHE 实例与本仓库无关 |
| zsh `=word` 展开 | `echo ======` 报 `not found` | 分隔符加引号 |
| SSH 私钥进 CI | secret 泄漏面 | 只经 `env: SSH_KEY: ${{ secrets.SSH_PRIVATE_KEY }}` 间接引用，绝不写进 run 脚本 |

### 平台

| 坑 | 症状 | 规避 |
|---|---|---|
| 桌面-only Rust API | android 目标 E0432/E0599 | `#[cfg(desktop)]` 门控 tray/menu/unminimize |
| Android WebView 禁明文 | 直连 ws:// 被拒 | `android-patch.mjs` 加 `usesCleartextTraffic`（内网定位） |
| 非安全上下文无 clipboard API | http://IP 直连时复制崩 | `navigator.clipboard?.` 判空 + textarea/execCommand 降级 + 失败提示手码 |
| barcode-scanner 插件成熟度 | iOS scan 不返回、QR 配置 bug、16KB page size | Android 才用插件，其余 jsQR 兜底；iOS 不出包；16KB 合规未专项验证（上架前处理） |
| `src-tauri/gen/` 生成物 | 合入仓库即污染 | 不入库，`android:init`/CI 现场生成 |

## 后续路线（v2 候选）

- **服务端文档持久化（y-leveldb）**：容器重建时全关客户端的房间会清空（在线客户端从 IndexedDB 自动恢复）；`setupWSConnection` 接 persistence 即治本——改协同核心，按规矩全量冒烟后单独立项
- **/health 房间码暴露**：公开部署 `/health` 列出房间码与人数；可加 `HEALTH_DETAIL=0` 开关或反代屏蔽
- 修同 context awareness 归属（patch utils.js 或换 `@y/websocket-server`）
- Android 正式签名 + aab + 16KB page size 合规；iOS 出包评估
- mac 公证 / win 代码签名；自动更新（需签名与分发清单）
- 移动端 MDXEditor 软键盘/选区体验（不适配则降级只读/简易模式）
- 主包 1.3MB 可做 code-split

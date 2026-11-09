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
| 16 | 双仓流：私有 Gitea 开发主仓 + GitHub 发布仓 | dev push 即 CI 部署（含内部拓扑不外泄）；GitHub 只收 tag/release 面向公众。~~Gitea push mirror 自动灾备到 GitHub 私有镜像仓~~ 2026-11-04 用户拍板删掉镜像仓（polyphony-mirror，碍眼）：公开发布仓每次发版都收完整代码本身即有备份作用；Gitea 侧推送镜像配置需顺手关闭，否则每次 push 报同步失败 |
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
| 31 | App 壳去 web 化交互（v3.6.0）：双指/双击缩放**全端禁**（index.html 静态 meta 直接带 `maximum-scale=1 + user-scalable=no`，用户拍板「与 App 交互一致」优先于缩放无障碍；输入框聚焦自动放大随之消失）；全局 `overscroll-behavior:none` 禁下拉刷新与边缘发光、`-webkit-tap-highlight-color:transparent` 去点击灰闪、`touch-action:manipulation` 去双击延迟、`user-select:none` 禁 UI 铬件长按选中（`input/textarea/[contenteditable]` 重新放开，token 展示页 `select-all` 特异性更高不受影响） | WebView 把整套浏览器行为带进 App：双指缩放、误触下拉刷新重载打断协同编辑、按钮灰闪、长按 UI 出选择浮层——原生 App 均无此交互。曾考虑「仅 App 壳禁、Web 留缩放」的运行时分流，用户选择一致化后删繁就简走静态 meta。e2e ui-mobile 加计算样式基线守护 |

| 32 | 品牌图标定稿（v3.6.0）：「三声部辫」——靛蓝渐变（#4f46e5→#1e1b4b）squircle 上三条正弦带（白/天蓝/白）靠深色 halo 描边（150/98）做上下穿插；源 SVG + manifest 入库 `client/src-tauri/icons/source/`，`npx tauri icon` 生成全端套件；favicon 手工合成 48px PNG-in-ICO | 替换借用的 Tauri 默认图标。四稿评审（交织辫/合声圆/对位链/轮指波）选一：辫子直观表达「多声部交叠仍各成一线」；halo 分层是实现编织感的全部技巧（纯描边交叉糊成 X）。Android 自适应层：fg 缩 0.46 压幅 220 保证墨迹全落 66/108 安全区（~305px 半径），bg 满幅渐变，mono 全白给 13+ 主题图标。legacy 合成图经视觉模型复核（居中/边距 20%/满幅）。不出包平台的生成物（iOS AppIcon×16、MS Store Square/StoreLogo×10）与无引用的 64x64 裁出入库范围并 gitignore——`tauri icon` 每次全量再生成，不入库的不该出现在 status里。~~`tauri icon` 会生成 Android 自适应层~~ **实踩（v4.0.0 发布日）：`tauri icon` 只产 mipmap png，不生成 adaptive-icon 的 vector fg/层与 monochrome——CI 上 `tauri android init` 重新生成的 res 全是 Tauri 默认图标，`icons/android/` 那套自定义层必须由 `scripts/android-patch.mjs` 在 init 后整体拷进 `gen/.../res/`（含补 ic_launcher_round.xml），否则 apk 永远是默认图标** |
| 33 | macOS 签名+公证管线 secrets 门控接入（v3.6.0）：`APPLE_CERTIFICATE`(p12 base64)/`APPLE_CERTIFICATE_PASSWORD`/`APPLE_SIGNING_IDENTITY`(可推断省略)/`APPLE_API_KEY`+`APPLE_API_ISSUER`+`APPLE_API_KEY_B64`(公证) 六个 repo secrets 配齐自动生效，未配维持 adhoc 且 Release 正文自动附 `xattr -rd com.apple.quarantine` 解封说明（配了证书即自动消失，幂等） | adhoc+未公证 dmg 被浏览器打隔离标记后 Gatekeeper 一律报「已损坏」且新版 macOS 不给「仍要打开」入口，xattr 是唯一解——根治必须 Apple Developer Program（$99/年）出 Developer ID 证书走 notarytool。管线先行接入：~~secrets 为空时 tauri bundler 自动跳过~~ **实踩证伪（v4.0.0 发布日）**：secret 不存在时 env 展开为空串，tauri bundler 只要 `APPLE_CERTIFICATE` 键存在（var_os）就走 `security import` 直接失败（SecKeychainItemImport: Unable to decode the provided data；`APPLE_SIGNING_IDENTITY="-"` 也拦不住，import 先于 identity 判定）。最终修正：签名环境一律经前置 step 按 `HAS_CERT`（job 级 env 折叠的 secrets 布尔）写入 `$GITHUB_ENV`（heredoc 语法，值原样免转义），未配置时一个变量都不写 = bundler 默认 adhoc；另 step 的 `if` 禁用 `secrets` 上下文（违规=workflow 解析即败） |
| 34 | **v4 全新开始（不迁移历史数据）**：账号体系与文档生命周期整体重设计重实现（设计全文 [identity-and-sharing.md](identity-and-sharing.md) V1–V25、[document-lifecycle.md](document-lifecycle.md) L1–L26，二者已实现）。要点：每设备独立凭据（secret 本地生成、服务端只存哈希）+ 恢复密钥（一次性展示、可重生成）+ 配对 v2 双向 + 注销 30 天宽限；SQLite（`node:sqlite` 单文件）取代 accounts.json + 内存态，服务重启文档不丢；文档显式创建、owner/trash 30 天/purge 状态机、1 年不活跃回收；附件按文档目录 + 全局引用计数回收；客户端图片重编码（EXIF/GPS 剥离）；WS 凭据走子协议头；`/health` 只回数量。v3 数据首启归档 `_v3-archive-<ts>/` | 用户拍板「不管历史数据全部扔掉」（个人产品，迁移/兼容成本大于收益）；v3 的 token 全端粘贴是永久凭据跨设备流转，配对 v1（ADR #24 后补的 pairing-login.md）只解决单向且未上线即被推翻。推翻 ADR #24（web 独占创建 + token 粘贴）与 #25 的账号→rooms[] 存储形态（改 memberships 表，owner 行不可被 leave 挤掉）。**合并 v4→main 即生产切换时刻**（Gitea 自动部署会触发归档/清空生产数据），须与 `v4.0.0` tag 同步 |
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
| 服务端 Yjs 双实例（ESM `yjs.mjs` vs y-websocket 内 CJS `yjs.cjs`） | 文档卸载→从快照重载后，客户端新编辑被静默丢弃；快照里出现 GC 结构且永久"中毒"（之后基于它的插入都按 GC 集成） | 服务端一律 `import Y from './yjs.js'`（createRequire 取 CJS 单例）；`docStore.test.js` 有双实例回归 |
| MDXEditor `markdown` 属性只在挂载时读一次 | 首页桌面面板(DocPane)打开文档一片空白、他人输入不出现;在空白编辑器敲一个字,`applyLocalChange` 的 diff 会把全文删掉(对所有人生效) | 任何承载协同正文的 MDXEditor 都必须 `ref.setMarkdown` 写入远端内容(Editor.tsx / MobileDocView / DocPane 同一写法),onChange 忽略 initialNormalize 与 setMarkdown 回声;面板按文档码 `key` 重挂。e2e `home.spec.ts`「首页文档面板内容同步(回归)」 |
| 远端更新落在 setMarkdown 回声窗口内 | 对端快速连打时本端漏字、两端不收敛 | 远端更新一律写入编辑器，只用 `fromRemote` 标记屏蔽本地 onChange 回写 |

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
| Android WebView 软键盘（edge-to-edge） | `innerHeight`/`100dvh` 不变，键盘盖住工具栏/输入框 | 布局用 `viewport.ts` 写的 `--vvh`/`--vv-top`/`--kb-safe-bottom`（来自 visualViewport） |
| Android 根页返回调 `app.exit()` | 进程在析构阶段原生崩溃（`FORTIFY: pthread_mutex_lock called on a destroyed mutex`），MIUI 随后拉起顶层 Activity 再崩一次 → 用户看到「退出后再启动闪退一次」 | Tauri 2.12 的 exit = `finishAffinity` + tao `std::process::exit`，与 WebView 线程竞争静态析构；根页返回改调自有命令 `move_task_to_back`（JNI `moveTaskToBack(true)`，与 Android 12+ 系统默认一致），capability 不再授 `core:app:allow-exit` |
| 软键盘收起后焦点仍留在输入框/正文 | 返回手势被输入法吃掉收键盘后页面仍是编辑态,编辑中退到后台要划 4 次 | `viewport.ts` 在触屏设备键盘由开到合时 blur 当前可编辑元素(编辑态随焦点结束) |
| adb 无人值守测返回手势 | 后台放置 ≥2 分钟后首个注入手势「失效」 | 屏幕已进入变暗态,首个 ACTION_DOWN 被 MIUI 用来亮屏(日志 `set display0 dim state 0`);`KEYCODE_WAKEUP` 不解除变暗。测试先点一下非交互区域再划,勿误判为应用问题 |
| Android edge-to-edge(沉浸式) | WebView 画进状态栏/手势条下,页面、弹层、遮罩各自垫 `env(safe-area-inset-*)`,漏一处就顶进状态栏 | 模板 `enableEdgeToEdge()` + targetSdk 35+ 强制、SDK 36 起主题 opt-out 失效;`android-patch.mjs` 给 MainActivity 打 `applySystemBarPadding`:系统栏 inset 作内容区 padding 吃掉(WebView 的 safe-area 归零),状态栏区白底深色图标 |
| 离线冷启动身份 | `/auth/me` 失败 → 账号 null:顶栏「匿名用户」、列表空、文档打不开 | `useAccount`/首页用上次在线的账号与房间簿快照(`polyphony.account`/`polyphony.roomsCache`,绑定设备凭据 deviceId,换号不串);只有 401/403 才清,网络失败保留;退出登录一并清 |
| 离线打不开文档 | 服务器 IP 不可达(换网/宕机)时点文档没反应或要等很久;只有长条黄色提示,没有明确状态 | 根因:打开前 `await getDocStatus` 且 fetch 无超时——连接被黑洞时挂几十秒到数分钟(连接被拒时才秒败,本地停服复现不出来)。现在 `authFetch` 默认 8s 超时;`enterRoom` 先打开面板(IndexedDB 出内容),状态查询放后台,missing/trashed 与 WS 4004/4010 共用 `closeUnavailable` 去重;连通性收敛到 `lib/connectivity.ts`(HTTP 成败 + WS + online/offline 事件,离线时 5s 探测 `/health`),各端只显示 `OfflineTag`。测「不可达」用 e2e `simulateOutage`(请求挂起不回),别用 `route.abort` |
| 带名创建的文档打开后列表名变空 | `POST /docs {name}` 建的文档,一打开(活文档进内存)列表就显示「未命名」 | meta 里从没设过 `roomName` 时 `liveDocName` 返回 null 回落 `docs.name`,落库用 `COALESCE` 不拿空串覆盖;只有显式改名(含改成空)才以 meta 为准 |
| Dockerfile 逐个列服务端文件 | 新增模块(4.0.1 的 `server/yjs.js`)没进镜像,容器启动即 `ERR_MODULE_NOT_FOUND`;本地 dev/单测/e2e 全绿也发现不了 | `COPY server/*.js`(单测由 `.dockerignore` 排除);发版前可在 fnos 上以独立镜像名 + 数据副本预检(health + 容器内冒烟) |
| CI 换容器撞名 / 回滚点取错 | `container name "/polyphony" is already in use`(旧容器由手动回滚的另一 compose 项目起);回滚点在构建后 tag latest,实际是新版本自己 | 换容器前 `docker stop -t 15 polyphony && docker rm`;回滚点在构建前取 `docker inspect -f '{{.Image}}' polyphony` |
| 真机长按后不派发 click | 长按多选后，下一次正常点击被吞 | 抑制 click 的标记在每次 pointerdown 时清零；e2e 有「松手后无 click」用例 |

## 后续路线（v2 候选）

- **服务端文档持久化（y-leveldb）**：容器重建时全关客户端的房间会清空（在线客户端从 IndexedDB 自动恢复）；`setupWSConnection` 接 persistence 即治本——改协同核心，按规矩全量冒烟后单独立项
- **/health 房间码暴露**：公开部署 `/health` 列出房间码与人数；可加 `HEALTH_DETAIL=0` 开关或反代屏蔽
- 修同 context awareness 归属（patch utils.js 或换 `@y/websocket-server`）
- Android 正式签名 + aab + 16KB page size 合规；iOS 出包评估
- mac 公证 / win 代码签名；自动更新（需签名与分发清单）
- 移动端 MDXEditor 软键盘/选区体验（不适配则降级只读/简易模式）
- 主包 1.3MB 可做 code-split

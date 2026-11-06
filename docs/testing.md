# 测试体系

四层：服务端单测（域逻辑）→ 收敛冒烟（协同正确性，必跑）→ E2E UI 回归（本地专属）→ 手工多端场景（发布前）。
**CI 不跑任何测试**——流水线只出包，这是明确约定。

## 0. 服务端单测（`server/*.test.js`，node:test）

```bash
npm --prefix server test        # 44 用例,~5s
```

覆盖：auth（账号/设备/恢复密钥/注销宽限/清扫）、pairing v2（双向状态机、上限、幂等轮询）、
docStore（码生成/生命周期/快照落盘/清扫）、attachments（登记/引用回收）、exporter（zip 组装/文件名头）。
纪律：测试不得打印凭据、恢复密钥或完整文档码；需要"过去"的时间用 UPDATE 回写时间戳构造。

## 1. 收敛冒烟（`server/convergence-smoke.mjs`）— REQUIRED

触发条件：任何改动触及 `useCollaboration.ts`、Yjs 文档模型、或服务端中继逻辑。

```bash
cd server && node --disable-warning=ExperimentalWarning index.js &   # 起服（:3001）
node --disable-warning=ExperimentalWarning convergence-smoke.mjs http://localhost:3001
# ⚠️ 默认打 :8101；直接 node 跑（--test 会吃掉位置参数）；失败退出码非 0
```

内容：v4 全链路——凭据创建/WS 子协议鉴权（无凭据 4001、URL 带 token 4001、吊销即时断开）、
配对双向、文档生命周期（4004/4010、回收站、恢复）、附件上传/读取/回收、
导出 zip 与一次性令牌、`/health` 形状；外加双客户端 100 次随机位置交错插入 → 删除轮 → meta + awareness 断言。
部署 CI（deploy.yml）在容器内以同一脚本自环验证（`docker exec polyphony node server/convergence-smoke.mjs http://127.0.0.1:9091`）。
**断言纪律**：交错插入会拆散文本标记，必须数括号对，不能 substring 匹配。

## 2. E2E UI 回归（`e2e/`，Playwright）— 仅本地，绝不进 CI

```bash
cd e2e && npm install && npx playwright test   # 77 用例，~40s（chrome + mobile + mobile-sm 三 project）
npx playwright test tests/home.spec.ts         # 单文件
npx playwright test --headed -g "重命名"        # 有头调试
npx playwright show-report                     # 失败截图/trace
```

- 自动拉起依赖：`webServer` 配置会起 `server/`（:3001）与 Vite dev（:5173），已起则复用；
  浏览器用系统 Chrome（`channel: "chrome"`，不下载）；摄像头用 fake device 参数。
- **CI 隔离是硬约定**：`.github/workflows/` 禁止引用 e2e/playwright；提交前自查 `rg -n "playwright" .github/` 应无结果。

覆盖（详见 `e2e/README.md`）：

| 文件 | 内容 |
|---|---|
| `auth.spec.ts` | 创建 → 恢复密钥一次性展示（强制勾选）、恢复密钥登录、401 统一登出、v3 残留清理 |
| `pairing.spec.ts` | push 链接全流程/拒绝/撤销/双开抢码；pull 批准页（未登录不暴露） |
| `home.spec.ts` | 守卫、创建/加入（含不存在的码）、扫码粘贴兜底、owner 🗑 与成员 ✕、回收站恢复、批量退出（成员行） |
| `join.spec.ts` | `/join` 分流 + 超长码截断回归（真实建文档） |
| `editor.spec.ts` | 守卫（含 4004 退出）、复制降级、二维码三关闭、重命名、所有者导出 zip/删除、双端协同与人数回落 |
| `settings.spec.ts` | 测试连接（文档数/人数）、协议头补全、回落链、已登录设备（吊销本机） |
| `ui-mobile.spec.ts` | 移动布局/触达专项（三入口表单、配对二维码、所有者删除、三段设置） |
| `ui-desktop.spec.ts` / `i18n.spec.ts` | 桌面双栏形态、语言切换 |

写用例的纪律（都是实踩）：

- **文档必须先真实创建**：v4 WS 进房前服务端校验文档存在（4004），`uniqRoom` 随机码直开编辑器会被弹回——一律 `POST /docs` 拿真码（`helpers.createDoc`）。
- **账号要凭据注入**：`helpers.loginTestAccount` 生成 secret 并拼 `poly_d_` 凭据（服务端不再下发 secret）。
- **并行隔离**：每用例独立账号 + 独立文档；awareness 人数是文档级全局，会互相串扰。
- **双用户各开独立 browser context**：同 context 双标签共享 IndexedDB/BroadcastChannel，y-websocket
  awareness 归属会错位（离开要等 ~30s），跨 context 才是真实多用户语义（见 [collaboration.md](collaboration.md#已知边界)）。
- **owner 行与成员行按钮不同**：首页 owner 行是 🗑（删除进回收站），批量退出只作用于成员行——造"可退出"的行要用第二个账号的文档。
- localStorage 断言注意 `useLocalStorageState` 存的是 JSON.stringify 值（带引号），业务读取必须走 `storage.ts` 的解析函数。
- dev 构建的地址回落取 `VITE_SERVER_URL`（:3001），只有生产构建才回落 origin。

## 3. 纯逻辑 roundtrip

QR 载荷构建（`client/src/lib/qr.ts`）与扫码/粘贴解析（`client/src/lib/intake.ts`）是纯函数，改动后补断言式验证（build/parse 对拍）。

## 4. 手工多端场景（发布前）

局域网联调用 `npm run dev:lan`（单端口同源出 Web+API+WS，手机浏览器/App/桌面共用打印出的地址）；发布前建议完整过一遍：
桌面 App 直连 IP 编辑 ↔ 手机浏览器扫码进文档 ↔ 内容收敛；断网编辑 → 重连合并（y-indexeddb）；
Android 真机装 CI 出的 apk：扫文档码进房、欢迎页 pull 码由桌面端批准登录（双向配对真机路径）；
v3.5.0 覆盖安装后旧 token 自动清理回引导页。

## 5. 本地构建自检

```bash
npm run build          # tsc --noEmit + eslint + vite build（root 委托 client/）
STATIC_DIR=../client/dist node --disable-warning=ExperimentalWarning server/index.js   # 本地同源托管验证
```

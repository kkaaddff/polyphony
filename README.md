<div align="center">

# 复调 Polyphony

**Many voices. One score.**

实时协同文档编辑 · 自托管 · 全平台

[![Release](https://img.shields.io/github/v/release/kkaaddff/polyphony?style=flat-square&label=Release)](https://github.com/kkaaddff/polyphony/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue?style=flat-square)](LICENSE)
[![Platforms](https://img.shields.io/badge/platforms-Web%20%7C%20macOS%20%7C%20Windows%20%7C%20Linux%20%7C%20Android-green?style=flat-square)](#-快速开始)

**「复调」取自巴赫的赋格:多个独立声部各行其是、没有中央指挥,却收敛为一份和谐的总谱——这正是 CRDT 协同编辑的语义:每个人自由编辑,文档最终一致。**

</div>

---

![复调首页 · 双栏一屏](docs/img/screenshot-home.png)

基于 [Yjs](https://github.com/yjs/yjs) CRDT 的实时协同富文本编辑器。一套 React 代码构建 **Web / 桌面(macOS·Windows·Linux)/ Android** 客户端;服务器是一个单容器 Node 服务(SQLite 持久化,重启文档不丢),`docker compose up -d` 即完成自托管。**每设备独立凭据 + 恢复密钥 + 扫码配对登录**,首页双栏一屏;手机**扫码直接进文档**,断网可写、重连自动合并。

![双端实时协同](docs/img/screenshot-collab.png)

## ✨ 特性

- 🎼 **实时协同**——Yjs CRDT,多人并发编辑自动收敛、无冲突
- 📝 **富文本**——MDX 编辑器:加粗/斜体、列表、引用、表格、代码块、图片、链接
- 👤 **账号体系**——任意端创建账号即登录;恢复密钥只发一次(可重生成);新设备**扫码配对**登录(双向:老设备出码或新设备出码);已登录设备管理与注销宽限
- 🚪 **文档系统**——服务端生成 8 位文档码,显式创建;我的文档跨端同步;删除进**回收站**(30 天可恢复),支持一键导出 zip;在线用户感知(awareness)
- 📱 **扫码进入**——文档/配对二维码都是 Web URL,任何手机相机都能扫;App 内扫码走原生插件,无摄像头自动切粘贴
- 💾 **离线可写**——IndexedDB 房间级持久化,断网继续编辑,恢复后自动合并
- 🖥 **桌面增强**——Tauri 2 托盘最近房间直达;Android arm64 安装包

## 🚀 快速开始

### 自托管(服务器 + Web,一条命令)

```bash
git clone https://github.com/kkaaddff/polyphony.git
cd polyphony
docker compose up -d
```

单容器同时提供「Web 前端 + 账号/文档 API + 协同 WebSocket + 图片上传」,默认端口 `9091`:

```bash
curl http://127.0.0.1:9091/health
# {"status":"ok","totalRooms":0,"totalUsers":0,"docs":0,...}
```

数据全部落卷、重启不丢:SQLite 库(账号/文档快照/成员/附件登记)在 `polyphony-data`,图片在 `polyphony-uploads`。

### 创建账号并登录

1. 任意端(Web / 桌面 / Android)打开应用 → 「新建账号」:填用户名 → 创建;
2. **恢复密钥仅展示这一次**(离线抄存,用于日后在新设备找回账号)——勾选确认后即登录;
3. 其他设备登录用「已有账号 · 配对登录」:老设备在头像菜单「登录新设备」出二维码/链接,新设备扫码确认即登录;或新设备亮本机码、由老设备扫开批准页核对放行;也可用恢复密钥直接登录。

> 协同 WS、上传均要求本机设备凭据(WS 走子协议头,不落 URL);进入文档仍需 8 位文档码(双凭据:设备凭据 = 身份,文档码 = 准入)。

<details>
<summary><b> HTTPS / 反向代理(WebSocket 升级配置)</b></summary>

裸 HTTP 直连 `http://IP:9091` 开箱即用;公网建议加一层反代。关键是 `/ws` 的升级头:

```nginx
server {
    listen 443 ssl;
    server_name docs.example.com;

    location / {
        proxy_pass http://127.0.0.1:9091;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;   # WebSocket 必需
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        client_max_body_size 6m;                  # 图片上传 5MB 上限 + 头部余量
    }
}
```

</details>

### 桌面 / Android 客户端

到 [Releases](https://github.com/kkaaddff/polyphony/releases) 下载:

| 产物 | 说明 |
|---|---|
| `Polyphony_*_aarch64.dmg` | macOS(Apple Silicon) |
| `Polyphony_*_x64-setup.exe` | Windows(NSIS) |
| `Polyphony_*_amd64.deb` | Linux(Debian 系) |
| `app-universal-debug.apk` | Android(arm64) |

> 产物未签名/公证:macOS 首次打开需右键 → 打开;Windows 会弹 SmartScreen;apk 为 debug 签名可直接侧载。

客户端首次启动后在「设置」页填入服务器地址(如 `https://docs.example.com`)即可,运行时生效。

### 本地开发

```bash
./setup.sh              # client/ 与 server/ 各 npm install,写 .env.local
npm run dev:all         # 前端(Vite :5173) + WS 服务(:3001)
```

打开 <http://localhost:5173>。桌面/Android 壳开发(可选,需 Rust/JDK)见 [docs/README.md](docs/README.md)。

## 🏗 架构

```
 Tauri 桌面 (dmg/nsis/deb)           托盘最近房间 · IndexedDB 离线缓存
 Tauri Android (arm64 apk)           扫码进房 · ws://IP:PORT 直连
 Web (Vite SPA)                      默认同源,?server= 可覆盖
        │  同一套 client/src(platform/ 收敛平台差异)
        ▼
 server/ Node —— express + y-websocket(CRDT 中继) + multer(上传) + /health
        ▲
 all-in-one Docker:同一端口托管静态前端 + WS(STATIC_DIR),单容器自托管
```

- **每个文档 = 一个 Yjs 文档**;服务端快照落盘(SQLite,防抖 + 退出刷盘),重启后自动恢复;客户端另持 IndexedDB 离线缓存。
- **服务器地址运行时解析**(`client/src/lib/serverConfig.ts`):`?server=` 参数 > 本机已保存配置 > dev 环境变量 > Web 同源回退——构建产物不含任何内联地址。
- **二维码 = Web URL**(`<server>/join?code=&server=` 与 `/pair?code=&server=`):系统相机扫码进 Web 版兜底,App 内扫码解析直连。

详细设计(身份体系、文档生命周期、协同内核、构建、测试、决策与踩坑记录)见 [`docs/`](docs/README.md)。

### HTTP 接口(v4 摘要)

| 接口 | 鉴权 | 说明 |
|---|---|---|
| `POST /auth/create` | 公开 | `{name, secret, platform}`(secret 设备本地生成)→ `{deviceId, name, recoveryKey}`;恢复密钥**仅此一次**返回 |
| `POST /auth/exchange` | 公开 | 恢复密钥 → 兑换本机设备凭据 |
| `/auth/pair/*` | 混合 | 配对 v2 双向状态机(create/request/claim/approve/poll/cancel) |
| `GET/POST /rooms(/enter|/leave)` | Bearer | 我的文档簿(memberships ⨝ docs,含在线人数与 `isOwner`);响应附 `pendingPairings` |
| `POST /docs` | Bearer | 显式建文档(服务端生成 8 位码,创建者即所有者) |
| `DELETE /docs/:code` 等 | Bearer | 回收站/恢复/彻底清除/一次性导出令牌 |
| `POST /docs/:code/attachments` | Bearer | 图片按文档目录落盘;`GET /uploads/:code/:file` 免鉴权读(128 位熵) |
| `GET /health` | 公开 | 只回数量(在线房间/人数/文档数/附件字节) |
| `wss://…/<文档码>`(子协议 `polyphony.v1, auth.<token>`) | 子协议头 | y-websocket 协同通道;4001 凭据无效 / 4004 文档不存在 / 4010 已入回收站 |

## 📦 发布与 CI

- **`docker compose up -d`** 即部署(server + Web 一体机)——自建 Gitea CI 用同样方式自动构建部署,仓库内 [`.gitea/workflows/deploy.yml`](.gitea/workflows/deploy.yml) 可作自托管参考(纯文档推送不触发、验证失败自动回滚)。
- **桌面/Android 端产物**由 GitHub Actions 构建(`.github/workflows/build.yml`):推 `v*` tag 或手动触发,全产物挂 GitHub Release。

## 🔒 安全须知(如实)

- **双凭据模型**:设备凭据 = 账号身份(secret 设备本地生成、服务端只存哈希、可吊销),文档码 = 文档准入;二者缺一不可。恢复密钥是唯一找回通道(仅创建/重生成时可见)。
- 直连为明文 `ws://`(Android 已开 cleartext);公网使用请套 HTTPS 反代(见上文配置)。WS 凭据走子协议头,不落 URL 与访问日志。
- 图片读取免鉴权(编辑器直链显示需要):路径含 128 位随机熵且文档必须处于活跃状态;介意可在反代层限速 `/uploads/`。
- `/health` 只回数量,不含任何文档码。

## 🙏 致谢

- [Yjs](https://github.com/yjs/yjs) / [y-websocket](https://github.com/yjs/y-websocket) / [y-indexeddb](https://github.com/yjs/y-indexeddb) —— CRDT 协同内核
- [MDX Editor](https://github.com/mdx-editor/editor) —— 富文本编辑器
- [Tauri](https://github.com/tauri-apps/tauri) —— 跨平台桌面/移动壳
- [Vite](https://github.com/vitejs/vite) / [React](https://github.com/facebook/react)

## 📄 许可证

[MIT](LICENSE) · 变更记录见 [CHANGELOG.md](CHANGELOG.md)

# 复调 Polyphony 交接文档(docs/)

> 全量架构设计与项目要点。2026-10 完成跨平台 CS 架构改造(Next.js 单 Web → Tauri 2 三端 + 独立 Node 服务),
> v3.1 起更名 Polyphony 并切换为「Gitea 开发主仓 + GitHub 发布仓」双仓流;**v4(2026-11)重做账号体系与文档存储**(全新开始,不迁移历史数据)。
> 日常速查仍以根 `README.md` 与 `AGENTS.md` 为准,本文档负责"为什么这样设计"与"所有踩过的坑"。

## 目录

| 文档 | 内容 |
|---|---|
| [architecture.md](architecture.md) | 总体架构图、分层结构、各子系统设计(运行时服务器配置 / 身份与登录 / 文档生命周期 / QR 与粘贴入口 / 平台抽象 / Tauri shell / 离线缓存 / 服务端) |
| [identity-and-sharing.md](identity-and-sharing.md) | **v4 身份体系设计(已实现)**:设备凭据、恢复密钥、配对 v2、注销宽限、SQLite 库表、API/WS 契约 |
| [document-lifecycle.md](document-lifecycle.md) | **v4 文档生命周期设计(已实现)**:显式创建、回收站、快照持久化、附件引用回收、导出 |
| [pairing-login.md](pairing-login.md) | 配对登录 v1 历史设计(**已被 identity-and-sharing.md 的配对 v2 取代**,存档) |
| [collaboration.md](collaboration.md) | 协同内核:Yjs 文档模型、数据流、awareness 在线状态语义、生命周期与已知边界 |
| [build-and-release.md](build-and-release.md) | GitHub Actions 全产物流水线:矩阵、Release 语义、Android 约束、CI 侧坑 |
| [deploy-and-ops.md](deploy-and-ops.md) | 自托管指南:Docker all-in-one、TLS 反代、Gitea 自动部署参考、备份恢复与安全边界 |
| [testing.md](testing.md) | 测试体系:服务端单测、收敛冒烟(必跑)、E2E UI 回归(仅本地)、手工场景 |
| [decisions.md](decisions.md) | 决策记录(ADR 简表)与全部已知坑清单 |

## 项目事实卡

| 项 | 值 |
|---|---|
| 版本 | 4.0.0(`client/src-tauri/tauri.conf.json`) |
| 仓库 | **开发主仓:私有 Gitea**(`origin`,日常 push 触发部署);**发布仓:github.com/kkaaddff/polyphony**(`github` remote,仅 tag/release 时推送,GitHub 操作一律走 `gh`) |
| 客户端 | Web(Vite `client/dist/`)+ 桌面三平台(mac arm64 dmg / win nsis / linux deb)+ Android(arm64-v8a apk,debug 签名) |
| 服务 | `server/`:express + ws + y-websocket 中继 + SQLite(`node:sqlite`);dev `:3001`,生产 docker all-in-one `:9091`(容器 `polyphony`) |
| 生产部署 | Gitea CI(自建 runner)→ `docker compose up -d --build` 原地换容器;详见 deploy-and-ops.md |
| CI | `.gitea/workflows/deploy.yml`(server+Web 自动部署)/ `.github/workflows/build.yml`(端产物 + GitHub Release,推 `v*` tag 或手动) |
| 协议 | CRDT(Yjs)over y-websocket(WS 子协议头携带凭据);账号/文档 API 强制鉴权,文档码即准入 |
| 本地出包 | **没有**。本机无 Rust/JDK,桌面/安卓包全部由 Actions 出;本地只跑 `tsc`/`eslint`/`vite build` + 服务端单测 + 收敛冒烟 + e2e |

## 快速上手

```bash
bash setup.sh            # client/ + server/ 一次性安装
npm run dev:all          # Vite :5173 + 协同服务 :3001
npm --prefix server test # 服务端单测(44)
cd e2e && npx playwright test   # 本地 UI 回归(77 用例,不进 CI)
docker compose up -d     # 本机起一个 all-in-one(:9091)
```

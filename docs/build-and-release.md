# 打包与发布（GitHub Actions）

**定位：本机不出包。** 本地无 Rust/JDK，桌面与 Android 产物全部由 `.github/workflows/build.yml` 出；
本地只跑 `tsc`/`eslint`/`vite build`、收敛冒烟与 e2e。CI 只出包，**不跑测试**（e2e 明确禁止进 CI）。

## 触发与 Release 语义

| 触发 | Release 行为 |
|---|---|
| 手动 `workflow_dispatch`（默认 `release=true`） | 创建/复用 Release `v<tauri.conf.json 版本>`（当前 v3.0.0），**全产物挂附件**，`releaseDraft: false` 立即发布；重复触发同版本会 `--clobber` 覆盖同名附件 |
| 手动（勾掉 release） | 仅上传 Artifacts，不动 Release |
| 推 `v*` tag | Release 标签 = tag 名 |

三处 Release 标签计算步骤同源同一逻辑：tag 触发用 `$GITHUB_REF_NAME`，否则 `v+版本号`。

## 产物矩阵（6 项）

| Job | Runner | 产物 | Release 附件 |
|---|---|---|---|
| web | ubuntu | `web-dist.zip`（Vite dist） | ✓ |
| desktop (mac) | macos-latest（arm64 runner） | `Polyphony_<ver>_aarch64.dmg` | ✓（tauri-action） |
| desktop (win) | windows-latest | `Polyphony_<ver>_x64-setup.exe`（nsis） | ✓ |
| desktop (linux) | ubuntu | `Polyphony_<ver>_amd64.deb`（仅 deb） | ✓ |
| android | ubuntu | `app-universal-debug.apk`（arm64-v8a） | ✓ |

矩阵决策（用户拍板，勿回退）：

- **不出 Intel mac dmg**（只 Apple Silicon）。
- **Linux 只出 deb，不出 AppImage**（2026-11-04 用户拍板）。
- **Android 只兼容最新设备**：`--target aarch64` 单 apk，不拆 abi、不出 aab，v1 用 debug 签名可直接装机。
- 桌面无签名证书：dmg 右键打开可装，exe SmartScreen 警告，README 已注明。

## 关键实现坑（都实踩过，注释里也有）

1. **tauri-action 无 `tagName` 时跳过一切上传** → 手动触发不传 tag 的场景必须自己 `upload-artifact` 兜底 + 显式 `gh release create/upload`。web 与 android job 用 `gh release create ... || true`（create-or-get 并发安全）+ `gh release upload --clobber`。
2. **gh CLI 不展开 glob**：android apk 路径 `**/*.apk` 需要 `shopt -s globstar nullglob`。
3. **npm 侧**：
   - CI 用 `env: NPM_CONFIG_REGISTRY=https://registry.npmjs.org` 覆盖回官方源——仓库 `.npmrc` 是 npmmirror（本机加速用），海外 runner 拉镜像不稳，曾出现 `npm ci` 中途崩且退出码 0 → 半残 `node_modules`。
   - CI 用 `npm install` 而非 `ci`：npm 会把 rollup 的 optional 平台原生包按"生成 lockfile 的平台"裁剪（npm/cli#4828），单平台 lockfile 在其它平台 `npm ci` 必缺 `@rollup/*-gnu/msvc`；`replace-registry-host` 机制保证 install 仍遵循锁定版本。另加 `test -x node_modules/.bin/tsc` 防半残安装。
4. **Rust 桌面 API 是 desktop-only**：`#[cfg(desktop)]` 门控托盘/菜单，否则 android 目标编译失败。
5. **Android runner**：预装 SDK/许可，`setup-android@v3` 反而会挂（废弃 tools 包），只用 `setup-java@17` + 手动确保 `NDK_HOME`；`tauri android init` + `android-patch.mjs` 在 CI 内现场生成工程。
6. **Release 并发**：tauri-action 会自建缺失 Release，与 web/android 的 `gh release create || true` 并发安全；`permissions: contents: write` 必需。
7. Linux（仅 deb）需 `libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev`（托盘/ayatana；AppImage 时代还需 patchelf，已随 AppImage 移除）。
8. `Swatinem/rust-cache@v2`（workspaces 指 `client/src-tauri`）+ `dtolnay/rust-toolchain@stable`（mac 项补 `aarch64-apple-darwin` target，android 项补 `aarch64-linux-android`）。

## 发布流程（实操）

1. 改版本：`client/src-tauri/tauri.conf.json` 的 `version`（三平台产物名与 Release 标签都从这取）。
2. push 后 Actions 页手动 Run workflow（默认即出全套 + Release）；或推 `v*` tag。
3. 产物取回：Release 页 6 个附件。（server+Web 的生产部署不经此流水线——自建 Gitea CI 负责，见 deploy-and-ops.md。）
4. 查询用 `gh`（本仓库约定 GitHub 操作一律 gh；`github` remote 已是 HTTPS + gh 凭据）：
   ```bash
   gh run list --repo kkaaddff/polyphony
   gh release view v3.1.0 --repo kkaaddff/polyphony
   ```

> 本流水线加了 job 级守卫 `if: vars.DEPLOY_ENV == 'github'`：仓库镜像到 Gitea 时，
> Gitea Actions 会同时读 `.github/workflows/`（推 `v*` tag 即触发；其自建 runner 无
> `ubuntu-latest` 标签，job 会永远排队）。守卫用仓库 Actions 变量——只在 GitHub 仓配置
> `DEPLOY_ENV=github`，Gitea 侧不设即全部跳过。`server_url` 类守卫不可靠（Gitea 的
> DEFAULT_ACTIONS_URL 常默认 github.com）。

## 待验证 / 未做

- Android 16KB page size 合规（Google 新规）未专项验证；上架 Google Play 前需处理 + 出 aab。
- mac 公证（notarize）/ win 代码签名未配（无证书）；自动更新（v1 明确不做）。

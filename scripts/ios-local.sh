#!/usr/bin/env bash
# 本地出 iOS 模拟器包(调试联调用;正式发布仍走 GitHub Actions;免费真机侧载见文末说明)。
#   gen/ 不入库——首次运行自动 `tauri ios init` + ios-patch(相机 / ATS / 本地网络用途说明 + 图标)。
#   产物:client/src-tauri/gen/apple/build/arm64-sim/Polyphony.app;`--install` 启动模拟器并安装拉起。
# 依赖(一次性):
#   Xcode + brew install cocoapods;
#   rustup target add aarch64-apple-ios-sim aarch64-apple-ios x86_64-apple-ios;
#   iOS 模拟器运行时(Xcode 起把 SDK 与运行时分开下载):`xcodebuild -downloadPlatform iOS`。
#   脚本逐项自检并给出缺失项的安装命令。
# 构建路径(自动选择,产物相同):
#   A. 已装运行时版本 ≥ 默认 SDK 版本 → `tauri ios build`(常规路径)。
#   B. 否则 → Tauri 的 Xcode 工作流:`tauri ios build --open` 常驻提供构建选项,由本脚本调 xcodebuild 归档。
#      tauri 自己的 iOS 构建(cargo-mobile2 validate_sdk)要求存在不低于默认 SDK 版本的可用运行时,
#      否则报「Xcode Simulator SDK xx is not installed」;而 Xcode 驱动的构建没有这道检查
#      (SDK 27 编出的 App 最低支持 iOS 15,在 26.x 运行时上照常运行)。
# 用法:仓库根 `npm run ios:build`(加 --install 装进模拟器并启动)。
#   真机:`npm run ios:build -- --device [UDID] --install` —— 免费个人团队自动签名 + devicectl 装机。
#   签名团队取自 Apple Development 证书 OU(可用 POLY_TEAM 覆盖);UDID 省略时自动取已连接物理设备。
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
APP="$ROOT/client/src-tauri/gen/apple/build/arm64-sim/Polyphony.app"
ARCHIVE="$ROOT/client/src-tauri/gen/apple/build/polyphony_iOS.xcarchive"
OPTIONS_FILE="$ROOT/client/src-tauri/gen/apple/.tauri/cli-options-server.json"
BUNDLE_ID="$(node -p "require('$ROOT/client/src-tauri/tauri.conf.json').identifier")"
VERSION="$(node -p "require('$ROOT/client/src-tauri/tauri.conf.json').version")"
CLI_PID=""

# ── 参数:--install / --device [UDID] ──────────────────────────────────────
INSTALL=no; DEVICE_MODE=no; DEVICE_UDID=""
while [ $# -gt 0 ]; do
  case "$1" in
    --install) INSTALL=yes; shift ;;
    --device) DEVICE_MODE=yes; shift
      if [ $# -gt 0 ] && [ "${1#--}" = "$1" ]; then DEVICE_UDID="$1"; shift; fi ;;
    *) shift ;;
  esac
done

# ── 依赖自检 ───────────────────────────────────────────────────────────────
FAIL=0
echo "[ios-local] 依赖自检"
echo "  (一次性安装: brew install cocoapods;"
echo "   rustup target add aarch64-apple-ios-sim aarch64-apple-ios x86_64-apple-ios;"
echo "   xcodebuild -downloadPlatform iOS)"
if xcodebuild -version >/dev/null 2>&1; then echo "  ✓ Xcode $(xcodebuild -version | head -1 | awk '{print $2}')"; else echo "  ✗ Xcode —— 缺失(装 Xcode 并执行 xcode-select --install)"; FAIL=1; fi
if command -v pod >/dev/null 2>&1; then echo "  ✓ CocoaPods"; else echo "  ✗ CocoaPods —— 缺失(brew install cocoapods)"; FAIL=1; fi
if [ "$DEVICE_MODE" = "yes" ]; then RUST_TARGET=aarch64-apple-ios; else RUST_TARGET=aarch64-apple-ios-sim; fi
if rustup target list --installed 2>/dev/null | grep -q "^$RUST_TARGET\$"; then echo "  ✓ Rust iOS target ($RUST_TARGET)"; else echo "  ✗ $RUST_TARGET —— 缺失(rustup target add $RUST_TARGET)"; FAIL=1; fi
[ "$FAIL" = "0" ] || { echo "[ios-local] 请先补齐上述依赖"; exit 1; }

export CARGO_NET_RETRY=10

# 默认模拟器 SDK 版本,与已装可用运行时里的最高版本比较(按数字逐段比)
SDK_VERSION="$(xcrun --sdk iphonesimulator --show-sdk-version 2>/dev/null || echo 0)"
MAX_RUNTIME="$(xcrun simctl list runtimes --json 2>/dev/null | node -e '
  let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
    const nums = (v) => String(v).split(".").map(Number);
    const cmp = (a, b) => { for (let i = 0; i < Math.max(a.length, b.length); i++) { const d = (a[i] || 0) - (b[i] || 0); if (d) return d; } return 0; };
    try {
      const runtimes = JSON.parse(s).runtimes.filter((r) => r.isAvailable && r.name.startsWith("iOS")).map((r) => r.version);
      runtimes.sort((a, b) => cmp(nums(a), nums(b)));
      process.stdout.write(runtimes.at(-1) || "");
    } catch { /* 无运行时 */ }
  });')"
RUNTIME_OK=no
[ -n "$MAX_RUNTIME" ] && node -e '
  const nums = (v) => v.split(".").map(Number);
  const [a, b] = [process.argv[1], process.argv[2]].map(nums);
  for (let i = 0; i < Math.max(a.length, b.length); i++) { const d = (a[i] || 0) - (b[i] || 0); if (d) process.exit(d < 0 ? 1 : 0); }
' "$MAX_RUNTIME" "$SDK_VERSION" && RUNTIME_OK=yes

# ── gen/ 不入库:首跑 init,每次都跑 patch(幂等;tauri ios init 会回落默认图标) ──
if [ ! -d client/src-tauri/gen/apple ]; then
  echo "[ios-local] 首次运行: tauri ios init ..."
  (cd client && npx tauri ios init)
fi
echo "[ios-local] ios-patch(相机 / ATS / 本地网络 + 图标) ..."
(cd client && node scripts/ios-patch.mjs)

# ── 真机模式:Xcode 工作流 + 免费个人团队自动签名 + devicectl 安装 ──────────────
# 真机不需要模拟器运行时(用 iphoneos SDK 直编),故跳过上面的 RUNTIME_OK 判断,恒走 Xcode 工作流。
if [ "$DEVICE_MODE" = "yes" ]; then
  TEAM="${POLY_TEAM:-$(security find-certificate -c 'Apple Development' -p 2>/dev/null | openssl x509 -noout -subject 2>/dev/null | sed -n 's/.*OU=\([A-Z0-9]*\).*/\1/p' | head -1 || true)}"
  [ -n "$TEAM" ] || { echo "[ios-local] 无 Apple Development 证书:先在 Xcode→Settings→Accounts 登录 Apple ID 生成个人团队"; exit 1; }
  # 物理设备 UDID 形如 8hex-16hex(模拟器是 8-4-4-4-12 UUID,不会误匹配)
  [ -n "$DEVICE_UDID" ] || DEVICE_UDID="$(xcrun devicectl list devices 2>/dev/null | grep -Eo '[0-9A-Fa-f]{8}-[0-9A-Fa-f]{16}' | head -1 || true)"
  DEV_APP="$ROOT/client/src-tauri/gen/apple/build/arm64-device/Polyphony.app"
  DEV_ARCHIVE="$ROOT/client/src-tauri/gen/apple/build/polyphony_iOS_device.xcarchive"
  echo "[ios-local] 真机:签名团队 $TEAM,设备 ${DEVICE_UDID:-未检测到}"
  SHIM="$(mktemp -d)"; printf '#!/bin/sh\nexit 0\n' > "$SHIM/open"; chmod +x "$SHIM/open"
  rm -f "$OPTIONS_FILE"; rm -rf "$DEV_ARCHIVE"
  CLI_LOG="$(mktemp -t ios-local-cli-dev)"
  (cd client && PATH="$SHIM:$PATH" exec node node_modules/.bin/tauri ios build --open --ci --debug --target aarch64) > "$CLI_LOG" 2>&1 &
  CLI_PID=$!
  cleanup() {
    if [ -n "$CLI_PID" ]; then pkill -TERM -P "$CLI_PID" 2>/dev/null || true; kill -TERM "$CLI_PID" 2>/dev/null || true; CLI_PID=""; fi
    rm -rf "$SHIM"; return 0
  }
  trap cleanup EXIT
  i=0; until [ -f "$OPTIONS_FILE" ] || [ "$i" -ge 120 ]; do i=$((i+1)); sleep 2; done
  [ -f "$OPTIONS_FILE" ] || { echo "[ios-local] Tauri CLI 未就绪,日志:"; tail -20 "$CLI_LOG"; exit 1; }
  echo "[ios-local] xcodebuild 真机归档中(自动签名,-allowProvisioningUpdates)..."
  (cd client && xcodebuild \
    -scheme polyphony_iOS \
    -workspace src-tauri/gen/apple/polyphony.xcodeproj/project.xcworkspace \
    -sdk iphoneos -configuration debug -destination 'generic/platform=iOS' \
    -allowProvisioningUpdates \
    archive -archivePath src-tauri/gen/apple/build/polyphony_iOS_device \
    "MARKETING_VERSION=$VERSION" "CURRENT_PROJECT_VERSION=$VERSION" \
    "DEVELOPMENT_TEAM=$TEAM" CODE_SIGN_STYLE=Automatic CODE_SIGN_IDENTITY="Apple Development")
  cleanup; CLI_PID=""
  mkdir -p "$(dirname "$DEV_APP")"; rm -rf "$DEV_APP"
  mv "$DEV_ARCHIVE/Products/Applications/Polyphony.app" "$DEV_APP"
  [ -d "$DEV_APP" ] || { echo "[ios-local] 真机产物缺失 $DEV_APP"; exit 1; }
  echo "[ios-local] 真机产物: $DEV_APP ($(du -sh "$DEV_APP" | cut -f1))"
  if [ "$INSTALL" = "yes" ]; then
    [ -n "$DEVICE_UDID" ] || { echo "[ios-local] 未检测到已连接真机(用 --device <UDID> 指定)"; exit 1; }
    echo "[ios-local] devicectl 安装到 $DEVICE_UDID ..."
    xcrun devicectl device install app --device "$DEVICE_UDID" "$DEV_APP"
    echo "[ios-local] 已安装到真机 ✓(免费签名 7 天过期,到期重跑本命令重签)"
    LAUNCH_LOG="$(mktemp -t ios-launch)"
    if xcrun devicectl device process launch --device "$DEVICE_UDID" "$BUNDLE_ID" > "$LAUNCH_LOG" 2>&1; then
      echo "[ios-local] 已在真机启动 ✓"
    elif grep -qi "could not be, unlocked\|BSErrorCodeDescription = Locked" "$LAUNCH_LOG"; then
      echo "[ios-local] iPhone 处于锁屏状态:解锁屏幕后重跑本命令,或直接点桌面 App 图标即可启动。"
    elif grep -qi "trusted\|invalid code signature\|entitlements" "$LAUNCH_LOG"; then
      echo "[ios-local] 首次侧载需在 iPhone 上信任开发者后才能启动:"
      echo "           设置 → 通用 → VPN与设备管理 → 点你的 Apple Development 描述文件 → 信任"
      echo "           信任后重跑本命令,或直接点桌面 App 图标即可启动。"
    else
      echo "[ios-local] 启动失败:"; tail -6 "$LAUNCH_LOG"
    fi
    rm -f "$LAUNCH_LOG"
  fi
  exit 0
fi

# ── 构建 ───────────────────────────────────────────────────────────────────
if [ "$RUNTIME_OK" = "yes" ]; then
  echo "[ios-local] 路径 A:tauri ios build(运行时 $MAX_RUNTIME ≥ SDK $SDK_VERSION)"
  (cd client && npx tauri ios build --debug --target aarch64-sim)
else
  echo "[ios-local] 路径 B:Xcode 工作流(已装运行时最高 ${MAX_RUNTIME:-无} < SDK $SDK_VERSION;常规构建会被版本检查拒绝)"
  echo "           想恢复路径 A:xcodebuild -downloadPlatform iOS 装匹配运行时后重跑。"
  # `--open` 让 CLI 写好构建选项后常驻(Xcode 工作流里由 Xcode 向它取选项)。
  # 它会用 `open -a` 弹出 Xcode 界面;这里遮蔽掉 open,只借用常驻的选项服务,由脚本自己驱动 xcodebuild。
  SHIM="$(mktemp -d)"
  printf '#!/bin/sh\nexit 0\n' > "$SHIM/open"
  chmod +x "$SHIM/open"
  rm -f "$OPTIONS_FILE"
  rm -rf "$ARCHIVE"   # 归档目录已存在时 xcodebuild 会拒绝写入
  CLI_LOG="$(mktemp -t ios-local-cli)"
  # 非交互 bash 没有 job control:后台子进程与脚本同进程组,不能 kill -- -$PID(会连脚本自己一起杀)。
  # 用 exec 让子进程就是 CLI 本身,结束时先杀它的子进程再杀它。
  (cd client && PATH="$SHIM:$PATH" exec node node_modules/.bin/tauri ios build --open --ci --debug --target aarch64-sim) > "$CLI_LOG" 2>&1 &
  CLI_PID=$!
  cleanup() {
    if [ -n "$CLI_PID" ]; then
      # 没有子进程时 pkill 返回 1;set -e 会在函数中途退出,必须 || true
      pkill -TERM -P "$CLI_PID" 2>/dev/null || true
      kill -TERM "$CLI_PID" 2>/dev/null || true
      CLI_PID=""
    fi
    rm -rf "$SHIM"
    return 0
  }
  trap cleanup EXIT
  # CLI 先跑前端构建再写选项文件,首次可能要一两分钟
  i=0
  until [ -f "$OPTIONS_FILE" ] || [ "$i" -ge 120 ]; do i=$((i+1)); sleep 2; done
  if [ ! -f "$OPTIONS_FILE" ]; then
    echo "[ios-local] Tauri CLI 未就绪,日志:"; tail -20 "$CLI_LOG"; exit 1
  fi
  echo "[ios-local] Tauri CLI 已常驻,xcodebuild 归档中 ..."
  # 与 tauri 自己的 archive 步骤同参(版本号用命令行覆盖,不改工程文件;模拟器无需 -allowProvisioningUpdates)
  (cd client && xcodebuild \
    -scheme polyphony_iOS \
    -workspace src-tauri/gen/apple/polyphony.xcodeproj/project.xcworkspace \
    -sdk iphonesimulator -configuration debug \
    archive -archivePath src-tauri/gen/apple/build/polyphony_iOS \
    "MARKETING_VERSION=$VERSION" "CURRENT_PROJECT_VERSION=$VERSION")
  cleanup
  CLI_PID=""
  # 产物从 xcarchive 里搬出来,与路径 A 的位置保持一致
  mkdir -p "$(dirname "$APP")"
  rm -rf "$APP"
  mv "$ARCHIVE/Products/Applications/Polyphony.app" "$APP"
fi

[ -d "$APP" ] || { echo "[ios-local] 未找到产物 $APP"; exit 1; }
echo "[ios-local] 产物: $APP ($(du -sh "$APP" | cut -f1))"

# ── 可选:装进模拟器并拉起 ─────────────────────────────────────────────────
if [ "$INSTALL" = "yes" ]; then
  # 优先用已启动的设备;否则取最新运行时下的第一台 iPhone
  DEVICE="$(xcrun simctl list devices available -j | node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      const all = Object.entries(JSON.parse(s).devices)
        .flatMap(([runtime, devices]) => devices.map((d) => ({ ...d, runtime })))
        .filter((d) => d.isAvailable && /SimDeviceType\.iPhone-/.test(d.deviceTypeIdentifier || d.deviceTypeId || ""));
      const booted = all.find((d) => d.state === "Booted");
      const newest = all.sort((a, b) => a.runtime.localeCompare(b.runtime, "en", { numeric: true })).at(-1);
      process.stdout.write((booted || newest)?.udid || "");
    });')"
  [ -n "$DEVICE" ] || { echo "[ios-local] 没有可用的 iPhone 模拟器(xcodebuild -downloadPlatform iOS 后在 Xcode 里会自动创建)"; exit 1; }
  if ! xcrun simctl list devices booted | grep -q "$DEVICE"; then
    echo "[ios-local] 启动模拟器 $DEVICE ..."
    xcrun simctl boot "$DEVICE"
  fi
  xcrun simctl bootstatus "$DEVICE" -b >/dev/null 2>&1 || true
  xcrun simctl install "$DEVICE" "$APP"
  xcrun simctl launch "$DEVICE" "$BUNDLE_ID"
  # 有 Simulator 界面就带上(没有也不影响:安装与运行本身不需要界面)
  open -b com.apple.iphonesimulator >/dev/null 2>&1 || true
  echo "[ios-local] 已安装并启动到模拟器 ✓"
fi

cat <<'NOTE'

[ios-local] 免费真机侧载(装到自己 iPhone,无需付费开发者账号)——Tauri 的 Xcode 工作流:
  1. cd client && npx tauri ios build --open      (CLI 会常驻并打开 Xcode;关掉它 Xcode 就编不了 Rust)
  2. Xcode → 目标 polyphony_iOS → Signing & Capabilities:
     勾选 Automatically manage signing,Team 选你的 Apple ID「Personal Team」
  3. 顶部选你的真机,⌘R 运行。首次需在 iPhone「设置 → 通用 → VPN与设备管理」信任该开发者。
  注意:免费个人团队签名 7 天过期,到期在 Xcode 里重跑一次即可;最多 3 个侧载 App。
  直接双击 .xcodeproj 打开而不带上一步的 CLI,Rust 构建相位会报
  「the `tauri ios dev` or `tauri ios build` command must be running while Xcode builds the app」。
  上架 App Store / TestFlight 需付费 Apple Developer Program(本项目当前不采用)。
NOTE

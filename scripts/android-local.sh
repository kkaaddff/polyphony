#!/usr/bin/env bash
# 本地出 Android apk(调试联调用,正式发布仍走 GitHub Actions):
#   gen/ 不入库——首次运行自动 `tauri android init` + android-patch(清单权限 + 自定义图标);
#   debug 签名固定用 secrets/android-debug.keystore(与 CI secret 同一把,ADR #28),
#   覆盖安装互不顶掉;产物 aarch64 apk,`--install` 直接 adb 装到已连设备。
# 依赖(一次性):brew install openjdk@17 android-commandlinetools && sdkmanager 装 ndk;
#   rustup target add aarch64-linux-android。脚本会逐项自检并给出缺失项的安装命令。
# 用法:仓库根 `npm run android:build`(加 --install 装机;加 --dev 走 android:dev 热重载)。
set -euo pipefail
cd "$(dirname "$0")/.."

FAIL=0
need() { # <说明> <检测命令...>
  local desc="$1"; shift
  if "$@" >/dev/null 2>&1; then
    echo "  ✓ $desc"
  else
    echo "  ✗ $desc —— 缺失"; FAIL=1
  fi
}

echo "[android-local] 依赖自检"
echo "  (一次性安装: brew install openjdk@17 android-commandlinetools;"
echo "   sdkmanager --sdk_root=\$HOME/Library/Android/sdk 'ndk;27.0.12077973' 'platform-tools';"
echo "   rustup target add aarch64-linux-android)"
need "JDK 17 (JAVA_HOME)"  env JAVA_HOME="$(brew --prefix openjdk@17 2>/dev/null)" java -version
need "Rust android target" rustup target list --installed
rustup target list --installed 2>/dev/null | grep -q aarch64-linux-android || { echo "  ✗ aarch64-linux-android —— 缺失"; FAIL=1; }
need "NDK 27"              test -d "$HOME/Library/Android/sdk/ndk/27.0.12077973"
need "adb(平台工具)"        test -x "$HOME/Library/Android/sdk/platform-tools/adb"
[ "$FAIL" = "0" ] || { echo "[android-local] 请先补齐上述依赖"; exit 1; }

export JAVA_HOME="$(brew --prefix openjdk@17)"
export PATH="$JAVA_HOME/bin:$HOME/Library/Android/sdk/platform-tools:$PATH"
export ANDROID_HOME="$HOME/Library/Android/sdk"

# debug 签名与 CI 同源(ADR #28):secrets 备份 → ~/.android/debug.keystore
mkdir -p "$HOME/.android"
if [ -f secrets/android-debug.keystore ] && ! cmp -s secrets/android-debug.keystore "$HOME/.android/debug.keystore"; then
  cp secrets/android-debug.keystore "$HOME/.android/debug.keystore"
  echo "[android-local] 已同步固定 debug keystore(与 CI 签名一致,可覆盖安装)"
fi

# gen/ 不入库:首跑 init + patch(清单权限/图标),此后复用
if [ ! -f client/src-tauri/gen/android/app/build.gradle.kts ]; then
  echo "[android-local] 首次运行: tauri android init ..."
  (cd client && npx tauri android init)
fi
echo "[android-local] android-patch(清单权限 + 三声部辫图标) ..."
(cd client && node scripts/android-patch.mjs)

echo "[android-local] 构建 aarch64 debug apk ..."
(cd client && npx tauri android build --apk --debug --target aarch64)

APK="$(ls -t client/src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk | head -1)"
ls -lh "$APK"

if [ "${1:-}" = "--install" ]; then
  echo "[android-local] adb install -r ..."
  adb install -r "$APK"
  echo "[android-local] 已安装到已连设备 ✓"
fi

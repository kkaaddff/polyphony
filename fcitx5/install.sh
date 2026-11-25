#!/usr/bin/env bash
# 在 Ubuntu 上编译并安装 Polyphony 远程语音输入的 Fcitx5 插件(docs/voice-input.md §5)。
#   bash fcitx5/install.sh             # 装依赖 → 编译 → 跑集成测试 → 安装 → 重启 fcitx5
#   bash fcitx5/install.sh --uninstall
# 前提:系统输入法框架已经是 Fcitx5(Ubuntu 默认是 IBus:先 `sudo apt install fcitx5 fcitx5-chinese-addons`,
# 再用 `im-config -n fcitx5` 切换并重新登录)。
set -euo pipefail
cd "$(dirname "$0")"

ADDON_DIR="$(pkg-config --variable=libdir Fcitx5Core 2>/dev/null || true)/fcitx5"
DATA_DIR="/usr/share/fcitx5/addon"

restart_fcitx() {
  if pgrep -x fcitx5 >/dev/null; then
    echo "[fcitx5-voice] 重启 fcitx5 ..."
    fcitx5 -rd >/dev/null 2>&1 || true
  else
    echo "[fcitx5-voice] fcitx5 未在运行:下次启动时自动加载"
  fi
}

if [ "${1:-}" = "--uninstall" ]; then
  sudo rm -f "$ADDON_DIR/libpolyphonyvoice.so" "$DATA_DIR/polyphonyvoice.conf"
  restart_fcitx
  echo "[fcitx5-voice] 已卸载"
  exit 0
fi

echo "[fcitx5-voice] 安装编译依赖 ..."
sudo apt-get update -qq
sudo apt-get install -y --no-install-recommends \
  build-essential cmake pkg-config fcitx5 libfcitx5core-dev libfcitx5utils-dev libfcitx5config-dev nlohmann-json3-dev

BUILD="$(mktemp -d)"
trap 'rm -rf "$BUILD"' EXIT
cmake -S . -B "$BUILD" -DCMAKE_INSTALL_PREFIX=/usr >/dev/null
cmake --build "$BUILD" -j"$(nproc)"
echo "[fcitx5-voice] 集成测试 ..."
(cd "$BUILD" && ctest --output-on-failure)
sudo cmake --install "$BUILD"
restart_fcitx

cat <<'MSG'
[fcitx5-voice] 已安装 ✓
接下来:
  1. 打开 Polyphony 桌面端 → 设置 →「远程语音输入」→ 勾选「允许这台电脑接收」;
     几秒内应显示「输入法插件已连接」。
  2. 手机 App →「更多」→「语音输入到电脑」,把电脑上的光标放进任意输入框后开始说话。
排查:`fcitx5-diagnose | grep -i polyphony`;日志 `fcitx5 -rd --verbose=polyphonyvoice=5`。
MSG

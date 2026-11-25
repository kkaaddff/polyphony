#!/usr/bin/env bash
# 容器内入口:同步源码 → 装依赖 → 编译插件与桌面壳 → 起桌面会话 → 跑 drive.mjs
set -euo pipefail
MODE="${1:-x11}"; shift || true

echo "[e2e] 同步源码"
mkdir -p /work/src
tar -C /repo -cf - \
  --exclude=node_modules --exclude=target --exclude=gen --exclude=dist --exclude=.git \
  --exclude='server/data' --exclude='server/uploads' --exclude='fcitx5/e2e/out' \
  server client fcitx5 | tar -C /work/src -xf -
cd /work/src

stamp() { sha256sum "$1" | cut -c1-16; }
for d in server client; do
  if [ "$(cat $d/node_modules/.lockstamp 2>/dev/null)" != "$(stamp $d/package-lock.json)" ]; then
    echo "[e2e] npm ci ($d)"; (cd $d && npm ci --no-audit --no-fund >/dev/null) && stamp $d/package-lock.json > $d/node_modules/.lockstamp
  fi
done

# client 的 lockfile 只钉了 x64 / darwin 的 rollup 原生包;arm64 Linux(Apple Silicon 上的容器)补装同版本
if [ "$(uname -m)" = "aarch64" ] && [ ! -d client/node_modules/@rollup/rollup-linux-arm64-gnu ]; then
  RV="$(node -p "require('./client/node_modules/rollup/package.json').version")"
  echo "[e2e] 补装 @rollup/rollup-linux-arm64-gnu@$RV"
  (cd client && npm install --no-save --no-audit --no-fund "@rollup/rollup-linux-arm64-gnu@$RV" >/dev/null)
fi

echo "[e2e] 编译并安装 Fcitx5 插件"
cmake -S fcitx5 -B /work/build-fcitx5 -DCMAKE_INSTALL_PREFIX=/usr -DENABLE_TEST=OFF >/dev/null
cmake --build /work/build-fcitx5 -j"$(nproc)" >/dev/null
cmake --install /work/build-fcitx5 >/dev/null

echo "[e2e] 编译桌面壳(真实 Tauri 应用,debug)"
export CARGO_TARGET_DIR=/work/target
(cd client && npx tauri build --debug --no-bundle > /work/tauri-build.log 2>&1) || { tail -40 /work/tauri-build.log; exit 1; }
ls -la /work/target/debug/polyphony

export XDG_RUNTIME_DIR=/tmp/xdg-runtime; mkdir -p "$XDG_RUNTIME_DIR"; chmod 700 "$XDG_RUNTIME_DIR"
export GTK_IM_MODULE=fcitx QT_IM_MODULE=fcitx XMODIFIERS=@im=fcitx SDL_IM_MODULE=fcitx
export NO_AT_BRIDGE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1 WEBKIT_DISABLE_COMPOSITING_MODE=1
rm -f /out/"$MODE"-* 2>/dev/null || true

if [ "$MODE" = "gnome" ]; then
  # GNOME Shell 需要 logind:起系统总线 + python-dbusmock 的 logind 模板
  export XDG_SESSION_TYPE=wayland XDG_CURRENT_DESKTOP=GNOME
  mkdir -p /run/dbus; dbus-daemon --system --fork
  # mutter 启动 Xwayland 前要求这个目录全局可写(否则直接崩溃)
  mkdir -p /tmp/.X11-unix; chmod 1777 /tmp/.X11-unix
  (python3 -m dbusmock --system --template logind > /tmp/mock-logind.log 2>&1 &)
  sleep 1
  exec dbus-run-session -- bash -c '
    gnome-shell --headless --wayland --virtual-monitor 1280x800 --unsafe-mode > /tmp/gnome-shell.log 2>&1 &
    for i in $(seq 1 60); do [ -S "$XDG_RUNTIME_DIR/wayland-0" ] && break; sleep 0.5; done
    sleep 4
    export WAYLAND_DISPLAY=wayland-0 DISPLAY=:0
    # Xwayland 带鉴权:X11 应用(xterm、默认配置下的 Chromium)要拿到 mutter 生成的 Xauthority
    export XAUTHORITY="$(ls "$XDG_RUNTIME_DIR"/.mutter-Xwaylandauth.* 2>/dev/null | head -1)"
    fcitx5 -d --verbose=polyphonyvoice=5 > /tmp/fcitx5.log 2>&1
    sleep 2
    exec timeout -k 5 "$E2E_TIMEOUT" node /work/src/fcitx5/e2e/drive.mjs gnome "$@"' _ "$@"
elif [ "$MODE" = "wayland" ]; then
  # Wayland 下 GTK 走合成器的 text-input-v3(Fcitx5 官方推荐配置:不设 GTK_IM_MODULE);Qt 仍走 fcitx 模块
  unset GTK_IM_MODULE
  export WLR_BACKENDS=headless WLR_LIBINPUT_NO_DEVICES=1 WLR_RENDERER=pixman XDG_SESSION_TYPE=wayland
  exec dbus-run-session -- bash -c '
    sway -c /work/src/fcitx5/e2e/sway.conf > /tmp/sway.log 2>&1 &
    for i in $(seq 1 50); do [ -S "$XDG_RUNTIME_DIR/wayland-1" ] && break; sleep 0.2; done
    export WAYLAND_DISPLAY=wayland-1
    export SWAYSOCK="$(ls $XDG_RUNTIME_DIR/sway-ipc.*.sock | head -1)"
    exec timeout -k 5 "$E2E_TIMEOUT" node /work/src/fcitx5/e2e/drive.mjs wayland "$@"' _ "$@"
else
  Xvfb :99 -screen 0 1280x800x24 -nolisten tcp > /tmp/xvfb.log 2>&1 &
  export DISPLAY=:99
  for i in $(seq 1 50); do xdpyinfo >/dev/null 2>&1 && break; sleep 0.2; done
  exec dbus-run-session -- bash -c '
    openbox > /tmp/openbox.log 2>&1 &
    fcitx5 -d --verbose=polyphonyvoice=5 > /tmp/fcitx5.log 2>&1
    sleep 1
    exec timeout -k 5 "$E2E_TIMEOUT" node /work/src/fcitx5/e2e/drive.mjs x11 "$@"' _ "$@"
fi

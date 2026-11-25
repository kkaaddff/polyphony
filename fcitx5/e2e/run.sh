#!/usr/bin/env bash
# 远程语音输入 · 桌面端到端(仅本地):在 Docker 的 Ubuntu 24.04 里编译真实的 Polyphony 桌面壳和 Fcitx5 插件,
# 起虚拟显示器 + Fcitx5 + 真实应用,脚本扮演手机,走「手机 → 服务端 → 桌面壳 → Socket → 插件 → 应用」全链路。
#   bash fcitx5/e2e/run.sh            # X11 全部应用
#   bash fcitx5/e2e/run.sh wayland    # sway(wlroots)无头 Wayland
#   bash fcitx5/e2e/run.sh x11 gedit  # 只跑某个应用
# 截图与结果在 fcitx5/e2e/out/。首次构建镜像和编译桌面壳各需数分钟,之后走缓存。
set -euo pipefail
cd "$(dirname "$0")"
REPO="$(cd ../.. && pwd)"
docker image inspect polyphony-desktop-e2e >/dev/null 2>&1 || docker build -t polyphony-desktop-e2e .
mkdir -p out
# 资源上限 + 总超时:某一步失控时只杀掉这个容器,不拖垮整个 Docker 虚拟机(实踩)
docker run --rm --shm-size=1g --memory=6g --memory-swap=6g --cpus=6 --pids-limit=2000 --stop-timeout 5 \
  -e E2E_TIMEOUT="${E2E_TIMEOUT:-900}" \
  -v "$REPO:/repo:ro" -v "$PWD/out:/out" \
  -v polyphony-e2e-work:/work -v polyphony-e2e-cargo:/opt/cargo/registry \
  polyphony-desktop-e2e bash /repo/fcitx5/e2e/entry.sh "$@"

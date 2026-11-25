#!/usr/bin/env bash
# 在 Docker 里的 Ubuntu 上编译 Fcitx5 插件并跑集成测试(macOS 开发机用;Ubuntu 上直接用 install.sh)。
#   bash fcitx5/build.sh            # Ubuntu 24.04(Fcitx5 5.1)
#   bash fcitx5/build.sh 22.04      # Ubuntu 22.04(Fcitx5 5.0)
set -euo pipefail
cd "$(dirname "$0")"
UBUNTU="${1:-24.04}"
IMAGE="polyphony-fcitx5:${UBUNTU}"
docker build -q --build-arg "UBUNTU=${UBUNTU}" -t "${IMAGE}" . >/dev/null
docker run --rm -v "$PWD:/src:ro" "${IMAGE}" bash -euc '
  cmake -S /src -B /build -DCMAKE_INSTALL_PREFIX=/usr >/dev/null
  cmake --build /build -j"$(nproc)"
  cd /build && ctest --output-on-failure
  DESTDIR=/stage cmake --install /build >/dev/null && (cd /stage && find . -type f | sort)
'

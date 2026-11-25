# 本地编译/测试 Fcitx5 插件用的 Ubuntu 环境(非发布镜像)。UBUNTU 版本决定 Fcitx5 SDK 版本:
#   docker build --build-arg UBUNTU=24.04 -t polyphony-fcitx5:24.04 fcitx5/
ARG UBUNTU=24.04
FROM ubuntu:${UBUNTU}
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential cmake extra-cmake-modules pkg-config gettext \
      fcitx5 libfcitx5core-dev libfcitx5utils-dev libfcitx5config-dev fcitx5-modules-dev \
      nlohmann-json3-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src

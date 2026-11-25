# 远程语音输入 · 桌面端到端环境(仅本地,不进 CI):Ubuntu 24.04 + 虚拟显示器 + Fcitx5 + 真实应用,
# 在里面编译并运行真正的 Polyphony 桌面壳。用法见 fcitx5/e2e/run.sh。
FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl wget gnupg git file xz-utils unzip sudo \
      build-essential cmake pkg-config patchelf \
      libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev libssl-dev libxdo-dev \
      webkit2gtk-driver \
      fcitx5 fcitx5-frontend-gtk3 fcitx5-frontend-gtk4 fcitx5-frontend-qt5 fcitx5-frontend-qt6 \
      fcitx5-chinese-addons libfcitx5core-dev libfcitx5utils-dev libfcitx5config-dev nlohmann-json3-dev \
      xvfb openbox xdotool xclip x11-utils x11-xserver-utils imagemagick dbus-x11 at-spi2-core \
      fonts-noto-cjk fonts-dejavu-core \
      gedit gnome-text-editor featherpad xterm xfce4-terminal \
      sway grim foot wl-clipboard wtype xwayland \
    && rm -rf /var/lib/apt/lists/*

# Node 22(服务端用 node:sqlite)
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs && rm -rf /var/lib/apt/lists/*

# VS Code(Electron,arm64/amd64 按架构取)
RUN ARCH="$(dpkg --print-architecture)" \
    && wget -q -O /tmp/code.deb "https://update.code.visualstudio.com/latest/linux-deb-${ARCH}/stable" \
    && apt-get update && apt-get install -y --no-install-recommends /tmp/code.deb \
    && rm -rf /tmp/code.deb /var/lib/apt/lists/*

# Chromium(Ubuntu 的 chromium 是 snap,容器里用不了;取 Playwright 的官方构建)
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/pw
RUN npx -y playwright@1.49.1 install --with-deps chromium && rm -rf /var/lib/apt/lists/* /root/.npm

# Rust + tauri-driver(WebDriver 驱动真实桌面壳)
ENV RUSTUP_HOME=/opt/rustup CARGO_HOME=/opt/cargo PATH=/opt/cargo/bin:$PATH
RUN curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable \
    && cargo install tauri-driver --locked && rm -rf /opt/cargo/registry

WORKDIR /work

# 纯 GTK4 TextView 对照样本(gtk4-textview.py)所需的 Python 绑定;放在最后以复用前面的缓存层
RUN apt-get update && apt-get install -y --no-install-recommends python3-gi gir1.2-gtk-4.0 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /work

# Qt 应用在 Wayland 下需要平台插件(否则 FeatherPad 起不来)
RUN apt-get update && apt-get install -y --no-install-recommends qtwayland5 qt6-wayland \
    && rm -rf /var/lib/apt/lists/*

# GNOME Wayland(Ubuntu 默认桌面)无头会话:gnome-shell + 模拟 logind(GNOME 自己的测试也是这么起的)
RUN apt-get update && apt-get install -y --no-install-recommends gnome-shell gnome-session-bin mutter python3-dbusmock \
    && rm -rf /var/lib/apt/lists/*

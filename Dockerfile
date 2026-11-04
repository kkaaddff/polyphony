# =============================================================================
# 复调 Polyphony all-in-one 镜像
#   前端: Vite 静态构建 → express 托管（SPA 兜底在 server/index.js）
#   后端: express + y-websocket（协同 WS / 图片上传 / health）
# 单容器单端口(9091)，前后端同源 —— 适配 fnos connect 随机四级域名反代。
# 服务器产物 + Web 产物都在这里构建；桌面/Android 端产物走 GitHub Release。
# =============================================================================

# ---- 阶段 1: 构建前端静态产物 ----
FROM node:22-alpine AS webbuild
WORKDIR /build

# 国内构建机走 npmmirror（fetch 重试对抗镜像抖动）。
# npm 的 replace-registry-host 机制会把 lockfile 里的 npmmirror 地址对齐当前 registry。
ENV NPM_CONFIG_REGISTRY=https://registry.npmmirror.com \
    NPM_CONFIG_FETCH_RETRIES=5

# npm install 而非 ci：可选平台原生包（@rollup/*）按「生成 lockfile 的平台」裁剪，
# 单平台 lockfile 在其它平台 npm ci 必缺 linux-x64（npm/cli#4828）；
# install 完整遵循既有锁定版本，仅补当前平台缺失项（与 GitHub CI 同策略）。
COPY client/package.json client/package-lock.json* ./
RUN npm install --no-audit --no-fund

COPY client/ ./
RUN npm run build   # tsc --noEmit + vite build → /build/dist

# ---- 阶段 2: 安装服务端生产依赖（纯 JS，ci 安全） ----
FROM node:22-alpine AS serverdeps
WORKDIR /build/server
ENV NPM_CONFIG_REGISTRY=https://registry.npmmirror.com \
    NPM_CONFIG_FETCH_RETRIES=5
COPY server/package.json server/package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund

# ---- 阶段 3: 运行时 ----
FROM node:22-alpine
ENV NODE_ENV=production \
    PORT=9091 \
    STATIC_DIR=/app/public

WORKDIR /app

COPY --from=serverdeps /build/server/node_modules ./server/node_modules
COPY server/index.js server/auth.js server/rooms.js server/db.js server/resetV3.js \
     server/sweeper.js server/convergence-smoke.mjs ./server/
COPY server/routes ./server/routes
COPY --from=webbuild /build/dist ./public

# 上传目录与账号数据（运行时挂卷持久化；accounts.json 原子写）；非 root 运行
RUN mkdir -p /app/server/uploads /app/server/data && chown -R node:node /app
USER node
VOLUME ["/app/server/uploads", "/app/server/data"]

EXPOSE 9091

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:9091/health >/dev/null || exit 1

CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]

#!/usr/bin/env bash
# 局域网联调(docker all-in-one 的本地等价物):
#   构建 Web(client/dist)→ 单端口起 v4 服务(STATIC_DIR 同源托管静态前端 + API + WS)。
#   手机浏览器/App/桌面浏览器全都用打印出的同一个地址,App 与 Web 零配置互通。
#   数据落在 server/data/polyphony.db(SQLite)与 server/data/uploads/,重启不丢。
# 用法:仓库根 `npm run dev:lan`([PORT=9091] bash scripts/dev-lan.sh 可换端口)。Ctrl-C 停止。
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-3001}"

echo "[dev-lan] 构建 Web → client/dist ..."
npm run build

# 局域网 IP:mac 走 ipconfig(en0 无线优先),Linux 走 hostname -I
LAN_IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)"
if [ -z "$LAN_IP" ] && command -v hostname >/dev/null; then
  LAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
fi

echo "[dev-lan] 启动服务 :${PORT}(同源托管 Web + API + WS)"
STATIC_DIR="$PWD/client/dist" node --disable-warning=ExperimentalWarning server/index.js &
SRV=$!
trap 'kill "$SRV" 2>/dev/null || true' EXIT

sleep 1.5
if curl -sf "http://127.0.0.1:${PORT}/health" >/dev/null; then
  echo "[dev-lan] health OK"
else
  echo "[dev-lan] ⚠ health 未通过,查看上方日志" >&2
fi

echo
echo "  ┌──────────────────────────────────────────────────────"
echo "  │ 手机浏览器 / App / 桌面浏览器,统一地址:"
echo "  │   http://${LAN_IP:-<本机IP>}:${PORT}"
echo "  │ App 欢迎页填同一地址;Web 端已默认填充当前 host"
echo "  └──────────────────────────────────────────────────────"
echo

wait "$SRV"

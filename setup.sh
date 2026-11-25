#!/bin/bash

# 复调 Polyphony 初始化脚本

echo "🎉 欢迎使用复调 Polyphony —— Many voices. One score."
echo "================================"
echo ""

# 检查 Node.js
if ! command -v node &> /dev/null; then
    echo "❌ 未检测到 Node.js，请先安装 Node.js (https://nodejs.org/)"
    exit 1
fi

echo "✓ Node.js 版本: $(node -v)"
echo "✓ npm 版本: $(npm -v)"
echo ""

# 安装前端依赖
echo "📦 正在安装前端依赖 (client/)..."
(cd client && npm install)

if [ $? -ne 0 ]; then
    echo "❌ 前端依赖安装失败"
    exit 1
fi

echo "✓ 前端依赖安装完成"
echo ""

# 安装服务器依赖
echo "📦 正在安装服务器依赖..."
cd server
npm install

if [ $? -ne 0 ]; then
    echo "❌ 服务器依赖安装失败"
    exit 1
fi

cd ..
echo "✓ 服务器依赖安装完成"
echo ""

# 重建客户端 dev 环境变量文件
echo "📝 重建 client/.env.local ..."
echo "VITE_SERVER_URL=http://localhost:3001" > client/.env.local
echo "✅ 环境变量文件已重建 (client/.env.local: VITE_SERVER_URL)"
echo ""

echo "================================"
echo "✅ 初始化完成！"
echo ""
echo "📖 快速开始:"
echo ""
echo "  开发模式（同时启动前端和后端）:"
echo "    npm run dev:all"
echo ""
echo "  或分别启动:"
echo "    npm run dev      # 启动前端 (Vite)"
echo "    npm run server   # 启动 WebSocket 服务器"
echo ""
echo "  自托管（单容器 = 前端 + 协同 WS）:"
echo "    docker compose up -d   # 详见 README「快速开始」"
echo ""
echo "📚 文档:"
echo "  - README.md          完整文档（含快速开始与部署）"
echo ""
echo "🌐 访问地址:"
echo "  - 前端: http://localhost:5173"
echo "  - WebSocket: http://localhost:3001"
echo "  - 健康检查: http://localhost:3001/health"
echo ""
echo "祝使用愉快！🎉"


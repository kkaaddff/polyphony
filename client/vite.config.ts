import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": "/src" },
  },
  // Tauri 打包时走固定端口；Web dev 随机即可
  server: {
    port: Number(process.env.TAURI_DEV_PORT) || 5173,
    strictPort: !!process.env.TAURI_DEV_PORT,
  },
  build: {
    // Tauri webview 加载本地文件，相对路径最稳
    target: "es2022",
  },
});

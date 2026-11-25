/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** dev 时的服务器地址（见 .env.example）；运行时配置优先级见 lib/serverConfig.ts */
  readonly VITE_SERVER_URL?: string;
  /** App 壳内置默认服务器(构建机/CI 注入,不入库,ADR #21) */
  readonly VITE_DEFAULT_SERVER?: string;
  /** 仅排查用:设为 "1" 时在屏幕上叠视口数值面板(见 lib/viewport.ts),默认构建不含。 */
  readonly VITE_VV_DEBUG?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

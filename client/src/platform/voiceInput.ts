// 远程语音输入的平台桥(docs/voice-input.md):
//   Android:打开原生语音输入页(Kotlin 插件 voice-input,EditText 直接观察输入法文本);
//   桌面:把输入通道收到的消息交给 Rust(会话校验 → Unix Socket → 输入法插件)。
// 仅在对应的 Tauri 壳里调用(Web 下 invoke 无接收端)。
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/**
 * Android:打开原生语音输入页。凭据只在进程内传给未导出的 Activity。
 * 页面关闭时 resolve;用户在便签预览里点「转文档」时 `toDoc` 带回便签正文。
 */
export function openNativeVoiceInput(args: {
  serverUrl: string;
  token: string;
  locale: string;
}): Promise<{ toDoc?: string }> {
  return invoke<{ toDoc?: string } | null>("plugin:voice-input|open", args).then((r) => r ?? {});
}

/** 桌面接收端状态(Rust voice_bridge::BridgeState)。 */
export type BridgeState = {
  enabled: boolean;
  /** 本平台是否支持 Unix Socket(Windows 为 false:只能预览) */
  ipcSupported: boolean;
  socketPath: string | null;
  /** 已连接的输入法插件数;0 = 只预览不注入 */
  imeClients: number;
  /** 输入法插件就绪状态(src-tauri/src/ime_setup.rs):已加载 / 需重启输入法 / 系统输入法不是 Fcitx5 / 插件不在 / 非 Linux */
  imeSetup: "ready" | "restart" | "noFcitx" | "missing" | "unsupported";
  active: boolean;
  text: string;
  lastCommitted: string | null;
};

export function bridgeSetEnabled(enabled: boolean): Promise<BridgeState> {
  return invoke<BridgeState>("voice_bridge_set_enabled", { enabled });
}

/** 重启系统输入法(fcitx5),加载随安装包装上 / 升级的插件。 */
export function bridgeRestartIme(): Promise<void> {
  return invoke<void>("voice_bridge_restart_ime");
}

/** 交一条输入通道消息给 Rust;返回要回给手机的消息(JSON 字符串)。 */
export function bridgeMessage(json: string): Promise<string[]> {
  return invoke<string[]>("voice_bridge_message", { json });
}

/** 诊断行(只含元数据)写进桌面壳 stderr;失败静默。 */
export function bridgeTrace(line: string): void {
  void invoke("voice_bridge_trace", { line }).catch(() => {});
}

export function onBridgeState(handler: (state: BridgeState) => void): Promise<() => void> {
  return listen<BridgeState>("voice://state", (e) => handler(e.payload));
}

/** 输入法插件上报的状态(已转成 session.status JSON 字符串),需原样回给手机。 */
export function onBridgeUpstream(handler: (json: string) => void): Promise<() => void> {
  return listen<string>("voice://upstream", (e) => handler(e.payload));
}

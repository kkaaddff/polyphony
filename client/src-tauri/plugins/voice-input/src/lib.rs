//! Android 原生语音输入页。命令 `open` 由 Kotlin 侧(VoiceInputPlugin)直接处理,
//! Rust 侧只负责把 Android 插件注册进 Tauri(docs/voice-input.md)。
#![cfg(target_os = "android")]

use tauri::{
    plugin::{Builder, PluginHandle, TauriPlugin},
    Manager, Runtime,
};

const PLUGIN_IDENTIFIER: &str = "online.hengheng.polyphony.voiceinput";

struct VoiceInput<R: Runtime>(#[allow(dead_code)] PluginHandle<R>);

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("voice-input")
        .setup(|app, api| {
            let handle = api.register_android_plugin(PLUGIN_IDENTIFIER, "VoiceInputPlugin")?;
            app.manage(VoiceInput(handle));
            Ok(())
        })
        .build()
}

// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(target_os = "linux")]
    nvidia_webkit_workaround();
    polyphony_lib::run()
}

/// NVIDIA 专有驱动 + WebKitGTK:Web 进程的 Skia GPU 绘制线程会在 libnvidia-eglcore 里段错误
/// (Ubuntu 24.04 + RTX 4060 真机实踩,WebKitWebProcess SIGSEGV @ SkiaGPUWorker)。
/// Web 进程一崩,页面白屏,跑在 WebView 里的语音输入接收端也随之断开。
/// 检测到 NVIDIA 驱动时改用 CPU 绘制并关闭 DMA-BUF 渲染;用户自己设置过的变量不覆盖。
/// 必须在任何线程启动前调用(此时进程仍是单线程)。
#[cfg(target_os = "linux")]
fn nvidia_webkit_workaround() {
    if !std::path::Path::new("/proc/driver/nvidia/version").exists() {
        return;
    }
    for (key, value) in [
        ("WEBKIT_DISABLE_DMABUF_RENDERER", "1"),
        ("WEBKIT_SKIA_ENABLE_CPU_RENDERING", "1"),
    ] {
        if std::env::var_os(key).is_none() {
            std::env::set_var(key, value);
        }
    }
    eprintln!("[polyvoice] NVIDIA driver detected: WebKit GPU rendering disabled (workaround for SkiaGPUWorker crash)");
}

//! 远程语音输入:本机 Fcitx5 输入法插件的就绪状态(设置页展示 + 一键重启输入法)。
//!
//! 插件随 deb 一起装到系统目录(CI 编译,见 .github/workflows/build.yml、tauri.deb.conf.json),
//! 但**已经在跑的 fcitx5 不会自动加载新装的插件**——首次安装 / 升级后要重启一次输入法。
//! 这里只读 /proc 判断,不改任何系统配置:
//!   - `noFcitx`:当前用户没有在跑的 fcitx5(系统输入法还是 IBus 等,需要用户自己切换)
//!   - `missing`:插件文件不在(源码安装被卸载 / 非 deb 安装)
//!   - `restart`:插件已安装,但在跑的 fcitx5 没有加载它(它的内存映射里没有这个 .so)
//!   - `ready`:fcitx5 已加载插件,插件每 2 秒自动连一次本机 Socket
//!   - `unsupported`:非 Linux
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub const UNSUPPORTED: &str = "unsupported";

#[cfg(target_os = "linux")]
const PLUGIN_FILE: &str = "libpolyphonyvoice.so";
/// 各发行版的 Fcitx5 插件目录(deb 装在 Debian/Ubuntu 的多架构目录;源码安装按 pkg-config 走同一处)
#[cfg(target_os = "linux")]
const ADDON_DIRS: &[&str] = &[
    "/usr/lib/x86_64-linux-gnu/fcitx5",
    "/usr/lib/aarch64-linux-gnu/fcitx5",
    "/usr/lib64/fcitx5",
    "/usr/lib/fcitx5",
    "/usr/local/lib/fcitx5",
];

/// 状态被频繁读取(每条语音消息都会带一份快照),扫 /proc 的结果缓存 2 秒。
static CACHE: Mutex<Option<(Instant, &'static str)>> = Mutex::new(None);

pub fn status() -> &'static str {
    let mut cache = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((at, value)) = *cache {
        if at.elapsed() < Duration::from_secs(2) {
            return value;
        }
    }
    let value = detect();
    *cache = Some((Instant::now(), value));
    value
}

fn invalidate() {
    *CACHE.lock().unwrap_or_else(|e| e.into_inner()) = None;
}

#[cfg(target_os = "linux")]
fn detect() -> &'static str {
    let pids = fcitx_pids();
    if pids.is_empty() {
        return "noFcitx";
    }
    let installed = ADDON_DIRS
        .iter()
        .any(|d| std::path::Path::new(d).join(PLUGIN_FILE).is_file());
    if !installed {
        return "missing";
    }
    let loaded = pids.iter().any(|pid| {
        std::fs::read_to_string(format!("/proc/{pid}/maps"))
            .map(|maps| maps.contains(PLUGIN_FILE))
            .unwrap_or(false)
    });
    if loaded {
        "ready"
    } else {
        "restart"
    }
}

#[cfg(not(target_os = "linux"))]
fn detect() -> &'static str {
    UNSUPPORTED
}

/// 当前用户名下的 fcitx5 进程。
#[cfg(target_os = "linux")]
fn fcitx_pids() -> Vec<u32> {
    use std::os::unix::fs::MetadataExt;
    let Ok(me) = std::fs::metadata("/proc/self").map(|m| m.uid()) else {
        return vec![];
    };
    let Ok(dir) = std::fs::read_dir("/proc") else {
        return vec![];
    };
    dir.filter_map(Result::ok)
        .filter_map(|e| {
            let pid: u32 = e.file_name().to_str()?.parse().ok()?;
            let owner = e.metadata().ok()?.uid();
            let comm = std::fs::read_to_string(format!("/proc/{pid}/comm")).ok()?;
            (owner == me && comm.trim_end() == "fcitx5").then_some(pid)
        })
        .collect()
}

/// 重启输入法让它加载插件:`fcitx5 -r -d` 替换掉当前实例并转入后台(与 fcitx5/install.sh 同一做法)。
/// 继承本进程的图形会话环境(DISPLAY / WAYLAND_DISPLAY / DBUS_SESSION_BUS_ADDRESS)。
#[cfg(target_os = "linux")]
pub fn restart() -> Result<(), String> {
    invalidate();
    std::process::Command::new("fcitx5")
        .args(["-r", "-d"])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("无法启动 fcitx5:{e}"))
}

#[cfg(not(target_os = "linux"))]
pub fn restart() -> Result<(), String> {
    invalidate();
    Err("仅 Linux 支持".into())
}

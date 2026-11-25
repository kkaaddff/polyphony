// 桌面主进程：托盘（最近房间直达 / 新建 / 显示 / 退出）+ WebView 主窗口。
// 最近房间数据由前端（storage.ts）通过 set_recent_rooms 推过来重建菜单；
// 菜单点击以事件发回前端导航（前端在 platform/tray.ts 订阅）。
// 托盘/菜单是桌面专属能力：mobile 目标下 tauri::tray/menu 模块不存在，
// 相关代码整体 cfg(desktop) 门控；移动端注册扫码插件 + Android 根页返回命令；
// iOS 另补 WKWebView 的 JS alert/confirm 原生弹窗（wry 的 UI 代理没实现）。
#[cfg(desktop)]
mod ime_setup;
#[cfg(desktop)]
mod voice_bridge;

#[cfg(target_os = "ios")]
mod ios_js_dialogs;
#[cfg(target_os = "ios")]
mod ios_scroll_pin;

#[cfg(desktop)]
use serde::{Deserialize, Serialize};
#[cfg(desktop)]
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager,
};

/// WebView 推来的最近房间（只取托盘需要的字段）
#[cfg(desktop)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecentRoom {
    pub code: String,
    pub name: String,
}

#[cfg(desktop)]
struct TrayState {
    tray: TrayIcon,
}

#[cfg(desktop)]
fn build_menu(app: &AppHandle, rooms: &[RecentRoom], locale: &str) -> tauri::Result<Menu<tauri::Wry>> {
    // 托盘文案随前端 locale（"zh"/"en"）本地化，缺省回落中文
    let zh = locale != "en";
    let (new_label, unnamed, show_label, quit_label, notes_label) = if zh {
        ("新建房间", "未命名", "显示主窗口", "退出", "语音便签")
    } else {
        ("New room", "Untitled", "Show window", "Quit", "Voice notes")
    };
    let menu = Menu::new(app)?;
    menu.append(&MenuItem::with_id(
        app,
        "notes",
        notes_label,
        true,
        None::<&str>,
    )?)?;
    menu.append(&MenuItem::with_id(
        app,
        "new",
        new_label,
        true,
        None::<&str>,
    )?)?;
    if !rooms.is_empty() {
        menu.append(&PredefinedMenuItem::separator(app)?)?;
        for r in rooms.iter().take(5) {
            let label = if r.name.is_empty() {
                format!("{} · {}", unnamed, r.code)
            } else {
                format!("{} · {}", r.name, r.code)
            };
            menu.append(&MenuItem::with_id(
                app,
                format!("room:{}", r.code),
                label,
                true,
                None::<&str>,
            )?)?;
        }
    }
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(
        app,
        "show",
        show_label,
        true,
        None::<&str>,
    )?)?;
    // 不用 PredefinedMenuItem::quit:它在 Linux 托盘菜单里不受支持,显示为灰色不可点(Ubuntu 真机实踩)
    menu.append(&MenuItem::with_id(
        app,
        "quit",
        quit_label,
        true,
        None::<&str>,
    )?)?;
    Ok(menu)
}

#[cfg(desktop)]
fn show_main(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

/// 前端最近房间/语言变化时调用：重建托盘菜单并同步 tooltip。
#[cfg(desktop)]
#[tauri::command]
fn set_recent_rooms(app: AppHandle, rooms: Vec<RecentRoom>, locale: String) -> Result<(), String> {
    let menu = build_menu(&app, &rooms, &locale).map_err(|e| e.to_string())?;
    let tooltip = "Polyphony";
    let tray = &app.state::<TrayState>().tray;
    tray.set_tooltip(Some(tooltip)).map_err(|e| e.to_string())?;
    tray.set_menu(Some(menu))
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Android 根页返回:把任务退到后台(进程保留),等同 Android 12+ 对启动器根 Activity 的系统默认行为。
/// 不能用 app.exit():Tauri 在 Android 上 finishAffinity 后由 tao 调 std::process::exit,
/// C++ 静态析构与仍在跑的 WebView 线程竞争 → FORTIFY「pthread_mutex_lock called on a destroyed mutex」
/// 原生崩溃;MIUI 随后还会把顶层 Activity 拉起再崩一次,用户看到的就是「再启动闪退一次」(真机实踩)。
#[cfg(target_os = "android")]
#[tauri::command]
fn move_task_to_back(window: tauri::WebviewWindow) -> Result<(), String> {
    window
        .with_webview(|wv| {
            wv.jni_handle().exec(|env, activity, _webview| {
                let _ = env.call_method(activity, "moveTaskToBack", "(Z)Z", &[jni::objects::JValue::Bool(1)]);
            });
        })
        .map_err(|e| e.to_string())
}

/// 开机自启带的参数:由自启项拉起时只驻留托盘(语音接收端照常工作),不弹主窗口。
#[cfg(desktop)]
const AUTOSTART_ARG: &str = "--autostart";

/// 开机自启当前是否已登记(查系统里真实的自启项,不是本地记账)。
#[cfg(desktop)]
#[tauri::command]
fn autostart_get(app: AppHandle) -> Result<bool, String> {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

/// 打开/关闭开机自启;返回设置后的实际状态。
#[cfg(desktop)]
#[tauri::command]
fn autostart_set(app: AppHandle, enabled: bool) -> Result<bool, String> {
    use tauri_plugin_autostart::ManagerExt;
    let launcher = app.autolaunch();
    let res = if enabled { launcher.enable() } else { launcher.disable() };
    res.map_err(|e| e.to_string())?;
    let now = launcher.is_enabled().map_err(|e| e.to_string())?;
    eprintln!("[polyphony] autostart -> {now}");
    Ok(now)
}

/// iOS:前端同步「当前是否全屏钉住页」(见 ios_scroll_pin.rs)。
#[cfg(target_os = "ios")]
#[tauri::command]
fn ios_set_scroll_pinned(pinned: bool) {
    ios_scroll_pin::set_pinned(pinned);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    // 扫码插件仅移动端注册（依赖按 target 门控，见 Cargo.toml）
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        builder = builder.plugin(tauri_plugin_barcode_scanner::init());
    }
    // 原生语音输入页(EditText 观察输入法 → 输入通道),仅 Android
    #[cfg(target_os = "android")]
    {
        builder = builder.plugin(tauri_plugin_voice_input::init());
    }
    #[cfg(target_os = "android")]
    {
        builder = builder.invoke_handler(tauri::generate_handler![move_task_to_back]);
    }

    // 托盘仅桌面
    #[cfg(desktop)]
    {
        // 必须最先注册:第二个实例在这里把参数交给第一个实例后立即退出
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main(app);
        }));
        builder = builder.plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![AUTOSTART_ARG]),
        ));
        builder = builder
            .setup(|app| {
                let handle = app.handle().clone();
                if std::env::args().any(|a| a == AUTOSTART_ARG) {
                    if let Some(win) = handle.get_webview_window("main") {
                        let _ = win.hide();
                    }
                }
                // 启动先用中文占位；前端就绪后 set_recent_rooms 会带实际 locale 重建
                let menu = build_menu(&handle, &[], "zh")?;
                let tray = TrayIconBuilder::with_id("polyphony-tray")
                    .icon(handle.default_window_icon().unwrap().clone())
                    .tooltip("Polyphony")
                    .menu(&menu)
                    .on_menu_event(|app, event| match event.id.as_ref() {
                        "new" => {
                            let _ = app.emit("tray://new-room", ());
                            show_main(app);
                        }
                        "show" => show_main(app),
                        // 关窗口只是隐藏到托盘,真正退出只有这一个入口
                        "quit" => app.exit(0),
                        "notes" => {
                            let _ = app.emit("tray://open-notes", ());
                            show_main(app);
                        }
                        id if id.starts_with("room:") => {
                            let code = id.strip_prefix("room:").unwrap().to_string();
                            let _ = app.emit("tray://open-room", code);
                            show_main(app);
                        }
                        _ => {}
                    })
                    .on_tray_icon_event(|tray, event| {
                        if let TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        } = event
                        {
                            show_main(tray.app_handle());
                        }
                    })
                    .build(app)?;
                app.manage(TrayState { tray });
                Ok(())
            })
            // 远程语音输入接收端(默认关闭,前端按本机开关调用 voice_bridge_set_enabled)
            .manage(voice_bridge::VoiceBridge::default())
            .invoke_handler(tauri::generate_handler![
                set_recent_rooms,
                voice_bridge::voice_bridge_set_enabled,
                voice_bridge::voice_bridge_status,
                voice_bridge::voice_bridge_message,
                voice_bridge::voice_bridge_trace,
                voice_bridge::voice_bridge_restart_ime,
                autostart_get,
                autostart_set
            ]);
    }

    // iOS:给主窗口的 WKWebView 换上转发式 UI 代理,补齐 JS alert/confirm(见 ios_js_dialogs.rs)。
    // 与桌面的 setup 不冲突:那段整体 cfg(desktop),iOS 上不参与编译。
    #[cfg(target_os = "ios")]
    {
        use tauri::Manager;
        builder = builder.invoke_handler(tauri::generate_handler![ios_set_scroll_pinned]);
        builder = builder.setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                let handle = app.handle().clone();
                // 兜底定时器:独立线程睡等后回主线程执行(本 crate 不直接依赖异步运行时的定时器)
                let schedule: ios_js_dialogs::Scheduler = std::sync::Arc::new(move |delay, task| {
                    let handle = handle.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(delay);
                        let _ = handle.run_on_main_thread(task);
                    });
                });
                let _ = window.with_webview(move |webview| unsafe {
                    let _ = ios_js_dialogs::install(
                        webview.inner().cast(),
                        webview.view_controller().cast(),
                        schedule,
                    );
                    // 键盘弹起时钉住滚动视图(见 ios_scroll_pin.rs)
                    let _ = ios_scroll_pin::install(webview.inner().cast());
                });
            }
            Ok(())
        });
    }

    // 点窗口的 × 只是隐藏到托盘:语音输入接收端要常驻后台(退出走托盘菜单「退出」)
    #[cfg(desktop)]
    {
        builder = builder.on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        });
    }

    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// 桌面主进程：托盘（最近房间直达 / 新建 / 显示 / 退出）+ WebView 主窗口。
// 最近房间数据由前端（storage.ts）通过 set_recent_rooms 推过来重建菜单；
// 菜单点击以事件发回前端导航（前端在 platform/tray.ts 订阅）。
// 托盘/菜单是桌面专属能力：mobile 目标下 tauri::tray/menu 模块不存在，
// 相关代码整体 cfg(desktop) 门控；移动端仅注册扫码插件。
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
    let (new_label, unnamed, show_label, quit_label) = if zh {
        ("新建房间", "未命名", "显示主窗口", "退出")
    } else {
        ("New room", "Untitled", "Show window", "Quit")
    };
    let menu = Menu::new(app)?;
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
    menu.append(&PredefinedMenuItem::quit(app, Some(quit_label))?)?;
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    // 扫码插件仅移动端注册（依赖按 target 门控，见 Cargo.toml）
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        builder = builder.plugin(tauri_plugin_barcode_scanner::init());
    }

    // 托盘仅桌面
    #[cfg(desktop)]
    {
        builder = builder
            .setup(|app| {
                let handle = app.handle().clone();
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
            .invoke_handler(tauri::generate_handler![set_recent_rooms]);
    }

    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

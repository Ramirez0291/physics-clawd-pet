use std::fs;
use std::path::PathBuf;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::utils::config::BackgroundThrottlingPolicy;
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder,
};

const OVERLAY: &str = "overlay";
const DEBUG: &str = "debug";

/// 覆盖层：铺满主屏的工作区（不含任务栏）。
/// 故意不等于整块屏幕，避免被系统当成全屏程序（压住任务栏、吞掉通知）。
fn create_overlay(app: &AppHandle) -> tauri::Result<()> {
    let monitor = match app.primary_monitor()? {
        Some(m) => m,
        None => app
            .available_monitors()?
            .into_iter()
            .next()
            .expect("no monitor found"),
    };
    let area = *monitor.work_area();

    let win = WebviewWindowBuilder::new(app, OVERLAY, WebviewUrl::App("index.html".into()))
        .title("Clawd")
        .transparent(true)
        .decorations(false)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        // WS_EX_NOACTIVATE：点宠物不会抢走当前窗口的焦点
        .focusable(false)
        .visible(false)
        .background_throttling(BackgroundThrottlingPolicy::Disabled)
        .build()?;
    win.set_position(PhysicalPosition::new(area.position.x, area.position.y))?;
    win.set_size(PhysicalSize::new(area.size.width, area.size.height))?;
    win.set_ignore_cursor_events(true)?;
    win.show()?;
    Ok(())
}

fn show_debug(app: &AppHandle) -> tauri::Result<()> {
    if let Some(w) = app.get_webview_window(DEBUG) {
        w.unminimize()?;
        w.show()?;
        w.set_focus()?;
        return Ok(());
    }
    WebviewWindowBuilder::new(app, DEBUG, WebviewUrl::App("debug.html".into()))
        .title("Clawd 调试面板")
        .inner_size(460.0, 860.0)
        .min_inner_size(360.0, 400.0)
        .build()?;
    Ok(())
}

fn tuning_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("tuning.json"))
}

#[tauri::command]
fn load_tuning(app: AppHandle) -> Result<Option<serde_json::Value>, String> {
    let path = tuning_path(&app)?;
    if !path.exists() {
        return Ok(None);
    }
    let text = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&text).map(Some).map_err(|e| e.to_string())
}

/// 返回保存的路径，调试面板会显示出来方便找到文件。
#[tauri::command]
fn save_tuning(app: AppHandle, tuning: serde_json::Value) -> Result<String, String> {
    let path = tuning_path(&app)?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(&tuning).map_err(|e| e.to_string())?;
    fs::write(&path, text).map_err(|e| e.to_string())?;
    Ok(path.display().to_string())
}

#[tauri::command]
fn open_debug(app: AppHandle) -> Result<(), String> {
    show_debug(&app).map_err(|e| e.to_string())
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let debug = MenuItem::with_id(app, "debug", "调试面板", true, None::<&str>)?;
    let reset = MenuItem::with_id(app, "reset", "把 Clawd 叫回来", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&debug, &reset, &sep, &quit])?;

    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip("Clawd")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "debug" => {
                let _ = show_debug(app);
            }
            "reset" => {
                let _ = app.emit("debug-cmd", serde_json::json!({ "cmd": "reset" }));
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let _ = show_debug(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![load_tuning, save_tuning, open_debug])
        .setup(|app| {
            let handle = app.handle();
            create_overlay(handle)?;
            build_tray(handle)?;
            // 开发时直接打开调试面板，调手感最常用
            #[cfg(debug_assertions)]
            show_debug(handle)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

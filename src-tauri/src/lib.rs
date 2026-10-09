use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::utils::config::BackgroundThrottlingPolicy;
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, State, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder,
};

#[cfg(windows)]
mod desktop;
#[cfg(windows)]
mod watcher;

#[cfg(not(windows))]
mod watcher {
    use std::sync::{Arc, Mutex};
    pub const OVERLAY: &str = "overlay";
    #[derive(Default)]
    pub struct DeskState {
        pub hit: Option<[f64; 4]>,
        pub dragging: bool,
        pub carrier: Option<isize>,
        pub manual_hidden: bool,
        pub resync: bool,
    }
    pub type Shared = Arc<Mutex<DeskState>>;
}

use watcher::{DeskState, Shared, OVERLAY};

const DEBUG: &str = "debug";

/// 覆盖层：铺满主屏的工作区（不含任务栏）。
/// 故意不等于整块屏幕，避免被系统当成全屏程序（压住任务栏、吞掉通知）。
fn create_overlay(app: &AppHandle) -> tauri::Result<WebviewWindow> {
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

    #[cfg(windows)]
    {
        let rect = desktop::Rect {
            left: area.position.x,
            top: area.position.y,
            right: area.position.x + area.size.width as i32,
            bottom: area.position.y + area.size.height as i32,
        };
        let hwnd = win.hwnd()?.0 as isize;
        let shared = app.state::<Shared>().inner().clone();
        watcher::spawn(app.clone(), shared, hwnd, rect);
    }
    Ok(win)
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

// ---------- 覆盖层 → 观察线程 ----------

/// 宠物的可点击区域（覆盖层 CSS 像素），None 表示没有
#[tauri::command]
fn desk_set_hit(state: State<Shared>, rect: Option<[f64; 4]>) {
    state.lock().unwrap().hit = rect;
}

#[tauri::command]
fn desk_set_dragging(state: State<Shared>, on: bool) {
    state.lock().unwrap().dragging = on;
}

/// 宠物站在哪个窗口上（窗口句柄），None 表示没站在窗口上
#[tauri::command]
fn desk_set_carrier(state: State<Shared>, id: Option<i64>) {
    state.lock().unwrap().carrier = id.map(|v| v as isize);
}

/// 前端（重新）加载完成，请把当前状态全部重发
#[tauri::command]
fn desk_ready(state: State<Shared>) {
    state.lock().unwrap().resync = true;
}

struct HideItem(MenuItem<tauri::Wry>);

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let debug = MenuItem::with_id(app, "debug", "调试面板", true, None::<&str>)?;
    let reset = MenuItem::with_id(app, "reset", "把 Clawd 叫回来", true, None::<&str>)?;
    let hide = MenuItem::with_id(app, "hide", "隐藏 Clawd", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&debug, &reset, &hide, &sep, &quit])?;
    app.manage(HideItem(hide));

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
            "hide" => {
                let hidden = {
                    let state = app.state::<Shared>();
                    let mut s = state.lock().unwrap();
                    s.manual_hidden = !s.manual_hidden;
                    s.manual_hidden
                };
                let item = &app.state::<HideItem>().0;
                let _ = item.set_text(if hidden { "显示 Clawd" } else { "隐藏 Clawd" });
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
        .manage::<Shared>(Arc::new(Mutex::new(DeskState::default())))
        .invoke_handler(tauri::generate_handler![
            load_tuning,
            save_tuning,
            open_debug,
            desk_set_hit,
            desk_set_dragging,
            desk_set_carrier,
            desk_ready
        ])
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

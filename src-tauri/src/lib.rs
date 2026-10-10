use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::utils::config::BackgroundThrottlingPolicy;
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, State, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder,
};

#[cfg(windows)]
mod desktop;
#[cfg(windows)]
mod input;
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
        pub input_resync: bool,
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
        watcher::spawn(app.clone(), shared.clone(), hwnd, rect);
        input::spawn(app.clone(), shared, hwnd);
    }
    Ok(win)
}

/// 托盘菜单和窗口标题的文字：系统界面语言是中文就用中文，否则英文
struct Texts {
    debug_title: &'static str,
    debug: &'static str,
    /// 下面三个里的 {name} 换成当前形象的名字
    reset: &'static str,
    hide: &'static str,
    show: &'static str,
    character: &'static str,
    size: &'static str,
    bigger: &'static str,
    smaller: &'static str,
    /// 与 SIZE_PRESETS 一一对应
    presets: [&'static str; 4],
    quit: &'static str,
}

const ZH: Texts = Texts {
    debug_title: "Clawd 调教面板",
    debug: "调教面板",
    reset: "把 {name} 叫回来",
    hide: "隐藏 {name}",
    show: "显示 {name}",
    character: "形象",
    size: "大小",
    bigger: "放大",
    smaller: "缩小",
    presets: ["小", "中（默认）", "大", "特大"],
    quit: "退出",
};

const EN: Texts = Texts {
    debug_title: "Clawd Tuning Panel",
    debug: "Tuning panel",
    reset: "Bring {name} back",
    hide: "Hide {name}",
    show: "Show {name}",
    character: "Character",
    size: "Size",
    bigger: "Bigger",
    smaller: "Smaller",
    presets: ["Small", "Medium (default)", "Large", "Extra large"],
    quit: "Quit",
};

#[cfg(windows)]
fn system_is_chinese() -> bool {
    // LANGID 的低 10 位是主语言；0x04 = LANG_CHINESE（简体、繁体都算）
    let id = unsafe { windows::Win32::Globalization::GetUserDefaultUILanguage() };
    id & 0x3ff == 0x04
}

#[cfg(not(windows))]
fn system_is_chinese() -> bool {
    std::env::var("LANG").is_ok_and(|l| l.starts_with("zh"))
}

fn texts() -> &'static Texts {
    static LANG: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    if *LANG.get_or_init(system_is_chinese) {
        &ZH
    } else {
        &EN
    }
}

fn show_debug(app: &AppHandle) -> tauri::Result<()> {
    if let Some(w) = app.get_webview_window(DEBUG) {
        w.unminimize()?;
        w.show()?;
        w.set_focus()?;
        return Ok(());
    }
    WebviewWindowBuilder::new(app, DEBUG, WebviewUrl::App("debug.html".into()))
        .title(texts().debug_title)
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

/// 返回保存的路径，调教面板会显示出来方便找到文件。
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
    let mut s = state.lock().unwrap();
    s.resync = true;
    s.input_resync = true;
}

/// 托盘菜单里要随形象/状态改文字的几项
struct TrayItems {
    reset: MenuItem<tauri::Wry>,
    hide: MenuItem<tauri::Wry>,
    skins: Submenu<tauri::Wry>,
    /// 当前形象的名字
    name: Mutex<String>,
}

impl TrayItems {
    fn sync_labels(&self, app: &AppHandle, hidden: bool) -> tauri::Result<()> {
        let t = texts();
        let name = self.name.lock().unwrap().clone();
        self.reset.set_text(t.reset.replace("{name}", &name))?;
        self.hide.set_text((if hidden { t.show } else { t.hide }).replace("{name}", &name))?;
        if let Some(tray) = app.tray_by_id("main") {
            tray.set_tooltip(Some(&name))?;
        }
        Ok(())
    }
}

#[derive(serde::Deserialize)]
struct SkinInfo {
    id: String,
    name: String,
}

/// 覆盖层告诉托盘有哪些形象、当前是哪个（菜单项 id 是 "skin:<id>"）
#[tauri::command]
fn tray_set_skins(
    app: AppHandle,
    state: State<Shared>,
    skins: Vec<SkinInfo>,
    current: String,
) -> Result<(), String> {
    let Some(items) = app.try_state::<TrayItems>() else {
        return Ok(());
    };
    let err = |e: tauri::Error| e.to_string();
    for old in items.skins.items().map_err(err)? {
        items.skins.remove(&old).map_err(err)?;
    }
    for s in &skins {
        let id = format!("skin:{}", s.id);
        let item = CheckMenuItem::with_id(&app, id, &s.name, true, s.id == current, None::<&str>).map_err(err)?;
        items.skins.append(&item).map_err(err)?;
    }
    if let Some(s) = skins.iter().find(|s| s.id == current) {
        *items.name.lock().unwrap() = s.name.clone();
    }
    let hidden = state.lock().unwrap().manual_hidden;
    items.sync_labels(&app, hidden).map_err(err)
}

/// 托盘"大小"菜单的预设（px/格），id 是 "size:<值>"；名字在 Texts::presets 里
const SIZE_PRESETS: [f64; 4] = [4.0, 6.0, 9.0, 12.0];

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let t = texts();
    // 形象列表和带名字的菜单文字等覆盖层加载好后由 tray_set_skins 填上
    let name = "Clawd";
    let debug = MenuItem::with_id(app, "debug", t.debug, true, None::<&str>)?;
    let reset = MenuItem::with_id(app, "reset", t.reset.replace("{name}", name), true, None::<&str>)?;
    let hide = MenuItem::with_id(app, "hide", t.hide.replace("{name}", name), true, None::<&str>)?;
    let skins = Submenu::with_id(app, "skins", t.character, true)?;
    let size = Submenu::with_id(app, "size", t.size, true)?;
    size.append(&MenuItem::with_id(app, "size+", t.bigger, true, None::<&str>)?)?;
    size.append(&MenuItem::with_id(app, "size-", t.smaller, true, None::<&str>)?)?;
    size.append(&PredefinedMenuItem::separator(app)?)?;
    for (label, scale) in t.presets.iter().zip(SIZE_PRESETS) {
        size.append(&MenuItem::with_id(app, format!("size:{scale}"), *label, true, None::<&str>)?)?;
    }
    let sep = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", t.quit, true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&debug, &reset, &hide, &skins, &size, &sep, &quit])?;
    app.manage(TrayItems {
        reset,
        hide,
        skins,
        name: Mutex::new(name.into()),
    });

    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip(name)
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
                let _ = app.state::<TrayItems>().sync_labels(app, hidden);
            }
            "quit" => app.exit(0),
            // 覆盖层负责夹到范围内并保存
            "size+" => {
                let _ = app.emit("pet-size", serde_json::json!({ "delta": 1.0 }));
            }
            "size-" => {
                let _ = app.emit("pet-size", serde_json::json!({ "delta": -1.0 }));
            }
            id => {
                if let Some(scale) = id.strip_prefix("size:").and_then(|v| v.parse::<f64>().ok()) {
                    let _ = app.emit("pet-size", serde_json::json!({ "scale": scale }));
                } else if let Some(skin) = id.strip_prefix("skin:") {
                    // 覆盖层换好后会调 tray_set_skins 更新勾选
                    let _ = app.emit("pet-skin", serde_json::json!({ "id": skin }));
                }
            }
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
            desk_ready,
            tray_set_skins
        ])
        .setup(|app| {
            let handle = app.handle();
            // 托盘先建好：覆盖层一加载就会调 tray_set_skins
            build_tray(handle)?;
            create_overlay(handle)?;
            // 开发时直接打开调教面板，调手感最常用
            #[cfg(debug_assertions)]
            show_debug(handle)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

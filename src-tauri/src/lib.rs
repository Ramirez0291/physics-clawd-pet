use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use tauri::menu::{CheckMenuItem, IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::utils::config::BackgroundThrottlingPolicy;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

mod assist;
mod claude;
mod agy;
mod codex;
mod desktop;
mod dsh;
mod input;
mod lang;
mod platform;
mod watcher;

use watcher::{DeskState, Shared, OVERLAY};

const DEBUG: &str = "debug";

/// 不启动宠物、只做一件事就退出的命令行用法。返回 Some(退出码) 表示已经处理了。
pub fn cli(args: &[String]) -> Option<i32> {
    if args.iter().any(|a| a == "--clawd-pet-hook" || a == codex::MARKER) {
        return Some(claude::hook_main(args));
    }
    if args.iter().any(|a| a == agy::MARKER) {
        return Some(agy::hook_main(args));
    }
    if args.iter().any(|a| a == "--remove-claude-hooks") {
        // 卸载程序调用：把装进 Claude Code 设置里的 hooks 删掉
        return Some(if claude::uninstall().is_ok() { 0 } else { 1 });
    }
    if args.iter().any(|a| a == "--remove-codex-hooks") {
        return Some(if codex::uninstall().is_ok() { 0 } else { 1 });
    }
    if args.iter().any(|a| a == "--remove-agy-hooks") {
        return Some(if agy::uninstall().is_ok() { 0 } else { 1 });
    }
    if args.iter().any(|a| a == "--remove-dsh-plugin") {
        return Some(if dsh::uninstall().is_ok() { 0 } else { 1 });
    }
    None
}

const ASSISTANT: &str = "assistant";

/// 覆盖层：铺满所有屏幕的工作区（不含任务栏）的外接矩形，宠物可以在几块屏幕之间走来走去。
/// 故意不盖任务栏，避免被系统当成全屏程序（压住任务栏、吞掉通知）。
/// 之后屏幕变了、某块屏幕上开了全屏程序，由观察线程重新摆。
fn create_overlay(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let layout = match desktop::layout(&platform::screens(), &[]) {
        Some(l) => l,
        // 系统没报出屏幕（不该发生）：退回 Tauri 给的主屏
        None => {
            let monitor = match app.primary_monitor()? {
                Some(m) => m,
                None => app.available_monitors()?.into_iter().next().expect("no monitor found"),
            };
            let (pos, size) = (monitor.work_area().position, monitor.work_area().size);
            let work = desktop::Rect {
                left: pos.x,
                top: pos.y,
                right: pos.x + size.width as i32,
                bottom: pos.y + size.height as i32,
            };
            desktop::Layout { rect: work, screens: vec![desktop::Screen { monitor: work, work, primary: true }] }
        }
    };
    #[cfg(target_os = "macos")]
    let layout = desktop::Layout { rect: desktop::viewport(&layout.screens, layout.rect, None), ..layout };

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
        // macOS：程序不在前台时，第一下点击也直接交给宠物（不然第一下只是把程序切到前台）
        .accept_first_mouse(true)
        .build()?;
    // 先做平台设置（Windows：拦住跨屏缩放变化时的自动改大小），再摆位置
    platform::prepare_overlay(&win)?;
    platform::place_overlay(&win, layout.rect)?;
    win.set_ignore_cursor_events(true)?;
    win.show()?;

    let id = platform::window_id(&win)?;
    let shared = app.state::<Shared>().inner().clone();
    watcher::spawn(app.clone(), shared.clone(), id, layout);
    input::spawn(app.clone(), shared, id);
    Ok(win)
}

/// 托盘菜单和窗口标题的文字：系统界面语言是中文 / 日文就用中文 / 日文，否则英文
struct Texts {
    debug_title: &'static str,
    debug: &'static str,
    assistant_title: &'static str,
    assistant: &'static str,
    pick_ics: &'static str,
    ics_filter: &'static str,
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
    /// 只在要用户授权的平台（macOS）出现
    avoid_input: &'static str,
    quit: &'static str,
}

const ZH: Texts = Texts {
    debug_title: "Clawd 调教面板",
    debug: "调教面板",
    assistant_title: "Clawd 小助手",
    assistant: "小助手（待办 / 日历 / 提醒）",
    pick_ics: "选择日历文件",
    ics_filter: "iCalendar 日历 (*.ics)",
    reset: "把 {name} 叫回来",
    hide: "隐藏 {name}",
    show: "显示 {name}",
    character: "形象",
    size: "大小",
    bigger: "放大",
    smaller: "缩小",
    presets: ["小", "中（默认）", "大", "特大"],
    avoid_input: "避开正在输入的文本框…",
    quit: "退出",
};

const EN: Texts = Texts {
    debug_title: "Clawd Tuning Panel",
    debug: "Tuning panel",
    assistant_title: "Clawd Assistant",
    assistant: "Assistant (to-dos / calendar / reminders)",
    pick_ics: "Choose a calendar file",
    ics_filter: "iCalendar (*.ics)",
    reset: "Bring {name} back",
    hide: "Hide {name}",
    show: "Show {name}",
    character: "Character",
    size: "Size",
    bigger: "Bigger",
    smaller: "Smaller",
    presets: ["Small", "Medium (default)", "Large", "Extra large"],
    avoid_input: "Avoid the text box I'm typing in…",
    quit: "Quit",
};

// 大阪の蟹：宠物说的话是关西腔，菜单是普通的礼貌体
const JA: Texts = Texts {
    debug_title: "Clawd 調整パネル",
    debug: "調整パネル",
    assistant_title: "Clawd アシスタント",
    assistant: "アシスタント（ToDo / カレンダー / 通知）",
    pick_ics: "カレンダーファイルを選択",
    ics_filter: "iCalendar (*.ics)",
    reset: "{name}を呼び戻す",
    hide: "{name}を隠す",
    show: "{name}を表示",
    character: "キャラクター",
    size: "サイズ",
    bigger: "大きく",
    smaller: "小さく",
    presets: ["小", "中（標準）", "大", "特大"],
    avoid_input: "入力中のテキスト欄を避ける…",
    quit: "終了",
};

fn texts() -> &'static Texts {
    match lang::lang() {
        lang::Lang::Zh => &ZH,
        lang::Lang::Ja => &JA,
        lang::Lang::En => &EN,
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

fn show_assistant(app: &AppHandle) -> tauri::Result<()> {
    if let Some(w) = app.get_webview_window(ASSISTANT) {
        w.unminimize()?;
        w.show()?;
        w.set_focus()?;
        return Ok(());
    }
    WebviewWindowBuilder::new(app, ASSISTANT, WebviewUrl::App("assistant.html".into()))
        .title(texts().assistant_title)
        .inner_size(480.0, 680.0)
        .min_inner_size(380.0, 420.0)
        .build()?;
    Ok(())
}

/// 配置目录（%APPDATA%\com.physicsclawdpet.desktop）里的一个 JSON 文件
fn config_path(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    Ok(dir.join(name))
}

fn load_json(app: &AppHandle, name: &str) -> Result<Option<serde_json::Value>, String> {
    let path = config_path(app, name)?;
    if !path.exists() {
        return Ok(None);
    }
    let text = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&text).map(Some).map_err(|e| e.to_string())
}

/// 先写临时文件再改名：写到一半退出也不会把原来的文件弄坏
fn save_json(app: &AppHandle, name: &str, value: &serde_json::Value) -> Result<PathBuf, String> {
    let path = config_path(app, name)?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, text).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(path)
}

#[tauri::command]
fn load_tuning(app: AppHandle) -> Result<Option<serde_json::Value>, String> {
    load_json(&app, "tuning.json")
}

/// 返回保存的路径，调教面板会显示出来方便找到文件。
#[tauri::command]
fn save_tuning(app: AppHandle, tuning: serde_json::Value) -> Result<String, String> {
    save_json(&app, "tuning.json", &tuning).map(|p| p.display().to_string())
}

// ---------- 小助手 ----------

// ---------- Claude Code 联动 ----------

/// 桥接令牌：第一次用时生成，存在配置目录里（hooks 的命令行里也带着它）
fn bridge_token(app: &AppHandle) -> String {
    if let Ok(Some(v)) = load_json(app, "claude-bridge.json") {
        if let Some(t) = v.get("token").and_then(|t| t.as_str()).filter(|t| t.len() >= 16) {
            return t.to_string();
        }
    }
    let token = claude::new_token();
    let _ = save_json(app, "claude-bridge.json", &serde_json::json!({ "token": token }));
    token
}

#[derive(serde::Serialize)]
struct CcStatus {
    hooks: claude::HookStatus,
    port: u16,
    /// 桥接服务没起来的原因
    bridge_error: Option<String>,
    /// 上一次收到 Claude Code 事件的时间（ms，0 = 还没有）
    last_event: u64,
}

#[tauri::command]
fn cc_status(bridge: State<Arc<claude::Bridge>>, token: State<BridgeToken>) -> CcStatus {
    CcStatus {
        hooks: claude::status(&token.0),
        port: claude::PORT,
        bridge_error: bridge.error.lock().unwrap().clone(),
        last_event: bridge.last_event.load(std::sync::atomic::Ordering::Relaxed),
    }
}

#[tauri::command]
fn cc_install(token: State<BridgeToken>, permission: bool) -> Result<(), String> {
    claude::install(&token.0, permission)
}

#[tauri::command]
fn cc_uninstall() -> Result<(), String> {
    claude::uninstall()
}

#[tauri::command]
fn codex_status(bridge: State<Arc<claude::Bridge>>, token: State<BridgeToken>) -> CcStatus {
    CcStatus {
        hooks: codex::status(&token.0),
        port: claude::PORT,
        bridge_error: bridge.error.lock().unwrap().clone(),
        last_event: bridge.last_codex_event.load(std::sync::atomic::Ordering::Relaxed),
    }
}

#[tauri::command]
fn codex_install(token: State<BridgeToken>, permission: bool) -> Result<(), String> {
    codex::install(&token.0, permission)
}

#[tauri::command]
fn codex_uninstall() -> Result<(), String> {
    codex::uninstall()
}

#[tauri::command]
fn dsh_status(bridge: State<Arc<claude::Bridge>>, token: State<BridgeToken>) -> CcStatus {
    CcStatus {
        hooks: dsh::status(&token.0),
        port: claude::PORT,
        bridge_error: bridge.error.lock().unwrap().clone(),
        last_event: bridge.last_dsh_event.load(std::sync::atomic::Ordering::Relaxed),
    }
}

#[tauri::command]
fn dsh_install(token: State<BridgeToken>, permission: bool) -> Result<(), String> {
    dsh::install(&token.0, permission)
}

#[tauri::command]
fn dsh_uninstall() -> Result<(), String> {
    dsh::uninstall()
}

#[tauri::command]
fn agy_status(bridge: State<Arc<claude::Bridge>>, token: State<BridgeToken>) -> CcStatus {
    CcStatus {
        hooks: agy::status(&token.0),
        port: claude::PORT,
        bridge_error: bridge.error.lock().unwrap().clone(),
        last_event: bridge.last_agy_event.load(std::sync::atomic::Ordering::Relaxed),
    }
}

#[tauri::command]
fn agy_install(token: State<BridgeToken>, permission: bool) -> Result<(), String> {
    agy::install(&token.0, permission)
}

#[tauri::command]
fn agy_uninstall() -> Result<(), String> {
    agy::uninstall()
}

/// 权限气泡上的按钮：allow / deny / pass（交还终端）
#[tauri::command]
fn cc_decide(bridge: State<Arc<claude::Bridge>>, id: u64, behavior: String) -> bool {
    bridge.decide(id, &behavior)
}

struct BridgeToken(String);

#[tauri::command]
fn load_assistant(app: AppHandle) -> Result<Option<serde_json::Value>, String> {
    load_json(&app, "assistant.json")
}

/// 保存后广播给所有窗口（覆盖层跑提醒、小助手窗口显示）
#[tauri::command]
fn save_assistant(app: AppHandle, data: serde_json::Value) -> Result<(), String> {
    save_json(&app, "assistant.json", &data)?;
    app.emit("assistant-data", data).map_err(|e| e.to_string())
}

/// 同 open_debug，必须是 async
#[tauri::command]
async fn open_assistant(app: AppHandle) -> Result<(), String> {
    show_assistant(&app).map_err(|e| e.to_string())
}

/// 距离上一次键盘/鼠标操作多少毫秒
#[tauri::command]
fn desk_idle_ms() -> u64 {
    platform::idle_ms()
}

/// 下载日历订阅（网页里直接 fetch 会被跨域拦住）
#[tauri::command]
async fn fetch_text(url: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || platform::http_get(&url).map(assist::decode_text))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    fs::read(&path).map(assist::decode_text).map_err(|e| e.to_string())
}

/// 选一个本地 .ics 文件，取消返回 None
#[tauri::command]
async fn pick_ics_file(app: AppHandle) -> Option<String> {
    let owner = app
        .get_webview_window(ASSISTANT)
        .and_then(|w| platform::window_id(&w).ok());
    let t = texts();
    let (title, filter) = (t.pick_ics.to_string(), t.ics_filter.to_string());
    tauri::async_runtime::spawn_blocking(move || platform::pick_ics(owner, title, filter))
        .await
        .ok()
        .flatten()
}

/// 在命令里建窗口必须是 async：同步命令跑在主线程上，Windows 下建 WebView 会死锁（wry#583）
#[tauri::command]
async fn open_debug(app: AppHandle) -> Result<(), String> {
    show_debug(&app).map_err(|e| e.to_string())
}

// ---------- 覆盖层 → 观察线程 ----------

/// 可点击区域（覆盖层 CSS 像素）：第一个是宠物，后面是气泡之类；空表示没有
#[tauri::command]
fn desk_set_hits(state: State<Shared>, rects: Vec<[f64; 4]>, revision: u64) {
    let mut s = state.lock().unwrap();
    // A frame sent just before a display transition uses the previous origin.
    if revision == s.geometry_revision {
        s.hits = rects;
    }
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
    /// "躲开输入框"：打勾 = 有系统权限。不需要授权的平台没有这一项
    input: Option<CheckMenuItem<tauri::Wry>>,
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
fn tray_set_skins(app: AppHandle, state: State<Shared>, skins: Vec<SkinInfo>, current: String) -> Result<(), String> {
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

/// 托盘里"躲开输入框"的勾跟着系统权限走（输入框检测线程发现权限变了也会调）
pub(crate) fn sync_input_permission(app: &AppHandle) {
    let (Some(items), Some(granted)) = (app.try_state::<TrayItems>(), platform::input_permission()) else {
        return;
    };
    if let Some(item) = &items.input {
        let _ = item.set_checked(granted);
    }
}

/// 托盘"大小"菜单的预设（px/格），id 是 "size:<值>"；名字在 Texts::presets 里
const SIZE_PRESETS: [f64; 4] = [4.0, 6.0, 9.0, 12.0];

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let t = texts();
    // 形象列表和带名字的菜单文字等覆盖层加载好后由 tray_set_skins 填上
    let name = "Clawd";
    let assistant = MenuItem::with_id(app, "assistant", t.assistant, true, None::<&str>)?;
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
    let input = platform::input_permission()
        .map(|granted| CheckMenuItem::with_id(app, "input", t.avoid_input, true, granted, None::<&str>))
        .transpose()?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", t.quit, true, None::<&str>)?;
    let mut items: Vec<&dyn IsMenuItem<tauri::Wry>> = vec![&assistant, &debug, &reset, &hide, &skins, &size];
    if let Some(input) = &input {
        items.push(input);
    }
    items.extend([&sep as &dyn IsMenuItem<tauri::Wry>, &quit]);
    let menu = Menu::with_items(app, &items)?;
    app.manage(TrayItems { reset, hide, skins, input, name: Mutex::new(name.into()) });

    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip(name)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "assistant" => {
                let _ = show_assistant(app);
            }
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
            "input" => {
                platform::request_input_permission();
                // 点一下勾会自己翻转：先改回真实状态，用户在系统设置里打开后输入框检测线程会更新
                sync_input_permission(app);
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
    // 系统会自己上色的单色图标（macOS 菜单栏），没有就用应用图标
    if let Some(icon) = platform::tray_template_icon() {
        builder = builder.icon(icon).icon_as_template(true);
    } else if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    if !platform::single_instance() {
        return;
    }
    tauri::Builder::default()
        .manage::<Shared>(Arc::new(Mutex::new(DeskState::default())))
        .invoke_handler(tauri::generate_handler![
            load_tuning,
            save_tuning,
            open_debug,
            desk_set_hits,
            desk_set_dragging,
            desk_set_carrier,
            desk_ready,
            tray_set_skins,
            load_assistant,
            save_assistant,
            open_assistant,
            desk_idle_ms,
            fetch_text,
            read_text_file,
            pick_ics_file,
            cc_status,
            cc_install,
            cc_uninstall,
            codex_status,
            codex_install,
            codex_uninstall,
            dsh_status,
            dsh_install,
            dsh_uninstall,
            agy_status,
            agy_install,
            agy_uninstall,
            cc_decide
        ])
        .setup(|app| {
            let handle = app.handle();
            // Claude Code 联动：本机桥接服务；装过 hooks 但程序换了位置（开发版 ↔ 安装版）就自动更新
            let token = bridge_token(handle);
            let bridge = claude::Bridge::new(token.clone());
            bridge.start(handle.clone());
            let st = claude::status(&token);
            if st.installed && !st.current {
                let _ = claude::install(&token, st.permission);
            }
            let st = codex::status(&token);
            if st.installed && !st.current {
                let _ = codex::install(&token, st.permission);
            }
            let st = dsh::status(&token);
            if st.installed && !st.current {
                let _ = dsh::install(&token, st.permission);
            }
            let st = agy::status(&token);
            if st.installed && !st.current {
                let _ = agy::install(&token, st.permission);
            }
            app.manage(bridge);
            app.manage(BridgeToken(token));
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

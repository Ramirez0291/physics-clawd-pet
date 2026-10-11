//! Claude Code 联动。
//!
//! Claude Code 的 hooks 会运行 `clawd-pet.exe --clawd-pet-hook <端口> <令牌>`（就是本程序，换了个身份；
//! 用 exec 形式直接启动、不经过 shell，路径里有空格或者日文都没关系），
//! 它从 stdin 读事件 JSON，精简后通过本机 TCP 交给正在运行的宠物，然后马上退出。
//! 宠物没开就连不上，静默退出（不在 Claude Code 里刷 hook 报错）。
//!
//! 权限请求（PermissionRequest）例外：hook 会一直等，直到用户在宠物的气泡上点了允许/拒绝，
//! 或者在终端里自己处理了（Claude Code 结束这个 hook，连接断开，气泡跟着收起来）。
//!
//! 协议：一行 JSON 请求，一行回复。只监听 127.0.0.1，并且要带令牌，网页之类的本地访问进不来。

use std::collections::HashMap;
use std::hash::{BuildHasher, Hasher};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Shutdown, SocketAddr, TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Map, Value};
use tauri::{AppHandle, Emitter};

use crate::lang::tr;

/// 固定端口：hook 命令行里写的就是它
pub const PORT: u16 = 47326;
/// hook 命令行里的标记，用来认出哪些 hooks 是我们装的
const MARKER: &str = "--clawd-pet-hook";
/// 一行请求最长多少字节（工具输入在客户端已经精简过了）
const MAX_LINE: u64 = 256 * 1024;
/// 权限请求最多等多久（比 hook 的超时短一点，先把"没决定"交回去）
const PERMISSION_WAIT: Duration = Duration::from_secs(590);

/// 状态类事件：后台跑（async），不拖慢 Claude
const STATE_EVENTS: &[&str] = &[
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "PostToolUseFailure",
    "Notification",
    "Stop",
    "StopFailure",
    "SubagentStart",
    "SubagentStop",
    "PreCompact",
    "PostCompact",
    "SessionEnd",
];

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let mut t: String = s.chars().take(max.saturating_sub(1)).collect();
        t.push('…');
        t
    }
}

// =====================================================================
// hook 客户端
// =====================================================================

/// `clawd-pet.exe --clawd-pet-hook <端口> <令牌>`：返回进程退出码（总是 0，失败也不打扰 Claude Code）
pub fn hook_main(args: &[String]) -> i32 {
    let i = args.iter().position(|a| a == MARKER).unwrap_or(0);
    let port: u16 = args.get(i + 1).and_then(|p| p.parse().ok()).unwrap_or(PORT);
    let token = args.get(i + 2).cloned().unwrap_or_default();

    let mut input = String::new();
    let _ = std::io::stdin().take(16 * 1024 * 1024).read_to_string(&mut input);
    // 经过 PowerShell 管道转来的输入可能带 UTF-8 BOM
    let Ok(v) = serde_json::from_str::<Value>(input.trim_start_matches('\u{feff}')) else { return 0 };
    let mut msg = summarize(&v);
    msg.insert("token".into(), Value::String(token));
    msg.insert("ancestors".into(), json!(ancestor_pids()));
    let is_permission = msg.get("event").and_then(Value::as_str) == Some("PermissionRequest");

    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(400)) else { return 0 };
    let _ = stream.set_write_timeout(Some(Duration::from_secs(3)));
    let mut line = Value::Object(msg).to_string();
    line.push('\n');
    if stream.write_all(line.as_bytes()).is_err() {
        return 0;
    }
    let wait = if is_permission { PERMISSION_WAIT + Duration::from_secs(5) } else { Duration::from_secs(3) };
    let _ = stream.set_read_timeout(Some(wait));
    let mut reply = String::new();
    let _ = BufReader::new(&stream).take(MAX_LINE).read_line(&mut reply);
    let reply = reply.trim();
    // 只有权限请求的决定需要交给 Claude Code；其他事件回的是 "ok"
    if is_permission && reply.starts_with('{') {
        let mut out = std::io::stdout();
        let _ = out.write_all(reply.as_bytes());
        let _ = out.flush();
    }
    0
}

/// 从 hook 输入里挑出宠物要用的字段，大的内容（文件正文、工具输出）一律不带
fn summarize(v: &Value) -> Map<String, Value> {
    let s = |k: &str| v.get(k).and_then(Value::as_str);
    let mut m = Map::new();
    let mut put = |k: &str, val: Value| {
        if !val.is_null() {
            m.insert(k.into(), val);
        }
    };
    put("event", json!(s("hook_event_name").unwrap_or("")));
    put("session_id", json!(s("session_id").unwrap_or("")));
    put("cwd", json!(s("cwd").unwrap_or("")));
    put("t", json!(now_ms()));
    if let Some(name) = s("tool_name") {
        put("tool_name", json!(name));
        put("tool", json!(tool_summary(name, v.get("tool_input"))));
    }
    for k in ["notification_type", "agent_id", "agent_type", "trigger", "reason", "permission_mode"] {
        if let Some(x) = s(k) {
            put(k, json!(truncate(x, 80)));
        }
    }
    if let Some(x) = s("message") {
        put("message", json!(truncate(x, 300)));
    }
    if let Some(x) = s("title") {
        put("title", json!(truncate(x, 120)));
    }
    // StopFailure 的 error 是字符串；PostToolUseFailure 的也是
    if let Some(x) = v.get("error") {
        let text = x.as_str().map(str::to_string).unwrap_or_else(|| x.to_string());
        put("error", json!(truncate(&text, 200)));
    }
    if let Some(x) = v.get("is_interrupt").and_then(Value::as_bool) {
        put("is_interrupt", json!(x));
    }
    if let Some(x) = s("last_assistant_message") {
        put("last", json!(truncate(x.trim(), 160)));
    }
    m
}

/// 气泡上显示的一行工具说明：命令、文件、网址……
fn tool_summary(name: &str, input: Option<&Value>) -> String {
    let Some(input) = input else { return String::new() };
    let s = |k: &str| input.get(k).and_then(Value::as_str);
    let text = match name {
        "Bash" | "PowerShell" => s("command").map(str::to_string),
        "Edit" | "Write" | "MultiEdit" | "Read" | "NotebookEdit" => {
            s("file_path").or(s("notebook_path")).map(str::to_string)
        }
        "WebFetch" => s("url").map(str::to_string),
        "WebSearch" => s("query").map(str::to_string),
        "Task" | "Agent" => s("description").map(str::to_string),
        "Glob" | "Grep" => s("pattern").map(str::to_string),
        _ => None,
    };
    let text = text.or_else(|| {
        // 其他工具（MCP 之类）：挑第一个短字符串字段
        input.as_object()?.values().find_map(|x| x.as_str().filter(|t| !t.is_empty()).map(str::to_string))
    });
    truncate(text.unwrap_or_default().trim(), 400)
}

/// 本进程往上的祖先进程（父、祖父……），用来找是哪个窗口在跑 Claude Code
#[cfg(windows)]
fn ancestor_pids() -> Vec<u32> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
    };
    let mut parent: HashMap<u32, u32> = HashMap::new();
    unsafe {
        let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else { return vec![] };
        let mut e = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
        if Process32FirstW(snap, &mut e).is_ok() {
            loop {
                parent.insert(e.th32ProcessID, e.th32ParentProcessID);
                if Process32NextW(snap, &mut e).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snap);
    }
    let mut out = Vec::new();
    let mut pid = std::process::id();
    for _ in 0..16 {
        match parent.get(&pid) {
            Some(&pp) if pp != 0 && pp != pid && !out.contains(&pp) => {
                out.push(pp);
                pid = pp;
            }
            _ => break,
        }
    }
    out
}

#[cfg(not(windows))]
fn ancestor_pids() -> Vec<u32> {
    vec![]
}

// =====================================================================
// 桥接服务（宠物这边）
// =====================================================================

pub struct Bridge {
    token: String,
    pending: Mutex<HashMap<u64, Sender<String>>>,
    next_id: AtomicU64,
    /// 监听失败的原因（端口被占用之类）
    pub error: Mutex<Option<String>>,
    /// 上一次收到事件的时间（ms）
    pub last_event: AtomicU64,
}

impl Bridge {
    pub fn new(token: String) -> Arc<Self> {
        Arc::new(Self {
            token,
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            error: Mutex::new(None),
            last_event: AtomicU64::new(0),
        })
    }

    /// 气泡上点了按钮：behavior 是 allow / deny；其他值（pass）= 不做决定，交还终端
    pub fn decide(&self, id: u64, behavior: &str) -> bool {
        let Some(tx) = self.pending.lock().unwrap().remove(&id) else { return false };
        let reply = match behavior {
            "allow" => json!({
                "hookSpecificOutput": { "hookEventName": "PermissionRequest", "decision": { "behavior": "allow" } }
            })
            .to_string(),
            "deny" => json!({
                "hookSpecificOutput": {
                    "hookEventName": "PermissionRequest",
                    "decision": { "behavior": "deny", "message": "The user denied this from the Clawd desktop pet." }
                }
            })
            .to_string(),
            _ => String::new(),
        };
        tx.send(reply).is_ok()
    }

    pub fn start(self: &Arc<Self>, app: AppHandle) {
        let listener = match TcpListener::bind(("127.0.0.1", PORT)) {
            Ok(l) => l,
            Err(e) => {
                *self.error.lock().unwrap() = Some(tr(
                    &format!("端口 {PORT} 被占用：{e}"),
                    &format!("ポート {PORT} は使用中です：{e}"),
                    &format!("Port {PORT} is already in use: {e}"),
                ));
                return;
            }
        };
        let bridge = self.clone();
        thread::Builder::new()
            .name("claude-bridge".into())
            .spawn(move || {
                for conn in listener.incoming() {
                    let Ok(stream) = conn else { continue };
                    let (b, a) = (bridge.clone(), app.clone());
                    let _ = thread::Builder::new()
                        .name("claude-conn".into())
                        .spawn(move || b.handle(a, stream));
                }
            })
            .expect("failed to spawn claude bridge");
    }

    fn handle(&self, app: AppHandle, mut stream: TcpStream) {
        let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
        let mut line = String::new();
        if BufReader::new(&stream).take(MAX_LINE).read_line(&mut line).is_err() {
            return;
        }
        let Ok(Value::Object(mut msg)) = serde_json::from_str::<Value>(line.trim()) else { return };
        let token = msg.remove("token").and_then(|t| t.as_str().map(str::to_string)).unwrap_or_default();
        if !same(&token, &self.token) {
            return;
        }
        self.last_event.store(now_ms(), Ordering::Relaxed);
        let ancestors: Vec<u32> = msg
            .remove("ancestors")
            .and_then(|a| serde_json::from_value(a).ok())
            .unwrap_or_default();
        let event = msg.get("event").and_then(Value::as_str).unwrap_or("").to_string();
        // 要宠物跑过去敲的窗口：跑着这个 Claude Code 的终端 / 编辑器 / 桌面 App
        if matches!(event.as_str(), "PermissionRequest" | "Notification" | "Stop") {
            if let Some(w) = window_for(&ancestors) {
                msg.insert("window".into(), json!(w));
            }
        }

        if event != "PermissionRequest" {
            let _ = app.emit("cc-event", Value::Object(msg));
            let _ = stream.write_all(b"ok\n");
            return;
        }

        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = channel::<String>();
        self.pending.lock().unwrap().insert(id, tx);
        msg.insert("id".into(), json!(id));
        let _ = app.emit("cc-permission", Value::Object(msg));

        let start = Instant::now();
        let mut probe = [0u8; 1];
        let reply = loop {
            match rx.recv_timeout(Duration::from_millis(250)) {
                Ok(r) => break Some(r),
                Err(RecvTimeoutError::Disconnected) => break None,
                Err(RecvTimeoutError::Timeout) => {}
            }
            // 用户在终端里先处理了：Claude Code 结束 hook 进程，连接断开
            let _ = stream.set_nonblocking(true);
            let gone = matches!(stream.peek(&mut probe), Ok(0))
                || matches!(&stream.peek(&mut probe), Err(e) if e.kind() != std::io::ErrorKind::WouldBlock);
            let _ = stream.set_nonblocking(false);
            if gone || start.elapsed() >= PERMISSION_WAIT {
                break None;
            }
        };
        self.pending.lock().unwrap().remove(&id);
        match reply {
            Some(r) => {
                let _ = stream.write_all(format!("{r}\n").as_bytes());
            }
            None => {
                let _ = stream.write_all(b"\n");
                let _ = app.emit("cc-permission-gone", json!({ "id": id }));
            }
        }
        let _ = stream.shutdown(Shutdown::Both);
    }
}

/// 比较令牌（长度相同时逐字节比完，不提前返回）
fn same(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

#[cfg(windows)]
fn window_for(ancestors: &[u32]) -> Option<i64> {
    crate::desktop::window_for_pids(ancestors).map(|h| h as i64)
}

#[cfg(not(windows))]
fn window_for(_ancestors: &[u32]) -> Option<i64> {
    None
}

/// 随机令牌：系统随机种子的哈希，128 位
pub fn new_token() -> String {
    let mut out = String::new();
    for i in 0..2u64 {
        let mut h = std::collections::hash_map::RandomState::new().build_hasher();
        h.write_u64(now_ms() ^ (std::process::id() as u64) ^ i);
        out.push_str(&format!("{:016x}", h.finish()));
    }
    out
}

// =====================================================================
// 安装 / 卸载 hooks（~/.claude/settings.json）
// =====================================================================

pub fn settings_path() -> Option<PathBuf> {
    // Claude Code 自己也认这个变量：设了就不在 ~/.claude 里
    if let Some(dir) = std::env::var_os("CLAUDE_CONFIG_DIR").filter(|d| !d.is_empty()) {
        return Some(PathBuf::from(dir).join("settings.json"));
    }
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"))?;
    Some(PathBuf::from(home).join(".claude").join("settings.json"))
}

/// 一条 hook：exec 形式（command 是本程序的绝对路径，args 是参数），不经过 shell
pub fn hook_entry(token: &str) -> Option<Value> {
    let exe = std::env::current_exe().ok()?;
    Some(json!({
        "type": "command",
        "command": exe.to_string_lossy(),
        "args": [MARKER, PORT.to_string(), token],
    }))
}

fn is_ours(hook: &Value) -> bool {
    let in_args = hook
        .get("args")
        .and_then(Value::as_array)
        .is_some_and(|a| a.iter().any(|x| x.as_str() == Some(MARKER)));
    in_args || hook.get("command").and_then(Value::as_str).is_some_and(|c| c.contains(MARKER))
}

fn read_settings(path: &PathBuf) -> Result<Map<String, Value>, String> {
    if !path.exists() {
        return Ok(Map::new());
    }
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    // 记事本、PowerShell 5.1 存出来的文件可能带 BOM，或者是 UTF-16 / 系统代码页（日文系统是 Shift_JIS）
    let text = String::from_utf8(bytes).map_err(|_| {
        tr(
            "settings.json 不是 UTF-8 编码，没有改动（请用 UTF-8 重新保存）",
            "settings.json がUTF-8ではないため、変更していません（UTF-8で保存し直してください）",
            "settings.json is not UTF-8, so it was left unchanged (re-save it as UTF-8)",
        )
    })?;
    let text = text.trim_start_matches('\u{feff}');
    if text.trim().is_empty() {
        return Ok(Map::new());
    }
    match serde_json::from_str::<Value>(text) {
        Ok(Value::Object(m)) => Ok(m),
        Ok(_) => Err(tr(
            "settings.json 不是一个 JSON 对象",
            "settings.json がJSONオブジェクトではありません",
            "settings.json is not a JSON object",
        )),
        Err(e) => Err(tr(
            &format!("settings.json 格式不对，没有改动：{e}"),
            &format!("settings.json の形式が正しくないため、変更していません：{e}"),
            &format!("settings.json is not valid JSON, so it was left unchanged: {e}"),
        )),
    }
}

/// 去掉我们装的 hooks，顺手清理因此变空的分组/事件
fn strip_ours(settings: &mut Map<String, Value>) {
    let Some(Value::Object(hooks)) = settings.get_mut("hooks") else { return };
    for groups in hooks.values_mut() {
        let Value::Array(list) = groups else { continue };
        for g in list.iter_mut() {
            if let Some(Value::Array(hs)) = g.get_mut("hooks") {
                hs.retain(|h| !is_ours(h));
            }
        }
        list.retain(|g| g.get("hooks").and_then(Value::as_array).is_none_or(|hs| !hs.is_empty()));
    }
    hooks.retain(|_, groups| groups.as_array().is_none_or(|l| !l.is_empty()));
    if hooks.is_empty() {
        settings.remove("hooks");
    }
}

fn write_settings(path: &PathBuf, settings: Map<String, Value>) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    // 第一次改之前备份一份
    let backup = path.with_extension("json.clawd-backup");
    if path.exists() && !backup.exists() {
        std::fs::copy(path, &backup).map_err(|e| e.to_string())?;
    }
    let mut text = serde_json::to_string_pretty(&Value::Object(settings)).map_err(|e| e.to_string())?;
    text.push('\n');
    let tmp = path.with_extension("json.clawd-tmp");
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

/// 装上（或者更新）我们的 hooks。permission：是否接管权限请求
pub fn install(token: &str, permission: bool) -> Result<(), String> {
    let path = settings_path().ok_or_else(|| tr("找不到用户目录", "ユーザーフォルダが見つかりません", "Could not find the user folder"))?;
    let entry = hook_entry(token)
        .ok_or_else(|| tr("找不到本程序的路径", "このアプリの場所が分かりません", "Could not determine this app's location"))?;
    install_into(&path, entry, permission)
}

fn install_into(path: &PathBuf, entry: Value, permission: bool) -> Result<(), String> {
    let path = path.clone();
    let mut settings = read_settings(&path)?;
    strip_ours(&mut settings);
    let hooks = settings.entry("hooks").or_insert_with(|| Value::Object(Map::new()));
    let Value::Object(hooks) = hooks else {
        return Err(tr(
            "settings.json 里的 hooks 不是对象",
            "settings.json の hooks がオブジェクトではありません",
            "\"hooks\" in settings.json is not an object",
        ));
    };
    let mut add = |event: &str, hook: Value| {
        let list = hooks.entry(event).or_insert_with(|| Value::Array(vec![]));
        if let Value::Array(list) = list {
            list.push(json!({ "hooks": [hook] }));
        }
    };
    for e in STATE_EVENTS {
        let mut h = entry.clone();
        h["async"] = json!(true);
        add(e, h);
    }
    if permission {
        let mut h = entry.clone();
        h["timeout"] = json!(600);
        add("PermissionRequest", h);
    }
    write_settings(&path, settings)
}

pub fn uninstall() -> Result<(), String> {
    let Some(path) = settings_path() else { return Ok(()) };
    if !path.exists() {
        return Ok(());
    }
    let mut settings = read_settings(&path)?;
    let before = Value::Object(settings.clone());
    strip_ours(&mut settings);
    if Value::Object(settings.clone()) == before {
        return Ok(());
    }
    write_settings(&path, settings)
}

#[derive(serde::Serialize)]
pub struct HookStatus {
    /// 装了我们的 hooks
    pub installed: bool,
    /// 接管了权限请求
    pub permission: bool,
    /// hooks 里的命令和本程序现在的路径、令牌一致（不一致要重新装）
    pub current: bool,
    pub settings_path: String,
    pub error: Option<String>,
}

pub fn status(token: &str) -> HookStatus {
    let path = settings_path();
    let expected = hook_entry(token);
    let mut st = HookStatus {
        installed: false,
        permission: false,
        current: true,
        settings_path: path.as_ref().map(|p| p.display().to_string()).unwrap_or_default(),
        error: None,
    };
    let Some(path) = path else { return st };
    let settings = match read_settings(&path) {
        Ok(s) => s,
        Err(e) => {
            st.error = Some(e);
            return st;
        }
    };
    let Some(Value::Object(hooks)) = settings.get("hooks") else { return st };
    for (event, groups) in hooks {
        for g in groups.as_array().into_iter().flatten() {
            for h in g.get("hooks").and_then(Value::as_array).into_iter().flatten() {
                if !is_ours(h) {
                    continue;
                }
                st.installed = true;
                if event == "PermissionRequest" {
                    st.permission = true;
                }
                let same_target = expected
                    .as_ref()
                    .is_some_and(|e| h.get("command") == e.get("command") && h.get("args") == e.get("args"));
                if !same_target {
                    st.current = false;
                }
            }
        }
    }
    st
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn summary_keeps_small_fields_only() {
        let v = json!({
            "hook_event_name": "PreToolUse",
            "session_id": "s1",
            "cwd": "E:/x",
            "tool_name": "Write",
            "tool_input": { "file_path": "E:/x/a.txt", "content": "很长的文件内容".repeat(1000) },
        });
        let m = summarize(&v);
        assert_eq!(m["event"], "PreToolUse");
        assert_eq!(m["tool"], "E:/x/a.txt");
        assert!(Value::Object(m).to_string().len() < 300);
    }

    #[test]
    fn bash_summary_is_the_command() {
        let input = json!({ "command": "npm test", "description": "Run tests" });
        assert_eq!(tool_summary("Bash", Some(&input)), "npm test");
        let mcp = json!({ "query": "", "repo": "a/b" });
        assert_eq!(tool_summary("mcp__gh__search", Some(&mcp)), "a/b");
    }

    #[test]
    fn strip_keeps_other_hooks() {
        let mut s: Map<String, Value> = serde_json::from_value(json!({
            "model": "x",
            "hooks": {
                "PreToolUse": [
                    { "matcher": "Bash", "hooks": [{ "type": "command", "command": "mine.sh" }] },
                    { "hooks": [{ "type": "command", "command": "C:/a/clawd-pet.exe", "args": ["--clawd-pet-hook", "1", "t"] }] }
                ],
                "Stop": [{ "hooks": [{ "type": "command", "command": "x --clawd-pet-hook 1 t", "async": true }] }]
            }
        }))
        .unwrap();
        strip_ours(&mut s);
        assert_eq!(
            Value::Object(s),
            json!({
                "model": "x",
                "hooks": { "PreToolUse": [{ "matcher": "Bash", "hooks": [{ "type": "command", "command": "mine.sh" }] }] }
            })
        );
    }

    fn temp_settings(name: &str, content: &[u8]) -> PathBuf {
        // 目录名带日文和空格：用户名是日文的机器上 ~/.claude 就是这样的路径
        let dir = std::env::temp_dir().join(format!("clawd テスト {name} {}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("settings.json");
        std::fs::write(&p, content).unwrap();
        p
    }

    fn fake_entry() -> Value {
        json!({ "type": "command", "command": "C:/Users/れいげつ/AppData/Local/Clawd Pet/clawd-pet.exe", "args": [MARKER, "47326", "tok"] })
    }

    #[test]
    fn install_and_uninstall_roundtrip_keeps_user_settings() {
        // 带 BOM 的 UTF-8、用户自己的 hook 和别的设置
        let mut original = vec![0xEF, 0xBB, 0xBF];
        original.extend_from_slice(
            json!({
                "theme": "dark",
                "memo": "日本語のメモ",
                "hooks": { "Stop": [{ "hooks": [{ "type": "command", "command": "mine.cmd" }] }] }
            })
            .to_string()
            .as_bytes(),
        );
        let p = temp_settings("roundtrip", &original);
        install_into(&p, fake_entry(), true).unwrap();
        let after: Value = serde_json::from_slice(&std::fs::read(&p).unwrap()).unwrap();
        assert_eq!(after["memo"], "日本語のメモ");
        assert_eq!(after["hooks"]["Stop"].as_array().unwrap().len(), 2, "他人的 Stop hook 还在");
        assert_eq!(after["hooks"]["PermissionRequest"][0]["hooks"][0]["timeout"], 600);
        assert_eq!(after["hooks"]["PreToolUse"][0]["hooks"][0]["async"], true);
        // 备份是原样的
        assert_eq!(std::fs::read(p.with_extension("json.clawd-backup")).unwrap(), original);
        // 再装一次不会重复
        install_into(&p, fake_entry(), false).unwrap();
        let again: Value = serde_json::from_slice(&std::fs::read(&p).unwrap()).unwrap();
        assert_eq!(again["hooks"]["Stop"].as_array().unwrap().len(), 2);
        assert!(again["hooks"].get("PermissionRequest").is_none(), "关掉权限接管后撤掉那条");
        // 卸载：只剩用户自己的
        let mut s = read_settings(&p).unwrap();
        strip_ours(&mut s);
        assert_eq!(s["hooks"]["Stop"].as_array().unwrap().len(), 1);
        assert!(s["hooks"].get("PreToolUse").is_none());
        let _ = std::fs::remove_dir_all(p.parent().unwrap());
    }

    #[test]
    fn non_utf8_settings_is_left_alone_with_a_clear_error() {
        // Shift_JIS 的"設定"
        let p = temp_settings("sjis", b"{\"memo\":\"\x90\xdd\x92\xe8\"}");
        let err = install_into(&p, fake_entry(), true).unwrap_err();
        assert!(err.contains("UTF-8"), "{err}");
        assert_eq!(std::fs::read(&p).unwrap(), b"{\"memo\":\"\x90\xdd\x92\xe8\"}", "文件没被动");
        let _ = std::fs::remove_dir_all(p.parent().unwrap());
    }

    #[test]
    fn roundtrip_over_tcp() {
        // 客户端 → 服务端的一行协议，用临时端口跑一遍
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = thread::spawn(move || {
            let (s, _) = listener.accept().unwrap();
            let mut line = String::new();
            BufReader::new(&s).read_line(&mut line).unwrap();
            (&s).write_all(b"ok\n").unwrap();
            line
        });
        let mut c = TcpStream::connect(("127.0.0.1", port)).unwrap();
        c.write_all(b"{\"event\":\"Stop\",\"token\":\"t\"}\n").unwrap();
        let mut reply = String::new();
        BufReader::new(&c).read_line(&mut reply).unwrap();
        assert_eq!(reply, "ok\n");
        assert!(server.join().unwrap().contains("Stop"));
        assert!(same("abc", "abc") && !same("abc", "abd") && !same("abc", "ab"));
    }
}

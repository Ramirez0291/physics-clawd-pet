//! Antigravity（agy CLI / Antigravity App / IDE）联动。
//!
//! 三个都读全局的 `~/.gemini/config/hooks.json`，格式是"hook 名 → 事件 → 处理器"，
//! 我们只占一个名字 `clawd-pet`，关闭时整个删掉，用户自己的 hooks 原样保留。
//!
//! 和 Claude Code / Codex 不一样的地方：
//! - 命令一律经 `cmd /c` 跑，工作目录是 hooks.json 所在的文件夹。所以 hooks.json 里只写
//!   `.\clawd-pet-hook.cmd <事件>`（不带引号、不带空格），真正的程序路径放在旁边的这个批处理里，
//!   不用管 agy 怎么转义（批处理怎么对付日文路径见 `launcher_with`）；
//! - 输入里没有事件名，事件名由命令行带进来；
//! - PreToolUse 的 hook 失败（崩溃、超时、非 0 退出）会拦下这次工具调用，所以不管宠物开没开、
//!   程序还在不在，都必须回一个 `{"decision":"allow"}`；
//! - 没有权限请求事件。勾了气泡批准时，shell 命令（run_command）在 PreToolUse 里等气泡：
//!   允许 = auto_approve（仍然遵守用户自己配的规则），拒绝 = deny，关掉气泡 = allow（交回 Antigravity 的默认策略）。

use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};

use crate::claude::{self, HookStatus, PORT};
use crate::codex;

pub const MARKER: &str = "--clawd-pet-agy-hook";
const NAME: &str = "clawd-pet";
#[cfg(windows)]
const LAUNCHER: &str = "clawd-pet-hook.cmd";
#[cfg(not(windows))]
const LAUNCHER: &str = "clawd-pet-hook.sh";
const ASK: &str = "--ask";
/// PostInvocation 每次模型调用都会触发，宠物用不上，不装
const EVENTS: &[&str] = &["SessionStart", "PreInvocation", "PreToolUse", "PostToolUse", "Stop"];

pub fn settings_path() -> Option<PathBuf> {
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"))?;
    Some(PathBuf::from(home).join(".gemini").join("config").join("hooks.json"))
}

/// hooks.json 旁边的批处理：先检查程序还在（不在就照样放行），再把 stdin 原样交给本程序
#[cfg(windows)]
fn launcher(exe: &Path, token: &str) -> String {
    let env: Vec<(&str, String)> = ["LOCALAPPDATA", "APPDATA", "USERPROFILE"]
        .into_iter()
        .filter_map(|k| Some((k, std::env::var(k).ok()?)))
        .collect();
    launcher_with(exe, token, &env)
}

/// 批处理只能写 ASCII：cmd 按它启动时的控制台代码页解码批处理，中途 chcp 也不会重新解码，
/// 日文用户名之类的路径直接写进去就找不到文件。所以：
/// 1. 路径本来就是 ASCII：直接写；
/// 2. 换成 `%LOCALAPPDATA%` 这类变量后剩下的是 ASCII（通常只有用户名不是）：写变量，快；
/// 3. 兜底（变量没传进来、或者剩下的还有非 ASCII）：PowerShell 跑一段 base64 编码的脚本，慢几百毫秒但不怕编码。
#[cfg(windows)]
fn launcher_with(exe: &Path, token: &str, env: &[(&str, String)]) -> String {
    let path = exe.to_string_lossy().to_string();
    let args = format!("{MARKER} {PORT} {token} %*");
    let mut s = String::from("@echo off\r\n");
    if path.is_ascii() {
        let p = path.replace('%', "%%");
        s += &format!("if not exist \"{p}\" goto missing\r\n\"{p}\" {args}\r\nexit /b 0\r\n");
    } else {
        let short = env.iter().find_map(|(k, v)| {
            let v = v.trim_end_matches('\\');
            let (head, rest) = (path.get(..v.len())?, path.get(v.len()..)?);
            let ok = !v.is_empty() && head.eq_ignore_ascii_case(v) && rest.starts_with('\\') && rest.is_ascii();
            ok.then(|| format!("%{k}%{}", rest.replace('%', "%%")))
        });
        if let Some(p) = short {
            s += &format!("if not exist \"{p}\" goto slow\r\n\"{p}\" {args}\r\nexit /b 0\r\n:slow\r\n");
        }
        // 事件名和 --ask 用环境变量交给脚本（-EncodedCommand 后面不能再接参数）
        let script = format!(
            "$ProgressPreference = 'SilentlyContinue'; $OutputEncoding = [System.Text.UTF8Encoding]::new($false); \
             [Console]::InputEncoding = $OutputEncoding; [Console]::OutputEncoding = $OutputEncoding; \
             $exe = '{}'; $a = @('{MARKER}', '{PORT}', '{token}', $env:CLAWD_EVENT); if ($env:CLAWD_ASK) {{ $a += $env:CLAWD_ASK }}; \
             if (Test-Path -LiteralPath $exe) {{ [Console]::In.ReadToEnd() | & $exe @a }} \
             elseif ($env:CLAWD_EVENT -eq 'PreToolUse') {{ '{{\"decision\":\"allow\"}}' }} else {{ '{{}}' }}",
            path.replace('\'', "''"),
        );
        let bytes: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
        s += "set \"CLAWD_EVENT=%~1\"\r\nset \"CLAWD_ASK=%~2\"\r\n";
        s += &format!(
            "powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand {}\r\nexit /b 0\r\n",
            base64::Engine::encode(&base64::engine::general_purpose::STANDARD, bytes)
        );
    }
    s += ":missing\r\nif \"%~1\"==\"PreToolUse\" (echo {\"decision\":\"allow\"}) else (echo {})\r\nexit /b 0\r\n";
    s
}

/// macOS / Linux 上 agy 用 `sh -c` 跑 hook
#[cfg(not(windows))]
fn launcher(exe: &Path, token: &str) -> String {
    let exe = exe.to_string_lossy().replace('\'', "'\"'\"'");
    format!(
        "#!/bin/sh\nexe='{exe}'\nif [ -x \"$exe\" ]; then exec \"$exe\" {MARKER} {PORT} {token} \"$@\"; fi\n\
         if [ \"$1\" = PreToolUse ]; then echo '{{\"decision\":\"allow\"}}'; else echo '{{}}'; fi\n"
    )
}

fn command(event: &str) -> String {
    if cfg!(windows) {
        format!(".\\{LAUNCHER} {event}")
    } else {
        format!("sh ./{LAUNCHER} {event}")
    }
}

fn handler(event: &str, permission: bool) -> Value {
    let ask = if permission && event == "PreToolUse" { format!(" {ASK}") } else { String::new() };
    // PreToolUse 等气泡时要比宠物那边的等待（590 秒）长；其他事件只是一次本机 TCP 往返
    let timeout = if ask.is_empty() { 10 } else { 600 };
    json!({ "type": "command", "command": format!("{}{ask}", command(event)), "timeout": timeout })
}

fn entry(permission: bool) -> Value {
    let mut m = Map::new();
    for event in EVENTS {
        let h = handler(event, permission);
        // 工具事件按 matcher 分组，其他事件直接是处理器列表
        let v = if event.ends_with("ToolUse") { json!([{ "matcher": "*", "hooks": [h] }]) } else { json!([h]) };
        m.insert((*event).into(), v);
    }
    Value::Object(m)
}

fn install_into(path: &Path, exe: &Path, token: &str, permission: bool) -> Result<(), String> {
    let mut settings = codex::read(path)?;
    let script = path.with_file_name(LAUNCHER);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    // 先放批处理再改 hooks.json：hook 一生效就要能跑
    let text = launcher(exe, token);
    if std::fs::read_to_string(&script).ok().as_deref() != Some(text.as_str()) {
        std::fs::write(&script, text).map_err(|e| e.to_string())?;
    }
    settings.insert(NAME.into(), entry(permission));
    codex::write(path, settings)
}

pub fn install(token: &str, permission: bool) -> Result<(), String> {
    let path = settings_path().ok_or("Could not find the Antigravity config folder")?;
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    install_into(&path, &exe, token, permission)
}

fn uninstall_from(path: &Path) -> Result<(), String> {
    if path.exists() {
        let mut settings = codex::read(path)?;
        if settings.remove(NAME).is_some() {
            codex::write(path, settings)?;
        }
    }
    let script = path.with_file_name(LAUNCHER);
    if script.exists() {
        std::fs::remove_file(script).map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn uninstall() -> Result<(), String> {
    match settings_path() {
        Some(p) => uninstall_from(&p),
        None => Ok(()),
    }
}

fn status_at(path: &Path, exe: &Path, token: &str) -> HookStatus {
    let mut st = HookStatus {
        installed: false,
        permission: false,
        current: true,
        settings_path: path.display().to_string(),
        error: None,
    };
    let ours = match codex::read(path) {
        Ok(mut s) => s.remove(NAME),
        Err(e) => {
            st.error = Some(e);
            return st;
        }
    };
    let Some(ours) = ours else { return st };
    st.installed = true;
    st.permission = ours.to_string().contains(ASK);
    let script = std::fs::read_to_string(path.with_file_name(LAUNCHER)).ok();
    st.current = ours == entry(st.permission) && script.as_deref() == Some(launcher(exe, token).as_str());
    st
}

pub fn status(token: &str) -> HookStatus {
    match (settings_path(), std::env::current_exe()) {
        (Some(p), Ok(exe)) => status_at(&p, &exe, token),
        _ => HookStatus {
            installed: false,
            permission: false,
            current: false,
            settings_path: String::new(),
            error: Some("Could not find the Antigravity config folder or pet executable".into()),
        },
    }
}

// =====================================================================
// hook 客户端：`clawd-pet.exe --clawd-pet-agy-hook <端口> <令牌> <事件> [--ask]`
// =====================================================================

pub fn hook_main(args: &[String]) -> i32 {
    let i = args.iter().position(|a| a == MARKER).unwrap_or(0);
    let port: u16 = args.get(i + 1).and_then(|p| p.parse().ok()).unwrap_or(PORT);
    let token = args.get(i + 2).cloned().unwrap_or_default();
    let event = args.get(i + 3).cloned().unwrap_or_default();
    let ask = args.iter().any(|a| a == ASK);

    let mut input = String::new();
    let _ = std::io::stdin().take(16 * 1024 * 1024).read_to_string(&mut input);
    let msg = serde_json::from_str::<Value>(input.trim_start_matches('\u{feff}'))
        .ok()
        .and_then(|v| summarize(&event, &v, ask));
    let reply = match msg {
        Some(m) => {
            let permission = m.get("event").and_then(Value::as_str) == Some("PermissionRequest");
            let reply = claude::relay(m, port, token);
            if permission { reply } else { String::new() }
        }
        None => String::new(),
    };
    let mut out = std::io::stdout();
    let _ = out.write_all(output(&event, &reply).as_bytes());
    let _ = out.flush();
    0
}

/// 回给 Antigravity 的 JSON。reply 是宠物对权限请求回的那一行（Claude 的 PermissionRequest 格式）
fn output(event: &str, reply: &str) -> String {
    if event != "PreToolUse" {
        return "{}".into();
    }
    let behavior = serde_json::from_str::<Value>(reply)
        .ok()
        .and_then(|v| v["hookSpecificOutput"]["decision"]["behavior"].as_str().map(str::to_string));
    match behavior.as_deref() {
        Some("allow") => json!({ "decision": "auto_approve" }),
        Some("deny") => json!({ "decision": "deny", "reason": "The user denied this from the Clawd desktop pet." }),
        _ => json!({ "decision": "allow" }),
    }
    .to_string()
}

/// 把 Antigravity 的 hook 输入换成 Claude 那套事件；宠物用不上的返回 None（不连宠物）
pub(crate) fn summarize(event: &str, v: &Value, ask: bool) -> Option<Map<String, Value>> {
    let conv = v.get("conversationId").and_then(Value::as_str).unwrap_or("?");
    let tool = v.get("toolCall").filter(|t| t.is_object());
    let name = tool.and_then(|t| t.get("name")).and_then(Value::as_str);
    let error = v.get("error").and_then(Value::as_str).filter(|e| !e.is_empty());
    let mapped = match event {
        "SessionStart" | "PreInvocation" => event,
        // PostToolUse 在非工具步骤上也会触发，toolCall 是 null
        "PreToolUse" => match name? {
            "invoke_subagent" => "SubagentStart",
            "run_command" if ask => "PermissionRequest",
            _ => event,
        },
        "PostToolUse" => match name? {
            "invoke_subagent" => "SubagentStop",
            _ if error.is_some() => "PostToolUseFailure",
            _ => event,
        },
        "Stop" if error.is_some() || v["terminationReason"] == "error" => "StopFailure",
        "Stop" => event,
        _ => return None,
    };
    let cwd = v.get("workspacePaths").and_then(|w| w.get(0)).and_then(Value::as_str).unwrap_or("");
    let mut input = json!({ "hook_event_name": mapped, "session_id": format!("agy:{conv}"), "cwd": cwd });
    if let Some(name) = name {
        input["tool_name"] = json!(name);
        input["tool_input"] = tool.and_then(|t| t.get("args")).cloned().unwrap_or(Value::Null);
    }
    if let Some(error) = error {
        input["error"] = json!(error);
    } else if mapped == "StopFailure" {
        input["error"] = json!("Antigravity stopped with an error");
    }
    let mut m = claude::summarize(&input);
    m.insert("provider".into(), json!("agy"));
    if mapped.starts_with("Subagent") {
        let step = v.get("stepIdx").and_then(Value::as_i64).unwrap_or(0);
        m.insert("agent_id".into(), json!(format!("agy:{conv}:{step}")));
    }
    Some(m)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn events_are_mapped_and_namespaced() {
        let base = json!({ "conversationId": "c", "workspacePaths": ["E:/proj"], "stepIdx": 3 });
        let with = |extra: Value| {
            let mut v = base.clone();
            v.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
            v
        };
        let shell = with(json!({ "toolCall": { "name": "run_command", "args": { "CommandLine": "npm test", "Cwd": "E:/proj" } } }));
        let m = summarize("PreToolUse", &shell, false).unwrap();
        assert_eq!(m["event"], "PreToolUse");
        assert_eq!(m["session_id"], "agy:c");
        assert_eq!(m["cwd"], "E:/proj");
        assert_eq!(m["provider"], "agy");
        assert_eq!(m["tool"], "npm test");
        assert_eq!(summarize("PreToolUse", &shell, true).unwrap()["event"], "PermissionRequest");

        let failed = with(json!({ "toolCall": { "name": "run_command", "args": {} }, "error": "exit status 1" }));
        let m = summarize("PostToolUse", &failed, false).unwrap();
        assert_eq!((m["event"].as_str(), m["error"].as_str()), (Some("PostToolUseFailure"), Some("exit status 1")));
        assert!(summarize("PostToolUse", &with(json!({ "toolCall": null })), false).is_none());

        let sub = with(json!({ "toolCall": { "name": "invoke_subagent", "args": {} } }));
        assert_eq!(summarize("PreToolUse", &sub, true).unwrap()["agent_id"], "agy:c:3");
        assert_eq!(summarize("PostToolUse", &sub, false).unwrap()["event"], "SubagentStop");

        let stop = with(json!({ "terminationReason": "model_stop", "error": "", "fullyIdle": true }));
        assert_eq!(summarize("Stop", &stop, false).unwrap()["event"], "Stop");
        let crash = with(json!({ "terminationReason": "error", "error": "" }));
        assert_eq!(summarize("Stop", &crash, false).unwrap()["event"], "StopFailure");
        assert!(summarize("PostInvocation", &base, false).is_none());
    }

    #[test]
    fn pre_tool_use_always_gets_a_decision() {
        assert_eq!(output("PreToolUse", ""), r#"{"decision":"allow"}"#);
        assert_eq!(output("PreToolUse", "ok"), r#"{"decision":"allow"}"#);
        let allow = r#"{"hookSpecificOutput":{"decision":{"behavior":"allow"}}}"#;
        assert_eq!(output("PreToolUse", allow), r#"{"decision":"auto_approve"}"#);
        let deny = r#"{"hookSpecificOutput":{"decision":{"behavior":"deny","message":"x"}}}"#;
        assert!(output("PreToolUse", deny).contains(r#""decision":"deny""#));
        assert_eq!(output("Stop", ""), "{}");
    }

    #[cfg(windows)]
    #[test]
    fn launcher_is_ascii_for_japanese_paths() {
        let env = [("LOCALAPPDATA", r"C:\Users\れいげつ\AppData\Local\".to_string())];
        let fast = launcher_with(Path::new(r"c:\users\れいげつ\appdata\local\Clawd 100% Pet\clawd-pet.exe"), "t", &env);
        assert!(fast.is_ascii());
        assert!(fast.contains(r#""%LOCALAPPDATA%\Clawd 100%% Pet\clawd-pet.exe" --clawd-pet-agy-hook 47326 t %*"#));
        assert!(fast.contains("-EncodedCommand"), "falls back to PowerShell when the variable is missing");
        let slow = launcher_with(Path::new(r"D:\ペット\clawd-pet.exe"), "t", &env);
        assert!(slow.is_ascii() && !slow.contains("%LOCALAPPDATA%") && slow.contains("-EncodedCommand"));
        let plain = launcher_with(Path::new(r"C:\Pet\clawd-pet.exe"), "t", &env);
        assert!(plain.contains(r#""C:\Pet\clawd-pet.exe" --clawd-pet-agy-hook"#) && !plain.contains("powershell"));
    }

    /// 手动验证用：`CLAWD_TEST_EXE=… CLAWD_TEST_DIR=… cargo test write_launcher -- --ignored`
    #[cfg(windows)]
    #[test]
    #[ignore]
    fn write_launcher() {
        let exe = std::env::var("CLAWD_TEST_EXE").unwrap();
        let dir = std::env::var("CLAWD_TEST_DIR").unwrap();
        std::fs::write(Path::new(&dir).join(LAUNCHER), launcher(Path::new(&exe), "tok")).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn install_roundtrip_keeps_user_hooks() {
        let dir = std::env::temp_dir().join(format!("clawd agy テスト {}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("hooks.json");
        let exe = Path::new("C:/Users/れいげつ/Pet's 100% App/clawd-pet.exe");
        let original = json!({ "my-linter": { "PostToolUse": [{ "matcher": "run_command", "hooks": [{ "command": "./lint.sh" }] }] } }).to_string();
        std::fs::write(&p, &original).unwrap();

        install_into(&p, exe, "tok", true).unwrap();
        let st = status_at(&p, exe, "tok");
        assert!(st.installed && st.current && st.permission);
        assert!(!status_at(&p, exe, "other").current);
        let s = codex::read(&p).unwrap();
        assert_eq!(s["clawd-pet"]["PreToolUse"][0]["hooks"][0]["command"], ".\\clawd-pet-hook.cmd PreToolUse --ask");
        assert_eq!(s["clawd-pet"]["Stop"][0]["command"], ".\\clawd-pet-hook.cmd Stop");
        assert!(s.contains_key("my-linter"));
        let script = std::fs::read_to_string(dir.join(LAUNCHER)).unwrap();
        assert!(script.is_ascii() && script.contains("-EncodedCommand"));

        install_into(&p, exe, "tok", false).unwrap();
        let st = status_at(&p, exe, "tok");
        assert!(st.current && !st.permission);

        uninstall_from(&p).unwrap();
        assert_eq!(Value::Object(codex::read(&p).unwrap()), serde_json::from_str::<Value>(&original).unwrap());
        assert!(!dir.join(LAUNCHER).exists());
        std::fs::write(&p, "{invalid").unwrap();
        assert!(install_into(&p, exe, "tok", false).is_err());
        let _ = std::fs::remove_dir_all(dir);
    }
}

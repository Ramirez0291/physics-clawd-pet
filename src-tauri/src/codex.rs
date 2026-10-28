//! Codex lifecycle hooks → the shared local pet bridge. No transcript scraping.

use crate::claude::{self, HookStatus, PORT};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};

pub const MARKER: &str = "--clawd-pet-codex-hook";
pub const OBSERVE_PERMISSION: &str = "--observe-permission";
const EVENTS: &[&str] = &[
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "PreCompact",
    "PostCompact",
    "SubagentStart",
    "SubagentStop",
    "Stop",
    "Interrupt",
    "SessionEnd",
    "PermissionRequest",
];

pub fn settings_path() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("CODEX_HOME").filter(|d| !d.is_empty()) {
        return Some(PathBuf::from(dir).join("hooks.json"));
    }
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"))?;
    Some(PathBuf::from(home).join(".codex/hooks.json"))
}

fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\"'\"'"))
}

fn hook_entry(exe: &Path, token: &str, observe: bool) -> Value {
    let exe = exe.to_string_lossy();
    let extra = if observe {
        format!(" {OBSERVE_PERMISSION}")
    } else {
        String::new()
    };
    // Codex command hooks use a shell command, not Claude's command + args form.
    let command = format!(
        "{} {MARKER} {PORT} {}{extra}",
        shell_quote(&exe),
        shell_quote(token)
    );
    // Encoded PowerShell keeps spaces, apostrophes, Japanese and shell metacharacters
    // intact regardless of the shell Codex uses to launch the Windows hook.
    let script = format!(
        "$OutputEncoding = [System.Text.UTF8Encoding]::new($false); \
         [Console]::InputEncoding = $OutputEncoding; [Console]::OutputEncoding = $OutputEncoding; \
         [Console]::In.ReadToEnd() | & '{}' '{MARKER}' '{PORT}' '{}'{extra}",
        exe.replace('\'', "''"),
        token.replace('\'', "''"),
    );
    let bytes: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    json!({
        "type": "command", "command": command,
        "commandWindows": format!("powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand {}", STANDARD.encode(bytes)),
    })
}

fn is_ours(h: &Value) -> bool {
    h.get("command")
        .and_then(Value::as_str)
        .is_some_and(|s| s.contains(MARKER))
}

pub(crate) fn read(path: &Path) -> Result<Map<String, Value>, String> {
    if !path.exists() {
        return Ok(Map::new());
    }
    let text = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
    serde_json::from_str::<Value>(text.trim_start_matches('\u{feff}'))
        .map_err(|e| format!("{}: {e}", path.display()))?
        .as_object()
        .cloned()
        .ok_or_else(|| format!("{}: expected a JSON object", path.display()))
}

fn strip(settings: &mut Map<String, Value>) {
    let Some(Value::Object(hooks)) = settings.get_mut("hooks") else {
        return;
    };
    for groups in hooks.values_mut() {
        if let Some(groups) = groups.as_array_mut() {
            for group in groups.iter_mut() {
                if let Some(hs) = group.get_mut("hooks").and_then(Value::as_array_mut) {
                    hs.retain(|h| !is_ours(h));
                }
            }
            groups.retain(|g| {
                g.get("hooks")
                    .and_then(Value::as_array)
                    .is_none_or(|hs| !hs.is_empty())
            });
        }
    }
    hooks.retain(|_, groups| groups.as_array().is_none_or(|gs| !gs.is_empty()));
    if hooks.is_empty() {
        settings.remove("hooks");
    }
}

pub(crate) fn write(path: &Path, settings: Map<String, Value>) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let backup = path.with_extension("json.clawd-backup");
    if path.exists() && !backup.exists() {
        std::fs::copy(path, backup).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())? + "\n";
    let tmp = path.with_extension("json.clawd-tmp");
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(tmp, path).map_err(|e| e.to_string())
}

fn install_into(path: &Path, exe: &Path, token: &str, permission: bool) -> Result<(), String> {
    let mut settings = read(path)?;
    strip(&mut settings);
    let hooks = settings.entry("hooks").or_insert_with(|| json!({}));
    let hooks = hooks
        .as_object_mut()
        .ok_or("hooks.json: hooks must be an object")?;
    for event in EVENTS {
        let mut h = hook_entry(exe, token, *event == "PermissionRequest" && !permission);
        // Keep lifecycle events ordered: these only make a short local TCP roundtrip.
        // Interrupt and SessionEnd are restricted to a maximum of three seconds.
        h["timeout"] = json!(if *event == "PermissionRequest" && permission {
            600
        } else if matches!(*event, "Interrupt" | "SessionEnd") {
            3
        } else {
            5
        });
        let groups = hooks.entry(*event).or_insert_with(|| json!([]));
        groups
            .as_array_mut()
            .ok_or_else(|| format!("hooks.json: {event} must be an array"))?
            .push(json!({ "hooks": [h] }));
    }
    write(path, settings)
}

pub fn install(token: &str, permission: bool) -> Result<(), String> {
    let path = settings_path().ok_or("Could not find the Codex user folder")?;
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    install_into(&path, &exe, token, permission)
}

fn uninstall_from(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    let mut settings = read(path)?;
    let before = settings.clone();
    strip(&mut settings);
    if settings != before {
        write(path, settings)?;
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
    let settings = match read(path) {
        Ok(s) => s,
        Err(e) => {
            st.error = Some(e);
            return st;
        }
    };
    let Some(hooks) = settings.get("hooks").and_then(Value::as_object) else {
        return st;
    };
    let mut found = std::collections::HashSet::new();
    for (event, groups) in hooks {
        for group in groups.as_array().into_iter().flatten() {
            for h in group
                .get("hooks")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter(|h| is_ours(h))
            {
                st.installed = true;
                found.insert(event.as_str());
                let observes = h
                    .get("command")
                    .and_then(Value::as_str)
                    .is_some_and(|s| s.ends_with(OBSERVE_PERMISSION));
                if event == "PermissionRequest" && !observes {
                    st.permission = true;
                }
                let expected = hook_entry(exe, token, event == "PermissionRequest" && observes);
                if h.get("command") != expected.get("command")
                    || h.get("commandWindows") != expected.get("commandWindows")
                {
                    st.current = false;
                }
            }
        }
    }
    if st.installed && EVENTS.iter().any(|e| !found.contains(e)) {
        st.current = false;
    }
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
            error: Some("Could not find Codex hooks path or pet executable".into()),
        },
    }
}

/// Retain only a short error indication, never tool output or file contents.
fn failure(response: &Value) -> Option<String> {
    if response
        .get("isError")
        .or_else(|| response.get("is_error"))
        .and_then(Value::as_bool)
        == Some(true)
    {
        return Some("Tool failed".into());
    }
    if let Some(code) = response
        .get("exit_code")
        .and_then(Value::as_i64)
        .filter(|c| *c != 0)
    {
        return Some(format!("Exit code: {code}"));
    }
    if let Some(text) = response.as_str() {
        if let Ok(value) = serde_json::from_str::<Value>(text) {
            return failure(&value);
        }
        for line in text.lines() {
            let line = line.trim();
            for prefix in [
                "Process exited with code ",
                "Process exit code: ",
                "Exit code: ",
            ] {
                if let Some(code) = line
                    .strip_prefix(prefix)
                    .and_then(|s| s.split_whitespace().next())
                    .and_then(|s| s.parse::<i64>().ok())
                    .filter(|c| *c != 0)
                {
                    return Some(format!("Exit code: {code}"));
                }
            }
        }
    }
    None
}

pub(crate) fn summarize(input: &Value, observe: bool) -> Map<String, Value> {
    let mut m = claude::summarize(input);
    let session = input
        .get("session_id")
        .and_then(Value::as_str)
        .unwrap_or("?");
    m.insert("provider".into(), json!("codex"));
    m.insert("session_id".into(), json!(format!("codex:{session}")));
    if let Some(agent) = input.get("agent_id").and_then(Value::as_str) {
        m.insert("agent_id".into(), json!(format!("codex:{session}:{agent}")));
    }
    if let Some(turn) = input.get("turn_id").and_then(Value::as_str) {
        m.insert("turn_id".into(), json!(turn));
    }
    if input["hook_event_name"] == "PostToolUse" {
        if let Some(error) = failure(&input["tool_response"]) {
            m.insert("event".into(), json!("PostToolUseFailure"));
            m.insert("error".into(), json!(error));
        }
    }
    if input["hook_event_name"] == "PermissionRequest" && observe {
        m.insert("event".into(), json!("Notification"));
        m.insert("notification_type".into(), json!("permission_prompt"));
    }
    m
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn codex_events_are_namespaced_and_failures_are_normalized() {
        let m = summarize(
            &json!({ "hook_event_name": "PostToolUse", "session_id": "s", "agent_id": "a", "tool_name": "Bash", "tool_response": "Process exited with code 1\nsecret output" }),
            false,
        );
        assert_eq!(m["session_id"], "codex:s");
        assert_eq!(m["agent_id"], "codex:s:a");
        assert_eq!(m["event"], "PostToolUseFailure");
        assert_eq!(m["error"], "Exit code: 1");
        assert!(!Value::Object(m).to_string().contains("secret"));
        assert!(failure(&json!({ "exit_code": 0 })).is_none());
        assert!(failure(&json!("output: Exit code: 1")).is_none());
        assert!(failure(&json!({ "isError": true })).is_some());
        let p = summarize(
            &json!({ "hook_event_name": "PermissionRequest", "session_id": "s" }),
            true,
        );
        assert_eq!(p["event"], "Notification");
    }

    #[test]
    fn install_roundtrip_preserves_user_hooks_and_backups() {
        let dir = std::env::temp_dir().join(format!("clawd codex テスト {}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("hooks.json");
        let exe = Path::new("C:/Users/れいげつ/Pet's App/clawd-pet.exe");
        let original = json!({ "description": "日本語", "hooks": { "Stop": [{ "hooks": [{ "type": "command", "command": "mine.cmd" }] }] } }).to_string();
        std::fs::write(&p, &original).unwrap();
        install_into(&p, exe, "tok", true).unwrap();
        assert!(status_at(&p, exe, "tok").permission);
        assert!(!status_at(&p, exe, "old-token").current);
        install_into(&p, exe, "tok", false).unwrap();
        let st = status_at(&p, exe, "tok");
        assert!(st.installed && st.current && !st.permission);
        let s = read(&p).unwrap();
        assert_eq!(s["hooks"]["Stop"].as_array().unwrap().len(), 2);
        assert!(s["hooks"].get("PostToolUseFailure").is_none());
        assert_eq!(s["hooks"]["Interrupt"][0]["hooks"][0]["timeout"], 3);
        assert!(s["hooks"]["Stop"][1]["hooks"][0].get("args").is_none());
        assert_eq!(
            std::fs::read_to_string(p.with_extension("json.clawd-backup")).unwrap(),
            original
        );
        uninstall_from(&p).unwrap();
        assert_eq!(
            Value::Object(read(&p).unwrap()),
            serde_json::from_str::<Value>(&original).unwrap()
        );
        std::fs::write(&p, "{invalid").unwrap();
        assert!(install_into(&p, exe, "tok", false).is_err());
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "{invalid");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn windows_command_quotes_unicode_spaces_and_apostrophes() {
        let entry = hook_entry(Path::new("C:/れいげつ/Pet's App/pet.exe"), "tok", false);
        let encoded = entry["commandWindows"]
            .as_str()
            .unwrap()
            .split_whitespace()
            .last()
            .unwrap();
        let bytes = STANDARD.decode(encoded).unwrap();
        let utf16: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        let script = String::from_utf16(&utf16).unwrap();
        assert!(script.contains("& 'C:/れいげつ/Pet''s App/pet.exe'"));
        assert!(script.contains("ReadToEnd()"));
    }
}

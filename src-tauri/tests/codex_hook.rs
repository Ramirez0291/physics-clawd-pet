//! Exercise the real hook executable, including Windows' stdin/stdout transport.
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

fn exchange(input: Value, observe: bool, reply: &str, shell: bool) -> (Value, String) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let port = listener.local_addr().unwrap().port().to_string();
    let exe = env!("CARGO_BIN_EXE_clawd-pet");
    let mut command = if shell {
        use base64::{engine::general_purpose::STANDARD, Engine};
        let script = format!(
            "$OutputEncoding = [System.Text.UTF8Encoding]::new($false); \
             [Console]::InputEncoding = $OutputEncoding; [Console]::OutputEncoding = $OutputEncoding; \
             [Console]::In.ReadToEnd() | & '{}' '--clawd-pet-codex-hook' '{port}' 'test-token'{}",
            exe.replace('\'', "''"), if observe { " --observe-permission" } else { "" }
        );
        let bytes: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
        let mut command = Command::new("powershell.exe");
        command.args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            &STANDARD.encode(bytes),
        ]);
        command
    } else {
        let mut command = Command::new(exe);
        command.args(["--clawd-pet-codex-hook", &port, "test-token"]);
        if observe {
            command.arg("--observe-permission");
        }
        command
    };
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(input.to_string().as_bytes())
        .unwrap();
    let start = Instant::now();
    let mut stream = loop {
        if let Ok((stream, _)) = listener.accept() {
            break stream;
        }
        if start.elapsed() > Duration::from_secs(10) {
            let _ = child.kill();
            let output = child.wait_with_output().unwrap();
            panic!(
                "Hook did not connect: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    // macOS（BSD）上 accept 出来的连接会继承监听端口的非阻塞：钩子的数据还没到时
    // read_line 会直接报 WouldBlock。改回阻塞，靠下面的读超时兜底。
    stream.set_nonblocking(false).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    let mut line = String::new();
    BufReader::new(&stream).read_line(&mut line).unwrap();
    stream.write_all(format!("{reply}\n").as_bytes()).unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    (
        serde_json::from_str(&line).unwrap(),
        String::from_utf8(output.stdout).unwrap(),
    )
}

#[test]
fn actual_executable_forwards_codex_and_returns_permission_decisions() {
    let (msg, output) = exchange(
        json!({ "hook_event_name": "PreToolUse", "session_id": "s", "cwd": "E:/作業/demo", "tool_name": "Bash", "tool_input": { "command": "echo 日本語" } }),
        false,
        "ok",
        false,
    );
    assert_eq!(msg["provider"], "codex");
    assert_eq!(msg["session_id"], "codex:s");
    assert_eq!(msg["token"], "test-token");
    assert_eq!(msg["tool"], "echo 日本語");
    assert!(
        output.is_empty(),
        "state hooks must not inject model context"
    );
    let decision = json!({ "hookSpecificOutput": { "hookEventName": "PermissionRequest", "decision": { "behavior": "deny", "message": "Test denial" } } });
    let (_, output) = exchange(
        json!({ "hook_event_name": "PermissionRequest", "session_id": "s" }),
        false,
        &decision.to_string(),
        false,
    );
    assert_eq!(serde_json::from_str::<Value>(&output).unwrap(), decision);
    let (msg, output) = exchange(
        json!({ "hook_event_name": "PermissionRequest", "session_id": "s" }),
        true,
        "ok",
        false,
    );
    assert_eq!(msg["event"], "Notification");
    assert!(output.is_empty());
}

#[cfg(windows)]
#[test]
fn powershell_hook_preserves_utf8_and_stdout() {
    let decision = json!({ "hookSpecificOutput": { "hookEventName": "PermissionRequest", "decision": { "behavior": "allow" } } });
    let (msg, output) = exchange(
        json!({ "hook_event_name": "PermissionRequest", "session_id": "s", "cwd": "E:/日本語/空格 路径", "tool_name": "Bash", "tool_input": { "command": "echo 中文と日本語" } }),
        false,
        &decision.to_string(),
        true,
    );
    assert_eq!(msg["cwd"], "E:/日本語/空格 路径");
    assert_eq!(msg["tool"], "echo 中文と日本語");
    assert_eq!(
        serde_json::from_str::<Value>(output.trim_start_matches('\u{feff}').trim()).unwrap(),
        decision
    );
}

#[test]
fn missing_pet_falls_back_without_output_or_error() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    drop(listener);
    assert!(TcpStream::connect(addr).is_err());
    let mut child = Command::new(env!("CARGO_BIN_EXE_clawd-pet"))
        .args([
            "--clawd-pet-codex-hook",
            &addr.port().to_string(),
            "test-token",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(
            json!({ "hook_event_name": "PermissionRequest", "session_id": "s" })
                .to_string()
                .as_bytes(),
        )
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success());
    assert!(output.stdout.is_empty() && output.stderr.is_empty());
}

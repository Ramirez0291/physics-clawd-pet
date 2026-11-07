//! Startup errors must be visible even when the tray or WebView fails to start.

use std::fs::OpenOptions;
use std::io::{self, Write};
use std::path::PathBuf;

pub fn log(message: &str) -> io::Result<PathBuf> {
    eprintln!("Clawd Pet: {message}");
    // Keep this outside the config directory so it works when that directory is inaccessible.
    let path = std::env::temp_dir().join("clawd-pet-startup.log");
    let mut file = OpenOptions::new().create(true).append(true).open(&path)?;
    let version = env!("CARGO_PKG_VERSION");
    writeln!(file, "Clawd Pet {version} (pid {}): {message}", std::process::id())?;
    Ok(path)
}

pub fn report(message: &str) {
    let log = log(message);
    #[cfg(windows)]
    {
        use crate::lang::tr;
        let title = tr("Clawd Pet 启动问题", "Clawd Pet の起動時エラー", "Clawd Pet startup problem");
        let detail = match log {
            Ok(path) => {
                let label = tr("诊断日志", "診断ログ", "Diagnostic log");
                format!("{label}\n{}", path.display())
            }
            Err(e) => {
                let label = tr("无法写入诊断日志", "診断ログを書き込めません", "Could not write the diagnostic log");
                format!("{label}\n{e}")
            }
        };
        crate::platform::show_startup_problem(&title, &format!("{message}\n\n{detail}"));
    }
    #[cfg(not(windows))]
    let _ = log;
}

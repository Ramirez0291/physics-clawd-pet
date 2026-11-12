//! 和操作系统打交道的部分都在这里：每个平台一个目录（windows/、macos/），函数名和签名一致。
//! 下面按名字逐个 re-export 的就是每个平台都得实现的清单，哪个平台漏了一个就编译不过。
//! 平台目录以外的代码不写 #[cfg(windows)] 之类的平台分支。
//!
//! 窗口用 isize 当 id：Windows 上是 HWND，macOS 上是 CGWindowID。

#[cfg(windows)]
#[path = "windows/mod.rs"]
mod imp;

#[cfg(target_os = "macos")]
#[path = "macos/mod.rs"]
mod imp;

#[cfg(not(any(windows, target_os = "macos")))]
compile_error!("只支持 Windows 和 macOS");

#[cfg(windows)]
pub use imp::show_startup_problem;

pub use imp::{
    // 进程、界面语言、窗口
    ancestor_pids,
    place_overlay,
    prepare_overlay,
    single_instance,
    tray_template_icon,
    ui_language,
    window_id,
    // 桌面状态（光标、窗口、各块屏幕、全屏）
    cursor_pos,
    frame_bounds,
    fullscreen_monitors,
    keep_on_top,
    screens,
    SCREEN_POLL,
    visible_windows,
    window_for_pids,
    window_scale,
    // 焦点输入框；要不要用户授权（None = 不需要，托盘里就没有这一项）
    input_permission,
    request_input_permission,
    InputProbe,
    // 小助手：键鼠空闲、下载、选文件、系统代码页
    decode_system_codepage,
    http_get,
    idle_ms,
    pick_ics,
};

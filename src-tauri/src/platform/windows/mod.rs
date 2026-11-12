//! Windows 实现（Win32）。

mod assist;
mod desktop;
mod input;

use std::collections::HashMap;

use tauri::WebviewWindow;

use crate::desktop::Rect;
use crate::lang::Lang;

pub use assist::{decode_system_codepage, http_get, idle_ms, pick_ics};
pub use desktop::{
    cursor_pos, frame_bounds, fullscreen_monitors, keep_on_top, screens, visible_windows, window_for_pids,
    window_scale, SCREEN_POLL,
};
pub use input::{input_permission, request_input_permission, InputProbe};

/// 只允许一只宠物：第二个实例直接退出（返回 false）
pub fn single_instance() -> bool {
    use windows::core::w;
    use windows::Win32::Foundation::{GetLastError, ERROR_ALREADY_EXISTS};
    use windows::Win32::System::Threading::CreateMutexW;
    // 句柄故意不关：进程活着它就一直占着
    let created = unsafe { CreateMutexW(None, false, w!(r"Local\PhysicsClawdPet.SingleInstance")) };
    created.is_ok() && unsafe { GetLastError() } != ERROR_ALREADY_EXISTS
}

/// 我们自己窗口的 HWND
pub fn window_id(win: &WebviewWindow) -> tauri::Result<isize> {
    Ok(win.hwnd()?.0 as isize)
}

/// 托盘用应用图标
pub fn tray_template_icon() -> Option<tauri::image::Image<'static>> {
    None
}

pub fn show_startup_problem(title: &str, message: &str) {
    use windows::core::HSTRING;
    use windows::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONWARNING, MB_OK, MB_SETFOREGROUND};
    unsafe {
        MessageBoxW(None, &HSTRING::from(message), &HSTRING::from(title), MB_OK | MB_ICONWARNING | MB_SETFOREGROUND)
    };
}

/// 不进任务栏、不抢焦点在建窗口时就设好了。这里只做一件事：
/// 覆盖层横跨缩放不同的几块屏幕，挪动后它的 DPI 可能变，系统会发 WM_DPICHANGED，
/// tao 收到就按"逻辑尺寸不变"把窗口缩放一下——覆盖层就不再正好盖住那几块屏幕了。
/// 覆盖层的位置和大小全由观察线程按物理像素摆，所以把这条消息拦下来。
/// （WebView2 自己会跟着屏幕缩放调整渲染比例，不靠这条消息。）
pub fn prepare_overlay(win: &WebviewWindow) -> tauri::Result<()> {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::Shell::SetWindowSubclass;
    let hwnd = HWND(win.hwnd()?.0);
    // 后装的子类先收到消息：比 tao、wry 都早
    let _ = unsafe { SetWindowSubclass(hwnd, Some(keep_overlay_size), OVERLAY_SUBCLASS, 0) };
    Ok(())
}

const OVERLAY_SUBCLASS: usize = 0x434C_4157; // "CLAW"

unsafe extern "system" fn keep_overlay_size(
    hwnd: windows::Win32::Foundation::HWND,
    msg: u32,
    wparam: windows::Win32::Foundation::WPARAM,
    lparam: windows::Win32::Foundation::LPARAM,
    _id: usize,
    _data: usize,
) -> windows::Win32::Foundation::LRESULT {
    use windows::Win32::Foundation::LRESULT;
    use windows::Win32::UI::Shell::DefSubclassProc;
    use windows::Win32::UI::WindowsAndMessaging::WM_DPICHANGED;
    if msg == WM_DPICHANGED {
        return LRESULT(0);
    }
    DefSubclassProc(hwnd, msg, wparam, lparam)
}

/// 把覆盖层摆到 r（物理像素）：位置和大小一次设好，中间不会出现只挪了一半的状态
pub fn place_overlay(win: &WebviewWindow, r: Rect) -> tauri::Result<()> {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{SetWindowPos, SWP_NOACTIVATE, SWP_NOZORDER};
    let hwnd = HWND(win.hwnd()?.0);
    unsafe {
        SetWindowPos(hwnd, None, r.left, r.top, r.width(), r.height(), SWP_NOZORDER | SWP_NOACTIVATE)
    }
    .map_err(|e| tauri::Error::Io(std::io::Error::other(e)))
}

pub fn ui_language() -> Lang {
    from_langid(unsafe { windows::Win32::Globalization::GetUserDefaultUILanguage() })
}

/// Windows 的 LANGID：低 10 位是主语言（0x04 = 中文，简体繁体都算；0x11 = 日文）
fn from_langid(id: u16) -> Lang {
    match id & 0x3ff {
        0x04 => Lang::Zh,
        0x11 => Lang::Ja,
        _ => Lang::En,
    }
}

/// 本进程往上的祖先进程（父、祖父……），用来找是哪个窗口在跑 Claude Code
pub fn ancestor_pids() -> Vec<u32> {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn langid_maps_primary_language() {
        assert_eq!(from_langid(0x0411), Lang::Ja); // ja-JP
        assert_eq!(from_langid(0x0804), Lang::Zh); // zh-CN
        assert_eq!(from_langid(0x0404), Lang::Zh); // zh-TW
        assert_eq!(from_langid(0x0c04), Lang::Zh); // zh-HK
        assert_eq!(from_langid(0x0409), Lang::En); // en-US
        assert_eq!(from_langid(0x0412), Lang::En); // ko-KR 归到英文
    }
}

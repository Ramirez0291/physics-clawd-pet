//! 桌面状态查询（Win32）：光标、可见窗口、可站立的窗口顶边、全屏检测。
//! 全部只读，不移动、不修改任何其他程序的窗口。

use std::mem::size_of;

use windows::core::BOOL;
use windows::Win32::Foundation::{HWND, LPARAM, POINT, RECT};
use windows::Win32::Graphics::Dwm::{
    DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS,
};
use windows::Win32::Graphics::Gdi::{
    GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
};
use windows::Win32::UI::HiDpi::GetDpiForWindow;
use windows::Win32::UI::Shell::{
    SHQueryUserNotificationState, QUNS_PRESENTATION_MODE, QUNS_RUNNING_D3D_FULL_SCREEN,
};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetClassNameW, GetCursorPos, GetForegroundWindow, GetWindow, GetWindowLongPtrW,
    GetWindowRect, GetWindowThreadProcessId, IsIconic, IsWindowVisible, IsZoomed, SystemParametersInfoW,
    GWL_EXSTYLE, GWL_STYLE, GW_OWNER, SPI_GETWORKAREA, SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS, WS_CAPTION,
    WS_EX_APPWINDOW, WS_EX_TOOLWINDOW, WS_EX_TRANSPARENT,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct Rect {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

impl Rect {
    pub fn width(&self) -> i32 {
        self.right - self.left
    }
    pub fn height(&self) -> i32 {
        self.bottom - self.top
    }
}

impl From<RECT> for Rect {
    fn from(r: RECT) -> Self {
        Rect { left: r.left, top: r.top, right: r.right, bottom: r.bottom }
    }
}

/// 一个顶层窗口。`platform` 表示它的顶边可以站人；不能站的窗口仍然参与遮挡计算。
#[derive(Clone, Copy, Debug)]
pub struct WinInfo {
    pub hwnd: isize,
    pub rect: Rect,
    pub platform: bool,
}

/// 可站立的一段窗口顶边（物理像素）
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Segment {
    pub id: isize,
    pub x0: i32,
    pub x1: i32,
    pub y: i32,
}

fn hwnd(id: isize) -> HWND {
    HWND(id as *mut core::ffi::c_void)
}

pub fn cursor_pos() -> Option<(i32, i32)> {
    let mut p = POINT::default();
    unsafe { GetCursorPos(&mut p) }.ok()?;
    Some((p.x, p.y))
}

/// 主屏工作区（不含任务栏），物理像素
pub fn primary_work_area() -> Option<Rect> {
    let mut r = RECT::default();
    unsafe {
        SystemParametersInfoW(
            SPI_GETWORKAREA,
            0,
            Some(&mut r as *mut RECT as *mut _),
            SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0),
        )
    }
    .ok()?;
    Some(r.into())
}

pub fn window_scale(id: isize) -> f64 {
    let dpi = unsafe { GetDpiForWindow(hwnd(id)) };
    if dpi == 0 {
        1.0
    } else {
        dpi as f64 / 96.0
    }
}

fn class_name(h: HWND) -> String {
    let mut buf = [0u16; 128];
    let n = unsafe { GetClassNameW(h, &mut buf) };
    String::from_utf16_lossy(&buf[..n.max(0) as usize])
}

fn is_cloaked(h: HWND) -> bool {
    let mut cloaked: u32 = 0;
    unsafe {
        DwmGetWindowAttribute(
            h,
            DWMWA_CLOAKED,
            &mut cloaked as *mut u32 as *mut _,
            size_of::<u32>() as u32,
        )
    }
    .map(|_| cloaked != 0)
    .unwrap_or(false)
}

/// 窗口肉眼可见的边框（不含 Win10/11 的透明阴影边）。窗口没了/最小化/隐藏时返回 None。
pub fn frame_bounds(id: isize) -> Option<Rect> {
    let h = hwnd(id);
    unsafe {
        if !IsWindowVisible(h).as_bool() || IsIconic(h).as_bool() {
            return None;
        }
    }
    if is_cloaked(h) {
        return None;
    }
    let mut r = RECT::default();
    let ok = unsafe {
        DwmGetWindowAttribute(
            h,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            &mut r as *mut RECT as *mut _,
            size_of::<RECT>() as u32,
        )
    };
    if ok.is_err() {
        unsafe { GetWindowRect(h, &mut r) }.ok()?;
    }
    let r: Rect = r.into();
    (r.width() > 0 && r.height() > 0).then_some(r)
}

/// 桌面、任务栏、通知区域之类：不能站，也不当遮挡物
const SHELL_CLASSES: &[&str] = &["Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd"];
/// 系统弹出层（开始菜单、搜索、托盘溢出）：会遮挡，但不能站
const NON_PLATFORM_CLASSES: &[&str] = &[
    "Windows.UI.Core.CoreWindow",
    "XamlExplorerHostIslandWindow",
    "TopLevelWindowForOverflowXamlIsland",
    "NotifyIconOverflowWindow",
];

unsafe extern "system" fn collect(h: HWND, lparam: LPARAM) -> BOOL {
    let out = &mut *(lparam.0 as *mut Vec<isize>);
    out.push(h.0 as isize);
    BOOL(1)
}

/// 所有可见的顶层窗口，按 Z 序从上到下排列。`skip` 是我们自己的覆盖层。
pub fn visible_windows(skip: isize) -> Vec<WinInfo> {
    let mut handles: Vec<isize> = Vec::with_capacity(256);
    let _ = unsafe { EnumWindows(Some(collect), LPARAM(&mut handles as *mut Vec<isize> as isize)) };

    let mut out = Vec::new();
    for id in handles {
        if id == skip {
            continue;
        }
        let h = hwnd(id);
        let Some(rect) = frame_bounds(id) else { continue };
        let ex = unsafe { GetWindowLongPtrW(h, GWL_EXSTYLE) } as u32;
        // 点击穿透的透明覆盖层（显卡叠加层、其他桌宠……）既不能站也不遮挡
        if ex & WS_EX_TRANSPARENT.0 != 0 {
            continue;
        }
        let class = class_name(h);
        if SHELL_CLASSES.contains(&class.as_str()) {
            continue;
        }
        let tool = ex & WS_EX_TOOLWINDOW.0 != 0 && ex & WS_EX_APPWINDOW.0 == 0;
        let platform = !tool
            && !NON_PLATFORM_CLASSES.contains(&class.as_str())
            && rect.width() >= 120
            && rect.height() >= 60;
        out.push(WinInfo { hwnd: id, rect, platform });
    }
    out
}

/// 按顺序看这些进程（通常是某个进程的父、祖父……），返回第一个拥有可见主窗口的进程的那个窗口。
/// 同一个进程有好几个窗口时取 Z 序最上面的。用来找"在跑 Claude Code 的是哪个终端/编辑器窗口"。
pub fn window_for_pids(pids: &[u32]) -> Option<isize> {
    if pids.is_empty() {
        return None;
    }
    let mut handles: Vec<isize> = Vec::with_capacity(256);
    let _ = unsafe { EnumWindows(Some(collect), LPARAM(&mut handles as *mut Vec<isize> as isize)) };
    let mut by_pid: std::collections::HashMap<u32, isize> = std::collections::HashMap::new();
    for id in handles {
        let h = hwnd(id);
        if frame_bounds(id).is_none() {
            continue;
        }
        let ex = unsafe { GetWindowLongPtrW(h, GWL_EXSTYLE) } as u32;
        let tool = ex & WS_EX_TOOLWINDOW.0 != 0 && ex & WS_EX_APPWINDOW.0 == 0;
        let owned = unsafe { GetWindow(h, GW_OWNER) }.is_ok_and(|o| !o.0.is_null());
        if tool || owned || ex & WS_EX_TRANSPARENT.0 != 0 {
            continue;
        }
        let mut pid = 0u32;
        unsafe { GetWindowThreadProcessId(h, Some(&mut pid)) };
        by_pid.entry(pid).or_insert(id);
    }
    pids.iter().find_map(|p| by_pid.get(p).copied())
}

/// 计算可站立的顶边：每个窗口的顶边减去被它上面（Z 序更高）的窗口挡住的部分，再裁到工作区内。
pub fn platform_segments(wins: &[WinInfo], area: Rect, min_len: i32) -> Vec<Segment> {
    let mut out = Vec::new();
    for (i, w) in wins.iter().enumerate() {
        if !w.platform {
            continue;
        }
        let y = w.rect.top;
        // 顶边贴着工作区顶部（比如最大化窗口）就没地方站了
        if y <= area.top || y >= area.bottom {
            continue;
        }
        let mut segs = vec![(w.rect.left.max(area.left), w.rect.right.min(area.right))];
        for above in &wins[..i] {
            let r = above.rect;
            if r.top < y && r.bottom >= y {
                segs = segs
                    .into_iter()
                    .flat_map(|(a, b)| {
                        let mut parts = Vec::with_capacity(2);
                        if r.left > a {
                            parts.push((a, b.min(r.left)));
                        }
                        if r.right < b {
                            parts.push((a.max(r.right), b));
                        }
                        parts
                    })
                    .filter(|(a, b)| b > a)
                    .collect();
                if segs.is_empty() {
                    break;
                }
            }
        }
        for (x0, x1) in segs {
            if x1 - x0 >= min_len {
                out.push(Segment { id: w.hwnd, x0, x1, y });
            }
        }
    }
    out
}

/// 主屏上是否有全屏程序在前台（游戏、全屏视频、演示模式）
pub fn fullscreen_on_primary(skip: isize) -> bool {
    unsafe {
        if let Ok(state) = SHQueryUserNotificationState() {
            if state == QUNS_RUNNING_D3D_FULL_SCREEN || state == QUNS_PRESENTATION_MODE {
                return true;
            }
        }
        let fg = GetForegroundWindow();
        if fg.is_invalid() || fg.0 as isize == skip {
            return false;
        }
        let class = class_name(fg);
        if SHELL_CLASSES.contains(&class.as_str()) {
            return false;
        }
        let mon = MonitorFromWindow(fg, MONITOR_DEFAULTTONEAREST);
        let mut mi = MONITORINFO { cbSize: size_of::<MONITORINFO>() as u32, ..Default::default() };
        if !GetMonitorInfoW(mon, &mut mi).as_bool() {
            return false;
        }
        const MONITORINFOF_PRIMARY: u32 = 1;
        if mi.dwFlags & MONITORINFOF_PRIMARY == 0 {
            return false;
        }
        let mut r = RECT::default();
        if GetWindowRect(fg, &mut r).is_err() {
            return false;
        }
        let m = mi.rcMonitor;
        let covers = r.left <= m.left && r.top <= m.top && r.right >= m.right && r.bottom >= m.bottom;
        if !covers {
            return false;
        }
        // 任务栏自动隐藏时，普通最大化窗口也会铺满屏幕：有标题栏的最大化窗口不算全屏
        let style = GetWindowLongPtrW(fg, GWL_STYLE) as u32;
        !(IsZoomed(fg).as_bool() && style & WS_CAPTION.0 == WS_CAPTION.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn win(id: isize, l: i32, t: i32, r: i32, b: i32) -> WinInfo {
        WinInfo { hwnd: id, rect: Rect { left: l, top: t, right: r, bottom: b }, platform: true }
    }
    const AREA: Rect = Rect { left: 0, top: 0, right: 1920, bottom: 1040 };

    #[test]
    fn top_edge_is_split_by_window_above() {
        // 窗口 2 在窗口 1 上面，盖住了窗口 1 顶边的中间一段
        let wins = [win(2, 400, 100, 700, 600), win(1, 200, 300, 1000, 800)];
        let segs = platform_segments(&wins, AREA, 10);
        assert_eq!(
            segs,
            vec![
                Segment { id: 2, x0: 400, x1: 700, y: 100 },
                Segment { id: 1, x0: 200, x1: 400, y: 300 },
                Segment { id: 1, x0: 700, x1: 1000, y: 300 },
            ]
        );
    }

    #[test]
    fn window_below_the_edge_does_not_occlude() {
        // 上层窗口的顶边比下层窗口顶边还低：挡不住下层窗口的顶边
        let wins = [win(2, 0, 500, 1920, 900), win(1, 200, 300, 1000, 800)];
        let segs = platform_segments(&wins, AREA, 10);
        assert!(segs.contains(&Segment { id: 1, x0: 200, x1: 1000, y: 300 }));
    }

    #[test]
    fn maximized_window_hides_everything_behind_it_and_has_no_room_on_top() {
        let mut max = win(9, 0, 0, 1920, 1040);
        max.platform = true;
        let wins = [max, win(1, 200, 300, 1000, 800)];
        assert!(platform_segments(&wins, AREA, 10).is_empty());
    }

    #[test]
    fn segments_are_clipped_to_work_area_and_min_length() {
        let wins = [win(1, -300, 200, 50, 500), win(2, 1900, 400, 2400, 700)];
        let segs = platform_segments(&wins, AREA, 30);
        assert_eq!(segs, vec![Segment { id: 1, x0: 0, x1: 50, y: 200 }]);
    }
}

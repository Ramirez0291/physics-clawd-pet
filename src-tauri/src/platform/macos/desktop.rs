//! 桌面状态查询（macOS）：光标、可见窗口、工作区、全屏检测。
//! 全部只读，不移动、不修改任何其他程序的窗口。
//!
//! Desktop geometry uses global macOS points, independent of each display's backing scale.
//! The renderer uses devicePixelRatio for sharp output; it must not change desktop geometry.
//! A single screen-sized overlay follows the pet, so separate Spaces do not clip a spanning window.

use std::collections::HashMap;

use objc2_app_kit::NSScreen;
use objc2_core_foundation::{CFArray, CFBoolean, CFDictionary, CFNumber, CFRetained, CFString, CFType, CGRect};
use objc2_core_graphics::{
    kCGWindowAlpha, kCGWindowBounds, kCGWindowIsOnscreen, kCGWindowLayer, kCGWindowNumber, kCGWindowOwnerPID, CGEvent,
    CGRectMakeWithDictionaryRepresentation, CGWindowListCopyWindowInfo, CGWindowListOption,
};

use crate::desktop::{Rect, Screen, WinInfo};

/// 普通程序窗口的层级（kCGNormalWindowLevel）
const NORMAL_LAYER: i64 = 0;
/// 程序坞的层级（kCGDockWindowLevel）。比它高的是程序坞、菜单栏、通知、弹出菜单之类
const DOCK_LAYER: i64 = 20;

/// Desktop units per CSS pixel. AppKit, CoreGraphics and accessibility all use points.
pub(super) fn scale() -> f64 {
    1.0
}

/// Convert an AppKit bottom-left rectangle into global top-left desktop coordinates.
fn desktop_rect(r: CGRect, primary_top: f64) -> Rect {
    Rect {
        left: r.origin.x.round() as i32,
        top: (primary_top - r.origin.y - r.size.height).round() as i32,
        right: (r.origin.x + r.size.width).round() as i32,
        bottom: (primary_top - r.origin.y).round() as i32,
    }
}

/// Convert CoreGraphics/accessibility rectangles to desktop units (points on macOS).
pub(super) fn to_rect(b: CGRect, s: f64) -> Rect {
    Rect {
        left: (b.origin.x * s).round() as i32,
        top: (b.origin.y * s).round() as i32,
        right: ((b.origin.x + b.size.width) * s).round() as i32,
        bottom: ((b.origin.y + b.size.height) * s).round() as i32,
    }
}

pub fn cursor_pos() -> Option<(i32, i32)> {
    // 空事件的位置就是当前光标位置（左上角原点的全局点坐标）
    let event = CGEvent::new(None)?;
    let p = CGEvent::location(Some(&event));
    let s = scale();
    Some(((p.x * s).round() as i32, (p.y * s).round() as i32))
}

/// All displays, in one coordinate system even when their backing scales differ.
pub fn screens() -> Vec<Screen> {
    dispatch2::run_on_main(|mtm| {
        let list = NSScreen::screens(mtm);
        let Some(primary) = list.firstObject() else { return vec![] };
        let top = primary.frame().origin.y + primary.frame().size.height;
        list.iter()
            .enumerate()
            .map(|(i, screen)| Screen {
                monitor: desktop_rect(screen.frame(), top),
                work: desktop_rect(screen.visibleFrame(), top),
                primary: i == 0,
            })
            .collect()
    })
}

pub fn window_scale(_id: isize) -> f64 {
    1.0
}

type WindowInfo = CFDictionary<CFString, CFType>;

/// CGWindowListCopyWindowInfo：每个窗口一个字典，按 Z 序从上到下。
/// 拿窗口位置、层级、所属进程不需要"屏幕录制"权限（只有窗口标题要）。
fn window_list(option: CGWindowListOption, relative_to: isize) -> Vec<CFRetained<WindowInfo>> {
    let Some(list) = CGWindowListCopyWindowInfo(option, relative_to as u32) else { return vec![] };
    // 文档保证每一项都是 CFString → CFType 的字典
    let list: CFRetained<CFArray<WindowInfo>> = unsafe { CFRetained::cast_unchecked(list) };
    (0..list.len()).filter_map(|i| list.get(i)).collect()
}

fn on_screen_windows() -> Vec<CFRetained<WindowInfo>> {
    window_list(CGWindowListOption::OptionOnScreenOnly | CGWindowListOption::ExcludeDesktopElements, 0)
}

fn int(d: &WindowInfo, key: &CFString) -> Option<i64> {
    d.get(key)?.downcast::<CFNumber>().ok()?.as_i64()
}

fn float(d: &WindowInfo, key: &CFString) -> Option<f64> {
    d.get(key)?.downcast::<CFNumber>().ok()?.as_f64()
}

/// 窗口的外框（点，不含阴影）
fn bounds(d: &WindowInfo) -> Option<CGRect> {
    let b = d.get(unsafe { kCGWindowBounds })?.downcast::<CFDictionary>().ok()?;
    let mut r = CGRect::default();
    unsafe { CGRectMakeWithDictionaryRepresentation(Some(&b), &mut r) }.then_some(r)
}

/// 屏幕列表多久看一次。读 NSScreen 要切到主线程，不能太勤；程序坞、菜单栏不会突然弹出来，每秒一次够了。
pub const SCREEN_POLL: std::time::Duration = std::time::Duration::from_secs(1);

/// macOS 上覆盖层的窗口层级不会被别的程序改掉，什么都不用做
pub fn keep_on_top(_overlay: isize, _pet: Option<Rect>) -> Option<String> {
    None
}

/// 窗口外框。窗口没了、最小化了、切到别的桌面（Space）了、所在程序被隐藏了时返回 None。
pub fn frame_bounds(id: isize) -> Option<Rect> {
    if id <= 0 {
        return None;
    }
    let d = window_list(CGWindowListOption::OptionIncludingWindow, id).into_iter().next()?;
    // 不在屏幕上的窗口这个键要么是 false 要么干脆没有
    let on_screen =
        d.get(unsafe { kCGWindowIsOnscreen }).and_then(|v| v.downcast::<CFBoolean>().ok()).is_some_and(|b| b.as_bool());
    if !on_screen {
        return None;
    }
    let r = to_rect(bounds(&d)?, scale());
    (r.width() > 0 && r.height() > 0).then_some(r)
}

/// 所有可见的窗口，按 Z 序从上到下排列。`skip` 是我们自己的覆盖层。
pub fn visible_windows(skip: isize) -> Vec<WinInfo> {
    let s = scale();
    let areas = screens();
    let mut out = Vec::new();
    for d in on_screen_windows() {
        let Some(id) = int(&d, unsafe { kCGWindowNumber }).map(|n| n as isize) else { continue };
        if id == skip {
            continue;
        }
        // 程序坞、菜单栏、通知、弹出菜单：不能站，也不当遮挡物（基本都在工作区外面）
        let layer = int(&d, unsafe { kCGWindowLayer }).unwrap_or(NORMAL_LAYER);
        if !(NORMAL_LAYER..DOCK_LAYER).contains(&layer) {
            continue;
        }
        // 完全透明的窗口
        if float(&d, unsafe { kCGWindowAlpha }).is_some_and(|a| a <= 0.0) {
            continue;
        }
        let Some(b) = bounds(&d) else { continue };
        let rect = to_rect(b, s);
        if rect.width() <= 0 || rect.height() <= 0 {
            continue;
        }
        // 浮在普通窗口上面、却盖满整个工作区的：多半是别的透明覆盖层（其他桌宠、录屏标注……），
        // 它们点击穿透，当遮挡物会把所有窗口顶边都挡掉。macOS 查不到窗口是否穿透，只能这样猜。
        if layer > NORMAL_LAYER
            && areas.iter().any(|s| {
                let a = s.work;
                rect.left <= a.left && rect.top <= a.top && rect.right >= a.right && rect.bottom >= a.bottom
            })
        {
            continue;
        }
        // 普通窗口能站；浮动面板之类会遮挡但不能站
        let platform = layer == NORMAL_LAYER && rect.width() >= 120 && rect.height() >= 60;
        out.push(WinInfo { id, rect, platform });
    }
    out
}

/// 按顺序看这些进程（通常是某个进程的父、祖父……），返回第一个拥有可见普通窗口的进程的那个窗口。
/// 同一个进程有好几个窗口时取 Z 序最上面的。用来找"在跑 Claude Code 的是哪个终端/编辑器窗口"。
pub fn window_for_pids(pids: &[u32]) -> Option<isize> {
    if pids.is_empty() {
        return None;
    }
    let mut by_pid: HashMap<u32, isize> = HashMap::new();
    for d in on_screen_windows() {
        if int(&d, unsafe { kCGWindowLayer }) != Some(NORMAL_LAYER) {
            continue;
        }
        let (Some(id), Some(pid)) = (int(&d, unsafe { kCGWindowNumber }), int(&d, unsafe { kCGWindowOwnerPID })) else {
            continue;
        };
        by_pid.entry(pid as u32).or_insert(id as isize);
    }
    pids.iter().find_map(|p| by_pid.get(p).copied())
}

/// Check the frontmost ordinary window on each display independently.
pub fn fullscreen_monitors(skip: isize) -> Vec<Rect> {
    let windows: Vec<Rect> = on_screen_windows()
        .iter()
        .filter(|d| int(d, unsafe { kCGWindowNumber }) != Some(skip as i64))
        .filter(|d| int(d, unsafe { kCGWindowLayer }) == Some(NORMAL_LAYER))
        .filter(|d| !float(d, unsafe { kCGWindowAlpha }).is_some_and(|a| a <= 0.0))
        .filter_map(|d| bounds(d).map(|b| to_rect(b, 1.0)))
        .collect();
    covered_monitors(&screens(), &windows)
}

fn covered_monitors(screens: &[Screen], windows: &[Rect]) -> Vec<Rect> {
    screens
        .iter()
        .filter_map(|s| {
            let m = s.monitor;
            windows
                .iter()
                .find(|w| w.left < m.right && w.right > m.left && w.top < m.bottom && w.bottom > m.top)
                .filter(|w| w.left <= m.left && w.top <= m.top && w.right >= m.right && w.bottom >= m.bottom)
                .map(|_| m)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use objc2_core_foundation::{CGPoint, CGSize};

    #[test]
    fn stacked_retina_and_ultrawide_use_points_and_negative_origins() {
        let lg = CGRect::new(CGPoint::new(-868.0, 1117.0), CGSize::new(3440.0, 1440.0));
        assert_eq!(desktop_rect(lg, 1117.0), Rect { left: -868, top: -1440, right: 2572, bottom: 0 });
        let mac = CGRect::new(CGPoint::new(0.0, 61.0), CGSize::new(1728.0, 1023.0));
        assert_eq!(desktop_rect(mac, 1117.0), Rect { left: 0, top: 33, right: 1728, bottom: 1056 });
    }

    #[test]
    fn fullscreen_is_checked_independently_on_each_display() {
        let mac = Rect { left: 0, top: 0, right: 1728, bottom: 1117 };
        let lg = Rect { left: -868, top: -1440, right: 2572, bottom: 0 };
        let screens =
            [Screen { monitor: mac, work: mac, primary: true }, Screen { monitor: lg, work: lg, primary: false }];
        let normal = Rect { left: 50, top: 100, right: 1000, bottom: 900 };
        assert_eq!(covered_monitors(&screens, &[normal, lg]), vec![lg]);
        assert_eq!(covered_monitors(&screens, &[mac, lg]), vec![mac, lg]);
        let zoomed = Rect { top: -1410, ..lg };
        assert!(covered_monitors(&screens, &[normal, zoomed]).is_empty());
        assert!(covered_monitors(&screens, &[normal, mac]).is_empty());
    }
}

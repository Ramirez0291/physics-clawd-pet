//! 输入框检测：找出当前有键盘焦点的文本输入框，让宠物别挡着它。
//! 先问 UI Automation 焦点控件（Win32、WinUI、Chrome、Electron 都支持），
//! 拿不到或者是铺满屏幕的大文档时，退回到系统插入符（GetGUIThreadInfo）附近的一小块。
//! 全部只读，不碰任何窗口。单独一个线程：跨进程的 UIA 调用偶尔会慢，不能拖住观察线程。

use std::mem::size_of;
use std::thread;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use windows::Win32::Foundation::{HWND, POINT};
use windows::Win32::Graphics::Gdi::ClientToScreen;
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED};
use windows::Win32::UI::Accessibility::{
    CUIAutomation, IUIAutomation, UIA_DocumentControlTypeId, UIA_EditControlTypeId,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetForegroundWindow, GetGUIThreadInfo, GetWindowThreadProcessId, GUITHREADINFO,
};

use crate::desktop::{self, Rect};
use crate::watcher::{Shared, OVERLAY};

#[derive(Serialize, Clone, PartialEq)]
struct ZoneMsg {
    left: f64,
    top: f64,
    right: f64,
    bottom: f64,
}

pub fn spawn(app: AppHandle, shared: Shared, overlay_hwnd: isize) {
    thread::Builder::new()
        .name("input-watcher".into())
        .spawn(move || run(app, shared, overlay_hwnd))
        .expect("failed to spawn input watcher");
}

fn run(app: AppHandle, shared: Shared, overlay_hwnd: isize) {
    let probe = Probe::new();
    let mut last: Option<Option<ZoneMsg>> = None;
    loop {
        let (hidden, resync) = {
            let mut s = shared.lock().unwrap();
            (s.manual_hidden, std::mem::take(&mut s.input_resync))
        };
        if resync {
            last = None;
        }
        let zone = if hidden {
            None
        } else {
            desktop::primary_work_area().and_then(|area| {
                let scale = desktop::window_scale(overlay_hwnd);
                probe.focused_input(overlay_hwnd, area).map(|r| ZoneMsg {
                    left: (r.left - area.left) as f64 / scale,
                    top: (r.top - area.top) as f64 / scale,
                    right: (r.right - area.left) as f64 / scale,
                    bottom: (r.bottom - area.top) as f64 / scale,
                })
            })
        };
        if last.as_ref() != Some(&zone) {
            let _ = app.emit_to(OVERLAY, "desk-input", zone.clone());
            last = Some(zone);
        }
        thread::sleep(Duration::from_millis(250));
    }
}

struct Probe {
    uia: Option<IUIAutomation>,
}

impl Probe {
    fn new() -> Self {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }
        let uia = unsafe { CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER) }.ok();
        Probe { uia }
    }

    /// 焦点输入框（屏幕物理像素）
    fn focused_input(&self, skip: isize, area: Rect) -> Option<Rect> {
        let fg = unsafe { GetForegroundWindow() };
        if fg.is_invalid() || fg.0 as isize == skip {
            return None;
        }
        // 超过工作区一半的"输入框"是编辑器、终端、整个网页：躲不开，只躲插入符附近
        let big = |r: &Rect| {
            (r.width() as i64) * (r.height() as i64) * 2 > (area.width() as i64) * (area.height() as i64)
        };
        if let Some(r) = self.uia_focus() {
            if !big(&r) {
                return Some(r);
            }
        }
        caret_rect(fg).map(|c| Rect {
            left: c.left - 160,
            top: c.top - 24,
            right: c.right + 160,
            bottom: c.bottom + 24,
        })
    }

    fn uia_focus(&self) -> Option<Rect> {
        let uia = self.uia.as_ref()?;
        unsafe {
            let el = uia.GetFocusedElement().ok()?;
            let ct = el.CurrentControlType().ok()?;
            if ct != UIA_EditControlTypeId && ct != UIA_DocumentControlTypeId {
                return None;
            }
            if el.CurrentIsOffscreen().map(|b| b.as_bool()).unwrap_or(false) {
                return None;
            }
            let r: Rect = el.CurrentBoundingRectangle().ok()?.into();
            (r.width() > 0 && r.height() > 0).then_some(r)
        }
    }
}

/// 前台线程的系统插入符（屏幕坐标）。很多现代程序不创建系统插入符，那就是 None。
fn caret_rect(fg: HWND) -> Option<Rect> {
    unsafe {
        let tid = GetWindowThreadProcessId(fg, None);
        let mut info = GUITHREADINFO { cbSize: size_of::<GUITHREADINFO>() as u32, ..Default::default() };
        GetGUIThreadInfo(tid, &mut info).ok()?;
        if info.hwndCaret.is_invalid() {
            return None;
        }
        let rc = info.rcCaret;
        let mut tl = POINT { x: rc.left, y: rc.top };
        let mut br = POINT { x: rc.right, y: rc.bottom };
        if !ClientToScreen(info.hwndCaret, &mut tl).as_bool() || !ClientToScreen(info.hwndCaret, &mut br).as_bool() {
            return None;
        }
        let r = Rect { left: tl.x, top: tl.y, right: br.x.max(tl.x + 1), bottom: br.y.max(tl.y + 1) };
        Some(r)
    }
}

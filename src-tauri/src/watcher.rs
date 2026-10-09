//! 桌面观察线程：在原生侧轮询光标、窗口和全屏状态，只在有变化时通知前端。
//! 以前前端每帧都要 IPC 查一次光标，现在空闲时几乎没有 IPC。

use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize};

use crate::desktop::{self, Rect, Segment};

pub const OVERLAY: &str = "overlay";

/// 前端通过命令写入、观察线程读取的状态
#[derive(Default)]
pub struct DeskState {
    /// 宠物可点击区域 [x0, y0, x1, y1]，覆盖层 CSS 像素
    pub hit: Option<[f64; 4]>,
    pub dragging: bool,
    /// 宠物脚下的窗口，需要高频追踪它的位置
    pub carrier: Option<isize>,
    pub manual_hidden: bool,
    /// 前端刚加载完，需要把当前状态全部重发一遍
    pub resync: bool,
    /// 同上，给输入框检测线程用
    pub input_resync: bool,
}

pub type Shared = Arc<Mutex<DeskState>>;

#[derive(Serialize, Clone)]
struct PlatformMsg {
    id: i64,
    x0: f64,
    x1: f64,
    y: f64,
}

#[derive(Serialize, Clone)]
struct CarrierMsg {
    id: i64,
    /// 毫秒，观察线程启动后的单调时间
    t: f64,
    left: f64,
    top: f64,
    right: f64,
    gone: bool,
}

#[derive(Serialize, Clone)]
struct DndMsg {
    hidden: bool,
    reason: &'static str,
}

#[derive(Serialize, Clone)]
struct PointMsg {
    x: f64,
    y: f64,
}

/// 物理像素 ↔ 覆盖层 CSS 像素
#[derive(Clone, Copy)]
struct Geometry {
    area: Rect,
    scale: f64,
}

impl Geometry {
    fn x(&self, px: i32) -> f64 {
        (px - self.area.left) as f64 / self.scale
    }
    fn y(&self, py: i32) -> f64 {
        (py - self.area.top) as f64 / self.scale
    }
}

pub fn spawn(app: AppHandle, shared: Shared, overlay_hwnd: isize, area: Rect) {
    thread::Builder::new()
        .name("desk-watcher".into())
        .spawn(move || run(app, shared, overlay_hwnd, area))
        .expect("failed to spawn desk watcher");
}

fn run(app: AppHandle, shared: Shared, overlay_hwnd: isize, area: Rect) {
    let start = Instant::now();
    let ms = || start.elapsed().as_secs_f64() * 1000.0;
    let mut geo = Geometry { area, scale: desktop::window_scale(overlay_hwnd) };

    let mut ignoring = true;
    let mut hover = false;
    let mut last_cursor = (i32::MIN, i32::MIN);
    let mut last_cursor_emit = start;
    let mut segments: Vec<Segment> = Vec::new();
    let mut last_enum: Option<Instant> = None;
    let mut last_fullscreen_check: Option<Instant> = None;
    let mut fullscreen = false;
    let mut hidden = false;
    let mut last_area_check = start;
    let mut carrier_rect: Option<(isize, Rect)> = None;

    loop {
        let (hit, dragging, carrier, manual_hidden, resync) = {
            let mut s = shared.lock().unwrap();
            (s.hit, s.dragging, s.carrier, s.manual_hidden, std::mem::take(&mut s.resync))
        };
        let Some(win) = app.get_webview_window(OVERLAY) else {
            thread::sleep(Duration::from_millis(100));
            continue;
        };
        let now = Instant::now();
        let mut force_platforms = resync;

        if resync {
            // 前端重新加载过：不能信任之前的穿透状态，强制重设
            ignoring = !(hover || dragging);
            let _ = win.set_ignore_cursor_events(ignoring);
            let _ = app.emit_to(OVERLAY, "desk-dnd", DndMsg { hidden, reason: "sync" });
            let _ = app.emit_to(OVERLAY, "desk-hover", hover);
            carrier_rect = None;
        }

        // 工作区或缩放变了（换分辨率、挪任务栏）：覆盖层跟着调整
        if now - last_area_check >= Duration::from_secs(1) {
            last_area_check = now;
            if let Some(a) = desktop::primary_work_area() {
                let scale = desktop::window_scale(overlay_hwnd);
                if a != geo.area || (scale - geo.scale).abs() > 1e-6 {
                    geo = Geometry { area: a, scale };
                    let _ = win.set_position(PhysicalPosition::new(a.left, a.top));
                    let _ = win.set_size(PhysicalSize::new(a.width() as u32, a.height() as u32));
                    force_platforms = true;
                }
            }
        }

        // 全屏免打扰
        if last_fullscreen_check.map_or(true, |t| now - t >= Duration::from_millis(500)) {
            last_fullscreen_check = Some(now);
            fullscreen = desktop::fullscreen_on_primary(overlay_hwnd);
        }
        let want_hidden = fullscreen || manual_hidden;
        if want_hidden != hidden {
            hidden = want_hidden;
            let _ = if hidden { win.hide() } else { win.show() };
            let reason = if fullscreen { "fullscreen" } else { "manual" };
            let _ = app.emit_to(OVERLAY, "desk-dnd", DndMsg { hidden, reason });
        }
        if hidden {
            thread::sleep(Duration::from_millis(100));
            continue;
        }

        // 光标：决定点击穿透，顺便给眼睛跟随用（限 15Hz，且只在宠物附近）
        if let Some((cx, cy)) = desktop::cursor_pos() {
            let (x, y) = (geo.x(cx), geo.y(cy));
            let over = hit.is_some_and(|r| x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3]);
            let want_ignore = !(over || dragging);
            if want_ignore != ignoring && win.set_ignore_cursor_events(want_ignore).is_ok() {
                ignoring = want_ignore;
            }
            if over != hover {
                hover = over;
                let _ = app.emit_to(OVERLAY, "desk-hover", hover);
            }
            let near = hit.is_none_or(|r| {
                let (mx, my) = ((r[0] + r[2]) / 2.0, (r[1] + r[3]) / 2.0);
                (x - mx).hypot(y - my) < 1400.0
            });
            if (cx, cy) != last_cursor && near && now - last_cursor_emit >= Duration::from_millis(66) {
                last_cursor = (cx, cy);
                last_cursor_emit = now;
                let _ = app.emit_to(OVERLAY, "desk-cursor", PointMsg { x, y });
            }
        }

        // 脚下的窗口：高频追踪，用来算窗口速度（甩飞）
        match carrier {
            Some(id) => match desktop::frame_bounds(id) {
                Some(r) => {
                    if carrier_rect != Some((id, r)) {
                        carrier_rect = Some((id, r));
                        let _ = app.emit_to(
                            OVERLAY,
                            "desk-carrier",
                            CarrierMsg {
                                id: id as i64,
                                t: ms(),
                                left: geo.x(r.left),
                                top: geo.y(r.top),
                                right: geo.x(r.right),
                                gone: false,
                            },
                        );
                    }
                }
                None => {
                    // 窗口被关掉/最小化/切到别的桌面
                    shared.lock().unwrap().carrier = None;
                    carrier_rect = None;
                    let _ = app.emit_to(
                        OVERLAY,
                        "desk-carrier",
                        CarrierMsg { id: id as i64, t: ms(), left: 0.0, top: 0.0, right: 0.0, gone: true },
                    );
                    force_platforms = true;
                }
            },
            None => carrier_rect = None,
        }

        // 可站立的窗口顶边（10Hz）
        if force_platforms || last_enum.map_or(true, |t| now - t >= Duration::from_millis(100)) {
            last_enum = Some(now);
            let wins = desktop::visible_windows(overlay_hwnd);
            let segs = desktop::platform_segments(&wins, geo.area, (40.0 * geo.scale) as i32);
            if force_platforms || segs != segments {
                segments = segs;
                let msg: Vec<PlatformMsg> = segments
                    .iter()
                    .map(|s| PlatformMsg { id: s.id as i64, x0: geo.x(s.x0), x1: geo.x(s.x1), y: geo.y(s.y) })
                    .collect();
                let _ = app.emit_to(OVERLAY, "desk-platforms", msg);
            }
        }

        let busy = hover || dragging || carrier.is_some();
        thread::sleep(Duration::from_millis(if busy { 8 } else { 16 }));
    }
}

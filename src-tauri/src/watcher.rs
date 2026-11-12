//! 桌面观察线程：在原生侧轮询光标、窗口、屏幕和全屏状态，只在有变化时通知前端。
//! 以前前端每帧都要 IPC 查一次光标，现在空闲时几乎没有 IPC。
//!
//! 覆盖层也归它摆：Windows 铺满所有能去的屏幕，macOS 跟随宠物切换屏幕。屏幕插拔、改排列、
//! 某块屏幕上开了全屏程序时重新摆，并告诉前端坐标怎么换算（desk-screens）。

use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::desktop::{self, Layout, Rect, Screen, Segment};
use crate::platform;

pub const OVERLAY: &str = "overlay";

/// 前端通过命令写入、观察线程读取的状态
#[derive(Default)]
pub struct DeskState {
    /// 可点击区域 [x0, y0, x1, y1]（覆盖层 CSS 像素）：第一个是宠物，后面是气泡之类
    pub hits: Vec<[f64; 4]>,
    pub geometry_revision: u64,
    pub dragging: bool,
    /// 宠物脚下的窗口，需要高频追踪它的位置
    pub carrier: Option<isize>,
    pub manual_hidden: bool,
    /// 前端刚加载完，需要把当前状态全部重发一遍
    pub resync: bool,
    /// 同上，给输入框检测线程用
    pub input_resync: bool,
    /// 覆盖层现在铺在哪儿：输入框检测线程换算坐标用
    pub overlay: Option<OverlayGeo>,
}

#[derive(Clone, Copy)]
pub struct OverlayGeo {
    /// Overlay bounds in desktop units (Windows pixels; macOS points).
    pub area: Rect,
    pub scale: f64,
    /// 最小的那块屏幕的工作区：判断"输入框大得躲不开"用（几块屏幕加起来比就太宽松了）
    pub screen: Rect,
}

fn overlay_geo(area: Rect, scale: f64, screens: &[Screen]) -> OverlayGeo {
    let screen = screens
        .iter()
        .map(|s| s.work)
        .min_by_key(|r| r.width() as i64 * r.height() as i64)
        .unwrap_or(area);
    OverlayGeo { area, scale, screen }
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

/// 一块能去的屏幕的工作区（覆盖层 CSS 像素）
#[derive(Serialize, Clone)]
struct ScreenMsg {
    left: f64,
    top: f64,
    right: f64,
    bottom: f64,
    primary: bool,
}

/// 覆盖层挪了：旧 CSS 坐标 × k + (dx, dy) = 新 CSS 坐标
#[derive(Serialize, Clone)]
struct RemapMsg {
    k: f64,
    dx: f64,
    dy: f64,
}

#[derive(Serialize, Clone)]
struct ScreensMsg {
    screens: Vec<ScreenMsg>,
    remap: Option<RemapMsg>,
    revision: u64,
}

/// Desktop units ↔ overlay CSS pixels.
#[derive(Clone, Copy, PartialEq)]
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
    fn screens(&self, list: &[Screen], remap: Option<RemapMsg>, revision: u64) -> ScreensMsg {
        let screens = list
            .iter()
            .map(|s| ScreenMsg {
                left: self.x(s.work.left),
                top: self.y(s.work.top),
                right: self.x(s.work.right),
                bottom: self.y(s.work.bottom),
                primary: s.primary,
            })
            .collect();
        ScreensMsg { screens, remap, revision }
    }
}

/// layout：建覆盖层时摆好的样子
pub fn spawn(app: AppHandle, shared: Shared, overlay_id: isize, layout: Layout) {
    thread::Builder::new()
        .name("desk-watcher".into())
        .spawn(move || run(app, shared, overlay_id, layout))
        .expect("failed to spawn desk watcher");
}

fn run(app: AppHandle, shared: Shared, overlay_id: isize, layout: Layout) {
    let start = Instant::now();
    let ms = || start.elapsed().as_secs_f64() * 1000.0;
    let mut geo = Geometry { area: layout.rect, scale: platform::window_scale(overlay_id) };
    shared.lock().unwrap().overlay = Some(overlay_geo(geo.area, geo.scale, &layout.screens));
    // 前端现在知道的屏幕（坐标按 geo 算的）
    let mut active: Vec<Screen> = layout.screens;
    let mut fullscreen_monitors: Vec<Rect> = Vec::new();
    // 所有屏幕都被全屏程序占了
    let mut all_fullscreen = false;
    let mut last_layout_check: Option<Instant> = None;
    // 自动隐藏的任务栏弹出来/缩回去只改工作区，不等每秒一次的布局检查，单独按 SCREEN_POLL 看。
    // sampled：上一次采样；applied：上一次布局用的
    let mut screens_sampled: Vec<Screen> = Vec::new();
    let mut screens_applied: Vec<Screen> = Vec::new();
    let mut last_screen_poll: Option<Instant> = None;
    // 置顶守卫（每秒）：覆盖层被挤到别的窗口后面就顶回来
    let mut last_topmost_check: Option<Instant> = None;
    let mut topmost_logs = 0;

    let mut ignoring = true;
    let mut hover = false;
    let mut last_cursor = (i32::MIN, i32::MIN);
    let mut last_cursor_emit = start;
    let mut segments: Vec<Segment> = Vec::new();
    let mut last_enum: Option<Instant> = None;
    let mut last_fullscreen_check: Option<Instant> = None;
    let mut hidden = false;
    let mut carrier_rect: Option<(isize, Rect)> = None;
    let mut revision = 0;

    loop {
        let (mut hits, dragging, carrier, manual_hidden, resync) = {
            let mut s = shared.lock().unwrap();
            (s.hits.clone(), s.dragging, s.carrier, s.manual_hidden, std::mem::take(&mut s.resync))
        };
        let Some(win) = app.get_webview_window(OVERLAY) else {
            thread::sleep(Duration::from_millis(100));
            continue;
        };
        let now = Instant::now();
        let mut force_platforms = resync;
        #[cfg(target_os = "macos")]
        let anchor = hits.first().map(|r| {
            (
                geo.area.left as f64 + (r[0] + r[2]) * 0.5 * geo.scale,
                geo.area.top as f64 + (r[1] + r[3]) * 0.5 * geo.scale,
            )
        });
        #[cfg(target_os = "macos")]
        let viewport_changed = desktop::viewport(&active, geo.area, anchor) != geo.area;
        #[cfg(not(target_os = "macos"))]
        let viewport_changed = false;

        // 哪几块屏幕上有全屏程序（每 0.5 秒）
        let mut fullscreen_changed = false;
        if last_fullscreen_check.map_or(true, |t| now - t >= Duration::from_millis(500)) {
            last_fullscreen_check = Some(now);
            let f = platform::fullscreen_monitors(overlay_id);
            if f != fullscreen_monitors {
                fullscreen_monitors = f;
                fullscreen_changed = true;
            }
        }

        // 任务栏（Windows 每 50 毫秒）：滑出来要两三百毫秒，等连续两次采样一样、停稳了再换地面，
        // 不然覆盖层要跟着缩好几次
        let mut sampled_now: Option<Vec<Screen>> = None;
        let screens_changed = if last_screen_poll.map_or(true, |t| now - t >= platform::SCREEN_POLL) {
            last_screen_poll = Some(now);
            let s = platform::screens();
            let settled = s == screens_sampled && s != screens_applied;
            screens_sampled = s.clone();
            sampled_now = Some(s);
            settled
        } else {
            false
        };

        // 屏幕布局（每秒；全屏状态、任务栏变了马上）：插拔显示器、改分辨率/缩放/排列、挪任务栏
        if viewport_changed
            || fullscreen_changed
            || screens_changed
            || last_layout_check.map_or(true, |t| now - t >= Duration::from_secs(1))
        {
            last_layout_check = Some(now);
            let list = sampled_now.unwrap_or_else(platform::screens);
            screens_applied = list.clone();
            match desktop::layout(&list, &fullscreen_monitors) {
                None => all_fullscreen = true,
                Some(l) => {
                    #[cfg(target_os = "macos")]
                    let l = Layout { rect: desktop::viewport(&l.screens, geo.area, anchor), ..l };
                    all_fullscreen = false;
                    // 被别的东西改了位置/大小（比如系统调整）也摆回去
                    let moved = platform::frame_bounds(overlay_id).is_some_and(|r| {
                        (r.left - l.rect.left).abs() > 2
                            || (r.top - l.rect.top).abs() > 2
                            || (r.right - l.rect.right).abs() > 2
                            || (r.bottom - l.rect.bottom).abs() > 2
                    });
                    if (l.rect != geo.area || moved) && platform::place_overlay(&win, l.rect).is_err() {
                        thread::sleep(Duration::from_millis(100));
                        continue;
                    }
                    let next = Geometry { area: l.rect, scale: platform::window_scale(overlay_id) };
                    if next != geo || l.screens != active {
                        let (k, dx, dy) = desktop::remap(geo.area, geo.scale, next.area, next.scale);
                        geo = next;
                        active = l.screens;
                        revision += 1;
                        {
                            let mut s = shared.lock().unwrap();
                            for r in &mut s.hits {
                                *r = [r[0] * k + dx, r[1] * k + dy, r[2] * k + dx, r[3] * k + dy];
                            }
                            hits = s.hits.clone();
                            s.geometry_revision = revision;
                            s.overlay = Some(overlay_geo(geo.area, geo.scale, &active));
                            s.input_resync = true;
                        }
                        let _ = app.emit_to(
                            OVERLAY,
                            "desk-screens",
                            geo.screens(&active, Some(RemapMsg { k, dx, dy }), revision),
                        );
                        force_platforms = true;
                        carrier_rect = None;
                    }
                }
            }
        }

        if resync {
            // 前端重新加载过：不能信任之前的穿透状态，强制重设
            ignoring = !(hover || dragging);
            let _ = win.set_ignore_cursor_events(ignoring);
            let _ = app.emit_to(OVERLAY, "desk-screens", geo.screens(&active, None, revision));
            let _ = app.emit_to(OVERLAY, "desk-dnd", DndMsg { hidden, reason: "sync" });
            let _ = app.emit_to(OVERLAY, "desk-hover", hover);
            carrier_rect = None;
        }

        // 全屏免打扰：所有屏幕都被全屏程序占了才整个藏起来（只占了一块的话，那块已经不在覆盖层里了）
        let want_hidden = all_fullscreen || manual_hidden;
        if want_hidden != hidden {
            hidden = want_hidden;
            let _ = if hidden { win.hide() } else { win.show() };
            let reason = if all_fullscreen { "fullscreen" } else { "manual" };
            let _ = app.emit_to(OVERLAY, "desk-dnd", DndMsg { hidden, reason });
        }
        if hidden {
            thread::sleep(Duration::from_millis(100));
            continue;
        }

        // 置顶守卫：拖着的时候不动 Z 序
        if !dragging && last_topmost_check.map_or(true, |t| now - t >= Duration::from_secs(1)) {
            last_topmost_check = Some(now);
            let pet = hits.first().map(|r| Rect {
                left: geo.area.left + (r[0] * geo.scale).round() as i32,
                top: geo.area.top + (r[1] * geo.scale).round() as i32,
                right: geo.area.left + (r[2] * geo.scale).round() as i32,
                bottom: geo.area.top + (r[3] * geo.scale).round() as i32,
            });
            if let Some(reason) = platform::keep_on_top(overlay_id, pet) {
                // 和别的"总在最前"程序抢的话每秒都会来一次，日志只记前几次
                if topmost_logs < 5 {
                    topmost_logs += 1;
                    let _ = crate::startup::log(&format!("Raised the overlay back to the top: {reason}"));
                }
            }
        }

        // 光标：决定点击穿透，顺便给眼睛跟随用（限 15Hz，且只在宠物附近）
        if let Some((cx, cy)) = platform::cursor_pos() {
            let (x, y) = (geo.x(cx), geo.y(cy));
            let over = hits.iter().any(|r| x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3]);
            let want_ignore = !(over || dragging);
            if want_ignore != ignoring && win.set_ignore_cursor_events(want_ignore).is_ok() {
                ignoring = want_ignore;
            }
            if over != hover {
                hover = over;
                let _ = app.emit_to(OVERLAY, "desk-hover", hover);
            }
            let near = hits.first().is_none_or(|r| {
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
            Some(id) => match platform::frame_bounds(id) {
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
            let wins = platform::visible_windows(overlay_id);
            let world_area = active.iter().map(|s| s.work).reduce(|a, b| a.union(&b)).unwrap_or(geo.area);
            let segs = desktop::platform_segments(&wins, world_area, (40.0 * geo.scale) as i32);
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

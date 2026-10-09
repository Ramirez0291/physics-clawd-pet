// 平台抽象：在 Tauri 里走原生接口；在普通浏览器里退化成可预览的版本，
// 方便不开 Tauri 也能调物理手感（`npm run dev` 后打开 / 和 /debug.html）。

import type { Vec2 } from '../engine/math';
import type { Bounds, Platform } from '../engine/pet';

export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

type Handler = (payload: any) => void;

/** 跨窗口消息总线（覆盖层 ↔ 调试面板） */
export interface Bus {
  emit(event: string, payload?: unknown): void;
  on(event: string, handler: Handler): void;
}

export async function createBus(): Promise<Bus> {
  if (isTauri) {
    const { emit, listen } = await import('@tauri-apps/api/event');
    return {
      emit: (event, payload) => void emit(event, payload),
      on: (event, handler) => void listen(event, (e) => handler(e.payload)),
    };
  }
  const ch = new BroadcastChannel('clawd-pet');
  const handlers = new Map<string, Handler[]>();
  ch.onmessage = (m: MessageEvent<{ event: string; payload: unknown }>) => {
    for (const h of handlers.get(m.data.event) ?? []) h(m.data.payload);
  };
  return {
    emit: (event, payload) => ch.postMessage({ event, payload }),
    on: (event, handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
  };
}

const LS_KEY = 'clawd-pet:tuning';

export async function loadTuning(): Promise<Record<string, unknown> | null> {
  if (isTauri) {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<Record<string, unknown> | null>('load_tuning').catch(() => null);
  }
  try {
    const s = localStorage.getItem(LS_KEY);
    return s ? JSON.parse(s) : null;
  } catch {
    return null;
  }
}

/** 返回保存位置的描述 */
export async function saveTuning(tuning: object): Promise<string> {
  if (isTauri) {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<string>('save_tuning', { tuning });
  }
  localStorage.setItem(LS_KEY, JSON.stringify(tuning));
  return '浏览器 localStorage';
}

export async function openDebugPanel() {
  if (isTauri) {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('open_debug');
  } else {
    window.open('/debug.html', 'clawd-debug', 'width=460,height=860');
  }
}

export type HitRect = [x0: number, y0: number, x1: number, y1: number];

/** 被追踪窗口的一次位置采样（覆盖层 CSS 像素） */
export interface CarrierSample {
  id: number;
  /** 毫秒，与 OverlayHost.clock() 同一时钟 */
  t: number;
  left: number;
  top: number;
  right: number;
  /** 窗口没了（关闭、最小化、切到别的虚拟桌面） */
  gone: boolean;
}

/**
 * 覆盖层与桌面的接口。Tauri 下由 Rust 的观察线程负责光标、点击穿透、窗口枚举和全屏检测，
 * 只在有变化时推送事件；浏览器预览下退化为页面内的光标，没有窗口平台。
 */
export interface OverlayHost {
  /** 最近一次已知的光标位置（覆盖层 CSS 坐标），未知为 null */
  cursor(): Vec2 | null;
  /** 光标是否在宠物上（此时覆盖层不穿透，可以抓） */
  hovering(): boolean;
  /** 宠物的可点击区域；相同的值会被去重 */
  setHitRect(r: HitRect | null): void;
  setDragging(on: boolean): void;
  /** 开始/停止高频追踪某个窗口（宠物脚下那个） */
  setCarrier(id: number | null): void;
  onPlatforms(cb: (list: Platform[]) => void): void;
  onCarrier(cb: (s: CarrierSample) => void): void;
  onDnd(cb: (hidden: boolean, reason: string) => void): void;
  /** 当前有键盘焦点的文本输入框（覆盖层 CSS 像素），没有为 null */
  onInput(cb: (zone: Bounds | null) => void): void;
  /** 与 CarrierSample.t 同一时钟的"现在"（ms） */
  clock(): number;
  /** 监听都挂好了，请求原生侧把当前状态全部推一遍 */
  ready(): void;
}

const sameRect = (a: HitRect | null, b: HitRect | null) =>
  a === b || (a !== null && b !== null && a.every((v, i) => Math.abs(v - b[i]) < 0.5));

export async function createOverlayHost(): Promise<OverlayHost> {
  if (!isTauri) {
    let cur: Vec2 | null = null;
    let hit: HitRect | null = null;
    window.addEventListener('pointermove', (e) => (cur = { x: e.clientX, y: e.clientY }));
    window.addEventListener('pointerleave', () => (cur = null));
    // 预览页里的输入框获得焦点时，当成"正在输入的输入框"
    const inputCbs: ((zone: Bounds | null) => void)[] = [];
    const focusedZone = (): Bounds | null => {
      const el = document.activeElement;
      if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return null;
      const r = el.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    };
    const emitInput = () => {
      const z = focusedZone();
      inputCbs.forEach((cb) => cb(z));
    };
    window.addEventListener('focusin', emitInput);
    window.addEventListener('focusout', () => setTimeout(emitInput, 0));
    window.addEventListener('resize', emitInput);
    return {
      cursor: () => cur,
      hovering: () => !!cur && !!hit && cur.x >= hit[0] && cur.x <= hit[2] && cur.y >= hit[1] && cur.y <= hit[3],
      setHitRect: (r) => (hit = r),
      setDragging: () => {},
      setCarrier: () => {},
      onPlatforms: () => {},
      onCarrier: () => {},
      onDnd: () => {},
      onInput: (cb) => inputCbs.push(cb),
      clock: () => performance.now(),
      ready: () => {},
    };
  }

  const { invoke } = await import('@tauri-apps/api/core');
  const { listen } = await import('@tauri-apps/api/event');

  let cur: Vec2 | null = null;
  let hover = false;
  let lastHit: HitRect | null = null;
  // Rust 时钟 = performance.now() - offset；取观测到的最小延迟作为偏移
  let offset = Infinity;
  const platformCbs: ((list: Platform[]) => void)[] = [];
  const carrierCbs: ((s: CarrierSample) => void)[] = [];
  const dndCbs: ((hidden: boolean, reason: string) => void)[] = [];
  const inputCbs: ((zone: Bounds | null) => void)[] = [];

  await Promise.all([
    listen<Vec2>('desk-cursor', (e) => (cur = e.payload)),
    listen<boolean>('desk-hover', (e) => (hover = e.payload)),
    listen<Platform[]>('desk-platforms', (e) => platformCbs.forEach((cb) => cb(e.payload))),
    listen<CarrierSample>('desk-carrier', (e) => {
      offset = Math.min(offset, performance.now() - e.payload.t);
      carrierCbs.forEach((cb) => cb(e.payload));
    }),
    listen<{ hidden: boolean; reason: string }>('desk-dnd', (e) =>
      dndCbs.forEach((cb) => cb(e.payload.hidden, e.payload.reason)),
    ),
    listen<Bounds | null>('desk-input', (e) => inputCbs.forEach((cb) => cb(e.payload))),
  ]);

  return {
    cursor: () => cur,
    hovering: () => hover,
    setHitRect(r) {
      if (sameRect(r, lastHit)) return;
      lastHit = r;
      void invoke('desk_set_hit', { rect: r });
    },
    setDragging: (on) => void invoke('desk_set_dragging', { on }),
    setCarrier: (id) => void invoke('desk_set_carrier', { id }),
    onPlatforms: (cb) => platformCbs.push(cb),
    onCarrier: (cb) => carrierCbs.push(cb),
    onDnd: (cb) => dndCbs.push(cb),
    onInput: (cb) => inputCbs.push(cb),
    clock: () => (Number.isFinite(offset) ? performance.now() - offset : performance.now()),
    ready: () => void invoke('desk_ready'),
  };
}

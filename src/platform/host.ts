// 平台抽象：在 Tauri 里走原生接口；在普通浏览器里退化成可预览的版本，
// 方便不开 Tauri 也能调物理手感（`npm run dev` 后打开 / 和 /debug.html）。

import type { Vec2 } from '../engine/math';

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

/** 覆盖层专用：点击穿透 + 全局光标位置 */
export interface OverlayHost {
  /** 最近一次已知的光标位置（覆盖层 CSS 坐标），未知为 null */
  cursor(): Vec2 | null;
  /** 每帧调用：刷新光标位置（Tauri 下异步轮询，不阻塞） */
  poll(): void;
  setClickThrough(on: boolean): void;
}

export async function createOverlayHost(): Promise<OverlayHost> {
  if (!isTauri) {
    let cur: Vec2 | null = null;
    window.addEventListener('pointermove', (e) => (cur = { x: e.clientX, y: e.clientY }));
    window.addEventListener('pointerleave', () => (cur = null));
    return { cursor: () => cur, poll: () => {}, setClickThrough: () => {} };
  }

  const { getCurrentWindow, cursorPosition } = await import('@tauri-apps/api/window');
  const win = getCurrentWindow();
  let origin = await win.innerPosition();
  let scaleFactor = await win.scaleFactor();
  void win.onMoved(async () => (origin = await win.innerPosition()));
  void win.onScaleChanged((e) => (scaleFactor = e.payload.scaleFactor));

  let cur: Vec2 | null = null;
  let pending = false;
  // 不能假设窗口当前是穿透的：页面热重载时窗口可能正处于"可点击"状态，
  // 如果不强制设一次，整个桌面都会被这个透明窗口挡住。
  await win.setIgnoreCursorEvents(true);
  let ignoring = true;
  let wanted = true;
  let applying = false;

  const applyClickThrough = async () => {
    if (applying) return;
    applying = true;
    while (ignoring !== wanted) {
      const target = wanted;
      try {
        await win.setIgnoreCursorEvents(target);
        ignoring = target;
      } catch {
        break;
      }
    }
    applying = false;
  };

  return {
    cursor: () => cur,
    poll() {
      if (pending) return;
      pending = true;
      cursorPosition()
        .then((p) => (cur = { x: (p.x - origin.x) / scaleFactor, y: (p.y - origin.y) / scaleFactor }))
        .catch(() => {})
        .finally(() => (pending = false));
    },
    setClickThrough(on) {
      wanted = on;
      if (wanted !== ignoring) void applyClickThrough();
    },
  };
}

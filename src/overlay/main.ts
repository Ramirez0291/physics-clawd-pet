import clawdDef from '../../skins/clawd/skin.json';
import { type Vec2, clamp } from '../engine/math';
import { DEFAULT_TUNING, mergeTuning, type Tuning } from '../engine/params';
import { ParticleSystem } from '../engine/particles';
import { type Bounds, type LaunchState, Pet } from '../engine/pet';
import { VelocitySampler } from '../engine/throw';
import {
  type CarrierSample,
  createBus,
  createOverlayHost,
  isTauri,
  loadTuning,
  openDebugPanel,
} from '../platform/host';
import { Renderer } from '../render/renderer';
import { type SkinDef, loadSkin } from '../skin/types';

/** 这些状态下动作幅度小，可以降帧省电 */
const CALM_MODES = new Set(['idle', 'walk', 'laptop', 'stocks', 'coin']);

/** 固定物理步长：与显示器刷新率无关 */
const STEP = 1 / 120;
const MAX_STEPS = 24;

export interface Telemetry {
  mode: string;
  side: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  speed: number;
  rot: number;
  angVel: number;
  dizzy: number;
  lastImpact: { tier: string; speed: number } | null;
  hasLaunch: boolean;
  fps: number;
  paused: boolean;
  /** 光标是否在宠物上（= 覆盖层此刻不穿透） */
  hover: boolean;
  cursor: Vec2 | null;
  /** 站在哪个窗口上（窗口句柄），null = 屏幕边框 */
  support: number | null;
  /** 脚下窗口的速度 */
  carrierSpeed: number;
  platforms: number;
  /** 正在输入的输入框 [left, top, right, bottom]，没有为 null */
  input: [number, number, number, number] | null;
  fleeing: boolean;
}

/** 可重复的测试投掷（相对屏幕尺寸），调参时用来做 A/B 对比 */
const PRESETS: Record<string, (w: number, h: number) => LaunchState> = {
  drop: (w, h) => ({ x: w * 0.5, y: h * 0.08, vx: 0, vy: 0, rot: 0, angVel: 0 }),
  throwRight: (w, h) => ({ x: w * 0.25, y: h * 0.55, vx: 3200, vy: -900, rot: 0, angVel: 6 }),
  wallLeft: (w, h) => ({ x: w * 0.6, y: h * 0.45, vx: -3400, vy: -300, rot: 0, angVel: -4 }),
  ceiling: (w, h) => ({ x: w * 0.5, y: h * 0.75, vx: 150, vy: -3000, rot: 0, angVel: 0 }),
  slam: (w, h) => ({ x: w * 0.4, y: h * 0.25, vx: 500, vy: 3600, rot: 0, angVel: 3 }),
  roll: (w, h) => ({ x: w * 0.15, y: h - 220, vx: 2600, vy: 300, rot: 0, angVel: 0 }),
};

async function main() {
  if (!isTauri) setupBrowserPreview();

  const canvas = document.getElementById('stage') as HTMLCanvasElement;
  const skin = loadSkin(clawdDef as unknown as SkinDef);
  const bus = await createBus();
  const host = await createOverlayHost();
  let tuning: Tuning = mergeTuning(DEFAULT_TUNING, await loadTuning());

  const bounds = (): Bounds => ({ left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight });
  const pet = new Pet(tuning, skin.grid, bounds());
  const particles = new ParticleSystem();
  const renderer = new Renderer(canvas, skin);
  const sampler = new VelocitySampler();

  const resize = () => {
    renderer.resize(window.innerWidth, window.innerHeight, window.devicePixelRatio || 1);
    pet.setBounds(bounds());
  };
  const watchDpr = () => {
    matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`).addEventListener(
      'change',
      () => {
        resize();
        watchDpr();
      },
      { once: true },
    );
  };
  resize();
  watchDpr();
  window.addEventListener('resize', resize);

  // 开场：从天上掉下来
  pet.dropFrom(window.innerWidth * 0.5, window.innerHeight * 0.1);
  if (import.meta.env.DEV) Object.assign(window, { __clawd: { pet, particles, renderer } });

  // ---------- 桌面：窗口平台、脚下窗口追踪、全屏免打扰 ----------

  host.onPlatforms((list) => pet.setPlatforms(list));
  host.onInput((zone) => pet.setInputZone(zone));

  const carrierSampler = new VelocitySampler(300);
  let carrierLatest: CarrierSample | null = null;
  let trackedId: number | null = null;
  /** 离开窗口后再追踪一会儿：被抛起来的宠物还能落回正在移动的窗口 */
  let trackUntil = 0;
  host.onCarrier((s) => {
    if (s.gone) {
      pet.carrierGone(s.id);
      if (trackedId === s.id) carrierLatest = null;
      return;
    }
    if (s.id !== trackedId) return;
    carrierLatest = s;
    carrierSampler.add(s.t, s.left, s.top);
  });
  const carrierMoving = () => carrierLatest !== null && carrierSampler.idleMs(host.clock()) < 150;

  let dndHidden = false;
  host.onDnd((hidden) => {
    if (hidden === dndHidden) return;
    dndHidden = hidden;
    if (!hidden) {
      // 全屏程序退出后：从天上掉回来
      particles.clear();
      pet.dropFrom(clamp(pet.pos.x, 100, window.innerWidth - 100), window.innerHeight * 0.05);
    }
  });
  host.ready();

  // ---------- 鼠标 ----------

  let drag: { id: number; downAt: number; x0: number; y0: number; moved: number } | null = null;

  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || drag) return;
    if (!renderer.hitTest(e.clientX, e.clientY, tuning.hitPadding)) return;
    canvas.setPointerCapture(e.pointerId);
    drag = { id: e.pointerId, downAt: e.timeStamp, x0: e.clientX, y0: e.clientY, moved: 0 };
    sampler.clear();
    sampler.add(e.timeStamp, e.clientX, e.clientY);
    pet.grab(e.clientX, e.clientY);
    host.setDragging(true);
    canvas.style.cursor = 'grabbing';
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const coalesced = e.getCoalescedEvents?.() ?? [];
    for (const ce of coalesced.length ? coalesced : [e]) sampler.add(ce.timeStamp, ce.clientX, ce.clientY);
    drag.moved = Math.max(drag.moved, Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0));
    const v = sampler.velocity(e.timeStamp, 50);
    pet.moveHold(e.clientX, e.clientY, v.x, v.y);
  });

  const endDrag = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.id) return;
    const now = e.timeStamp;
    // 松手前已经停住 → 只是放下，不是甩
    const v = sampler.idleMs(now) > 50 ? { x: 0, y: 0 } : sampler.velocity(now, tuning.throwWindowMs);
    const isClick = now - drag.downAt < 220 && drag.moved < 6;
    drag = null;
    pet.release(v.x, v.y, isClick);
    host.setDragging(false);
    canvas.style.cursor = '';
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('lostpointercapture', endDrag);

  // ---------- 调试面板通信 ----------

  let paused = false;
  let stepFrames = 0;
  let debugPing = -Infinity;
  const publishState = () => bus.emit('tuning-state', { tuning, defaults: DEFAULT_TUNING, paused });

  bus.on('debug-hello', () => {
    debugPing = performance.now();
    publishState();
  });
  bus.on('debug-ping', () => (debugPing = performance.now()));
  bus.on('tuning-set', (patch: Partial<Tuning>) => {
    tuning = mergeTuning(tuning, patch);
    pet.setTuning(tuning);
  });
  bus.on('debug-cmd', (msg: { cmd: string; arg?: string }) => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    switch (msg.cmd) {
      case 'reset':
        particles.clear();
        pet.placeOnFloor(w / 2);
        break;
      case 'pause':
        paused = !paused;
        publishState();
        break;
      case 'step':
        paused = true;
        stepFrames++;
        publishState();
        break;
      case 'replay':
        if (pet.lastLaunch) pet.launch(pet.lastLaunch);
        break;
      case 'preset': {
        const make = msg.arg ? PRESETS[msg.arg] : undefined;
        if (make) pet.launch(make(w, h));
        break;
      }
      case 'act':
        if (msg.arg === 'petted' || msg.arg === 'laptop' || msg.arg === 'stocks' || msg.arg === 'coin') {
          pet.perform(msg.arg);
        }
        break;
    }
  });

  // ---------- 主循环 ----------

  let acc = 0;
  let last = performance.now();
  let fps = 0;
  let fpsFrames = 0;
  let fpsT = last;
  let teleT = 0;
  let hover = false;
  let hitSentAt = 0;

  /** 没有任何东西在动：可以降帧省电 */
  const calm = () =>
    !drag &&
    !carrierMoving() &&
    CALM_MODES.has(pet.mode) &&
    particles.list.length === 0 &&
    !renderer.animating &&
    pet.emote === null &&
    pet.hitstop <= 0 &&
    Math.abs(pet.squash) < 0.01 &&
    Math.abs(pet.visRot) < 0.01 &&
    Math.hypot(pet.visOffset.x, pet.visOffset.y) < 0.5;

  const schedule = () => {
    if (calm() && tuning.idleFps < 100) {
      setTimeout(() => frame(performance.now()), 1000 / Math.max(1, tuning.idleFps));
    } else {
      requestAnimationFrame(frame);
    }
  };

  const frame = (now: number) => {
    const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
    last = now;
    if (dndHidden) {
      // 覆盖层已被隐藏：什么都不算，低频等待恢复
      setTimeout(() => frame(performance.now()), 250);
      return;
    }

    const cursor: Vec2 | null = host.cursor();
    if (!drag) {
      hover = host.hovering();
      canvas.style.cursor = hover ? 'grab' : '';
    }

    // 追踪脚下的窗口（离开后再追 0.6 秒）
    const supportId = pet.support?.id ?? null;
    if (supportId !== null) trackUntil = now + 600;
    const wantId = supportId ?? (now < trackUntil ? trackedId : null);
    if (wantId !== trackedId) {
      trackedId = wantId;
      carrierLatest = null;
      carrierSampler.clear();
      pet.resetCarrier();
      host.setCarrier(wantId);
    }
    if (carrierLatest) {
      const t = host.clock();
      const v =
        carrierSampler.idleMs(t) > 50 ? { x: 0, y: 0 } : carrierSampler.velocity(t, tuning.carrierWindowMs);
      pet.updateCarrier(carrierLatest.id, carrierLatest.left, carrierLatest.top, v.x, v.y);
    }

    let simDt = 0;
    if (!paused) acc += dt * tuning.timeScale;
    else if (stepFrames > 0) {
      acc += 1 / 60;
      stepFrames--;
    }
    let n = 0;
    while (acc >= STEP && n < MAX_STEPS) {
      pet.step(STEP, cursor);
      for (const ev of pet.consumeEvents()) if (tuning.particles) particles.handle(ev);
      if (pet.hitstop <= 0) particles.step(STEP);
      acc -= STEP;
      simDt += STEP;
      n++;
    }
    if (n >= MAX_STEPS) acc = 0;

    renderer.draw(pet, particles, tuning, simDt);

    // 把可点击区域告诉原生侧（它负责悬停判定和点击穿透）。平静时 10Hz 就够。
    if (!calm() || now - hitSentAt >= 100) {
      hitSentAt = now;
      host.setHitRect(renderer.hitRect(tuning.hitPadding));
    }

    fpsFrames++;
    if (now - fpsT >= 500) {
      fps = (fpsFrames * 1000) / (now - fpsT);
      fpsFrames = 0;
      fpsT = now;
    }
    // 只有调试面板开着（最近发过 ping）才发遥测
    if (now - teleT >= 100 && now - debugPing < 5000) {
      teleT = now;
      const t: Telemetry = {
        mode: pet.mode,
        side: pet.side,
        x: pet.pos.x,
        y: pet.pos.y,
        vx: pet.vel.x,
        vy: pet.vel.y,
        speed: Math.hypot(pet.vel.x, pet.vel.y),
        rot: pet.rot,
        angVel: pet.angVel,
        dizzy: pet.dizzy,
        lastImpact: pet.lastImpact,
        hasLaunch: pet.lastLaunch !== null,
        fps,
        paused,
        hover: hover || drag !== null,
        cursor,
        support: pet.support?.id ?? null,
        carrierSpeed: Math.hypot(pet.carrier.vx, pet.carrier.vy),
        platforms: pet.platforms.length,
        input: pet.inputZone
          ? [pet.inputZone.left, pet.inputZone.top, pet.inputZone.right, pet.inputZone.bottom]
          : null,
        fleeing: pet.fleeing,
      };
      bus.emit('telemetry', t);
    }
    schedule();
  };
  requestAnimationFrame(frame);
}

/** 浏览器预览：给个桌面似的背景和打开调试面板的入口 */
function setupBrowserPreview() {
  document.body.classList.add('browser');
  const bar = document.createElement('div');
  bar.className = 'preview-bar';
  bar.innerHTML = '浏览器预览模式 · 拖住 Clawd 甩出去 · 在它头上来回晃鼠标摸摸它 · ';
  const btn = document.createElement('button');
  btn.textContent = '打开调试面板 (D)';
  btn.onclick = () => void openDebugPanel();
  bar.append(btn);
  // 测试"避让输入框"：点进去打字，Clawd 会让开
  const input = document.createElement('textarea');
  input.className = 'preview-input';
  input.placeholder = '点这里打字试试：Clawd 会给输入框让路';
  document.body.append(bar, input);
  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLTextAreaElement) return;
    if (e.key === 'd' || e.key === 'D') void openDebugPanel();
  });
}

void main();

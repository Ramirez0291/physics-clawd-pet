// 程序化动作：根据宠物状态给每个部件算偏移/缩放。
// 只依赖部件角色（body/eye/arm/leg），换皮肤不用改这里。

import { type Skin, parseHex } from '../skin/types';
import { type Affine, type Vec2, clamp, mul, rotate, scale, squashAlong, translate } from './math';
import {
  CHIME_GAP,
  CHIME_LEAD,
  COIN_BITES,
  KNOCK_BEATS,
  NORMAL,
  type Pet,
  STOCK_LEN,
  STRETCH_RELEASE,
  SWEEP_STROKE,
} from './pet';

/** 单个部件的局部变换（格子单位），缩放以部件中心为锚 */
export interface PartPose {
  dx: number;
  dy: number;
  sx: number;
  sy: number;
}

/**
 * 道具（电脑、金币、腮红……）：一块纯色矩形，格子坐标，和部件 rect 同一坐标系。
 * 画在所有部件上面；torso=true 的跟着躯干一起缩放平移。
 */
export interface Prop {
  x: number;
  y: number;
  w: number;
  h: number;
  rgba: number;
  torso?: boolean;
  /** 平滑画风下画成柔边的椭圆（腮红） */
  soft?: boolean;
}

/** 躯干（身体+眼睛+手臂）整体变换，以身体底边中点为锚 */
export interface Pose {
  torso: PartPose;
  parts: PartPose[];
  props: Prop[];
}

const ident = (): PartPose => ({ dx: 0, dy: 0, sx: 1, sy: 1 });
const smoothstep = (x: number) => {
  const t = clamp(x, 0, 1);
  return t * t * (3 - 2 * t);
};

function blinking(t: number): boolean {
  // 两个不同周期叠加，眨眼间隔看起来不那么机械
  return t % 3.3 < 0.11 || (t + 1.3) % 7.7 < 0.11;
}

/** 眼睛看向哪里（宠物本地坐标，长度 ≤ 1） */
function lookVector(pet: Pet): Vec2 {
  const rot = pet.rot + pet.visRot;
  let wx = 0;
  let wy = 0;
  const v = pet.mode === 'held' ? pet.holdVel : pet.vel;
  if ((pet.mode === 'air' || pet.mode === 'held') && v && Math.hypot(v.x, v.y) > 200) {
    const sp = Math.hypot(v.x, v.y);
    wx = v.x / sp;
    wy = v.y / sp;
  } else if (pet.mode === 'walk') {
    // 沿面的切线方向（dir=+1 时 x 或 y 增大）
    const horizontal = pet.side === 'floor' || pet.side === 'ceiling';
    wx = horizontal ? pet.dir : 0;
    wy = horizontal ? 0 : pet.dir;
  } else if (pet.cursor) {
    const dx = pet.cursor.x - pet.pos.x;
    const dy = pet.cursor.y - pet.pos.y;
    const d = Math.hypot(dx, dy);
    if (d < 1200) {
      const m = Math.max(d, 140);
      wx = dx / m;
      wy = dy / m;
    }
  }
  const c = Math.cos(-rot);
  const s = Math.sin(-rot);
  return { x: clamp(c * wx - s * wy, -1, 1), y: clamp(s * wx + c * wy, -1, 1) };
}

// ---------- 道具像素画 ----------
// 道具都按"道具像素"画：1 道具像素 = 1/3 格（默认像素细分下正好是一个精灵像素）。

const PX = 1 / 3;
const C = {
  shell: parseHex('#c9ccd3'),
  shellDark: parseHex('#6b6f7d'),
  bezel: parseHex('#26272e'),
  screen: parseHex('#141720'),
  code: [parseHex('#d77757'), parseHex('#c9d1d9'), parseHex('#7ee787'), parseHex('#79c0ff')],
  caret: parseHex('#f4f1ea'),
  // A 股配色：红涨绿跌
  up: parseHex('#f0524f'),
  down: parseHex('#2fbf71'),
  grid: parseHex('#363c4e'),
  coin: parseHex('#f5c542'),
  coinRim: parseHex('#b07d12'),
  coinHi: parseHex('#fff4b8'),
  coinMark: parseHex('#d9922b'),
  spark: parseHex('#fffbe6'),
  blush: parseHex('#ff9d8f'),
  clapper: parseHex('#5a3d08'),
  paper: parseHex('#faf9f5'),
  ink: parseHex('#26272e'),
  faint: parseHex('#b8b4aa'),
  red: parseHex('#e5534b'),
  check: parseHex('#2fbf71'),
  bolt: parseHex('#fff4b8'),
  boltCore: parseHex('#9fd8ff'),
  stick: parseHex('#8a5a2b'),
  straw: parseHex('#d9a441'),
  strawDark: parseHex('#a8742a'),
};

/** 电脑翻开的程度：开头翻开、结尾合上，各 0.45 秒 */
function laptopOpen(pet: Pet): number {
  const T = 0.45;
  const t = pet.modeTime;
  return smoothstep(t / T) * (1 - smoothstep((t - (pet.modeDuration - T)) / T));
}

function hash(n: number): number {
  let h = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** 屏幕上的一行代码：缩进 + 关键字 + 其余部分（长度单位：道具像素） */
function codeLine(seed: number, i: number) {
  const h = (k: number) => hash(seed * 131 + i * 7 + k);
  const indent = [0, 2, 2, 4][Math.floor(h(1) * 4)];
  const kw = 2 + Math.floor(h(2) * 3);
  const rest = h(3) < 0.15 ? 0 : 3 + Math.floor(h(4) * (14 - indent));
  return {
    indent,
    kw,
    rest,
    kwColor: h(5) < 0.6 ? C.code[0] : C.code[3],
    restColor: h(6) < 0.75 ? C.code[1] : C.code[2],
  };
}

/** 笔记本：底座贴着地面，屏幕朝外摆在 dir 那一侧 */
function laptopProps(pet: Pet, grid: [number, number], out: Prop[]) {
  const open = laptopOpen(pet);
  if (open <= 0.02) return;
  const gwPx = grid[0] * 3;
  const flip = pet.dir < 0;
  // x, y, w, h 都是道具像素，按 16×10 格（48×30 道具像素）的网格写，
  // 再平移到实际网格：底座贴着网格底边，横向相对靠电脑那侧的边缘不变
  const ox = gwPx - 48;
  const oy = grid[1] * 3 - 30;
  const add = (x: number, y: number, w: number, h: number, rgba: number) =>
    out.push({ x: (flip ? gwPx - x - ox - w : x + ox) * PX, y: (y + oy) * PX, w: w * PX, h: h * PX, rgba });

  add(47, 28, 29, 1, C.shell);
  add(48, 29, 27, 1, C.shellDark);
  const lidH = Math.max(1, Math.round(18 * open));
  const top = 28 - lidH;
  add(50, top, 24, lidH, C.bezel);
  if (open < 0.95) return;

  // 屏幕内容不镜像：先算出屏幕左上角，再往里画
  const sw = 22;
  const sh = 16;
  const sx = flip ? gwPx - 51 - ox - sw : 51 + ox;
  const sy = top + oy + 1;
  const put = (x: number, y: number, w: number, h: number, rgba: number) =>
    out.push({ x: (sx + x) * PX, y: (sy + y) * PX, w: w * PX, h: h * PX, rgba });
  put(0, 0, sw, sh, C.screen);

  if (pet.mode === 'laptop') {
    // 敲代码：一个字一个字打出来，写满了往上滚
    const seed = Math.floor(pet.modeDuration * 1000);
    let typed = Math.max(0, Math.floor((pet.modeTime - 0.5) * 16));
    const lines: { line: ReturnType<typeof codeLine>; shown: number }[] = [];
    for (let i = 0; typed >= 0 && i < 1000; i++) {
      const line = codeLine(seed, i);
      const len = line.kw + (line.rest ? line.rest + 1 : 0);
      lines.push({ line, shown: Math.min(len, typed) });
      typed -= len + 3; // 换行也要花点时间
    }
    const ROWS = 7;
    const first = Math.max(0, lines.length - ROWS);
    let caret = { x: 1, y: 1 };
    for (let r = 0; r < ROWS && first + r < lines.length; r++) {
      const { line, shown } = lines[first + r];
      const y = 1 + r * 2;
      const x0 = 1 + line.indent;
      const kw = Math.min(line.kw, shown);
      if (kw > 0) put(x0, y, kw, 1, line.kwColor);
      const rest = Math.min(line.rest, shown - line.kw - 1);
      if (rest > 0) put(x0 + line.kw + 1, y, rest, 1, line.restColor);
      caret = { x: x0 + shown, y };
    }
    if (Math.floor(pet.t * 3) % 2 === 0) put(Math.min(sw - 1, caret.x), caret.y, 1, 1, C.caret);
    return;
  }

  // 炒股：分时线，虚线是开盘价
  const s = pet.stock;
  if (!s.length) return;
  const H = sh - 2;
  const row = (v: number) => 1 + Math.round((1 - v) * (H - 1));
  const base = row(s[0]);
  for (let x = 1; x < sw - 1; x += 2) put(x, base, 1, 1, C.grid);
  const n = Math.min(s.length, STOCK_LEN);
  for (let i = 0; i < n; i++) {
    const k = s.length - n + i;
    const y = row(s[k]);
    const py = k > 0 ? row(s[k - 1]) : y;
    const up = k === 0 || s[k] >= s[k - 1];
    const live = i === n - 1 && Math.floor(pet.t * 4) % 2 === 0;
    put(1 + i, Math.min(y, py), 1, Math.abs(y - py) + 1, live ? C.caret : up ? C.up : C.down);
  }
}

/** token 金币：7×7 格，一格 = 2 道具像素。咬了几口就少几块，第三口吃光。 */
const COIN_ART = ['..ooo..', '.ohyyo.', 'ohysyyo', 'oysssyo', 'oyysyyo', '.oyyyo.', '..ooo..'];
const COIN_BITE_HOLES: [number, number, number][] = [
  [6.5, 0.5, 2.6],
  [6.3, 4.2, 3.1],
];
function coinCells(bites: number) {
  const cells: { c: number; r: number; rgba: number }[] = [];
  if (bites >= 3) return cells;
  const color: Record<string, number> = { o: C.coinRim, y: C.coin, h: C.coinHi, s: C.coinMark };
  COIN_ART.forEach((line, r) =>
    [...line].forEach((ch, c) => {
      if (ch === '.') return;
      for (let b = 0; b < bites; b++) {
        const [hc, hr, rad] = COIN_BITE_HOLES[b];
        if (Math.hypot(c - hc, r - hr) < rad) return;
      }
      cells.push({ c, r, rgba: color[ch] });
    }),
  );
  return cells;
}
const COIN_STAGES = [0, 1, 2, 3].map(coinCells);

/** 金币的时间轴：掏出（到 S）→ 举着欣赏（到 A）→ 拿到嘴边（到 D）→ 咬 */
const COIN_S = 0.45;
const COIN_A = 1.05;
const COIN_D = 1.3;

function coinProps(pet: Pet, skin: Skin, out: Prop[]) {
  const tm = pet.modeTime;
  const stage = COIN_STAGES[Math.min(3, pet.bites)];
  if (!stage.length) return;
  const [gw, gh] = skin.grid;
  // 举过头顶欣赏，再塞进眼睛下面的嘴里
  const headY = skin.bodyBox.y - 3;
  const mouthY = (skin.eyeBox ? skin.eyeBox.y + skin.eyeBox.h : gh * 0.4) + 2.3;
  let cx = gw / 2;
  let cy: number;
  if (tm < COIN_S) {
    const k = smoothstep(tm / COIN_S);
    cx += pet.dir * (gw / 2 - 1.5) * (1 - k);
    cy = gh / 2 + (headY - gh / 2) * k;
  } else if (tm < COIN_A) {
    cy = headY + Math.sin((tm - COIN_S) * 12) * 0.3;
  } else {
    cy = headY + (mouthY - headY) * smoothstep((tm - COIN_A) / (COIN_D - COIN_A));
  }
  // 左上角对齐到道具像素
  const x0 = Math.round((cx - 7 / 3) * 3);
  const y0 = Math.round((cy - 7 / 3) * 3);
  for (const { c, r, rgba } of stage) {
    out.push({ x: (x0 + c * 2) * PX, y: (y0 + r * 2) * PX, w: 2 * PX, h: 2 * PX, rgba, torso: true });
  }
  // 举起来欣赏时一闪一闪
  if (tm >= COIN_S && tm < COIN_A && Math.floor(tm * 6) % 2 === 0) {
    const sx = x0 + 14;
    const sy = y0 - 1;
    for (const [dx, dy] of [
      [0, 0],
      [-1, 0],
      [1, 0],
      [0, -1],
      [0, 1],
    ]) {
      out.push({ x: (sx + dx) * PX, y: (sy + dy) * PX, w: PX, h: PX, rgba: C.spark, torso: true });
    }
  }
}

/** 铃铛：7×7 格，一格 = 2 道具像素 */
const BELL_ART = ['...o...', '..oyo..', '.oyhyo.', '.oyhyo.', 'oyyyyyo', 'ooooooo', '...s...'];

/** 报时：铃铛举在 dir 那只手上方，每摇一下往另一边甩一下 */
function bellProps(pet: Pet, skin: Skin, raise: number, out: Prop[]) {
  if (raise < 0.3) return;
  const [gw] = skin.grid;
  const arm = skin.parts.find((p) => p.role === 'arm' && p.side === pet.dir);
  const handX = arm ? arm.rect[0] + arm.rect[2] / 2 : gw / 2;
  const handTop = (arm ? arm.rect[1] : skin.bodyBox.y) - 3 * raise;
  const since = pet.bites > 0 ? pet.modeTime - (CHIME_LEAD + (pet.bites - 1) * CHIME_GAP) : 1;
  const swing = pet.bites > 0 && since < CHIME_GAP * 0.7 ? (pet.bites % 2 ? 1 : -1) : 0;
  const x0 = Math.round((handX - 7 / 3) * 3) + swing * 2;
  const y0 = Math.round((handTop - 14 / 3 + 0.3) * 3);
  const color: Record<string, number> = { o: C.coinRim, y: C.coin, h: C.coinHi, s: C.clapper };
  BELL_ART.forEach((line, r) =>
    [...line].forEach((ch, c) => {
      if (ch === '.') return;
      // 铃舌往反方向荡
      const dx = ch === 's' ? -swing * 2 : 0;
      out.push({ x: (x0 + c * 2 + dx) * PX, y: (y0 + r * 2) * PX, w: 2 * PX, h: 2 * PX, rgba: color[ch], torso: true });
    }),
  );
}

/** 举牌子：头顶一块 26×17 道具像素的牌子，下面一根杆；牌子上是日历页或者待办清单 */
function signProps(pet: Pet, skin: Skin, out: Prop[]) {
  const [gw] = skin.grid;
  const k = smoothstep(pet.modeTime / 0.3);
  const bob = Math.sin(pet.t * 4) > 0.3 ? 1 : 0;
  const x0 = Math.round(gw * 1.5) - 13;
  const y0 = Math.round(skin.bodyBox.y * 3) - 23 + Math.round((1 - k) * 10) - bob;
  const add = (x: number, y: number, w: number, h: number, rgba: number) =>
    out.push({ x: (x0 + x) * PX, y: (y0 + y) * PX, w: w * PX, h: h * PX, rgba, torso: true });
  add(12, 17, 2, 6, C.shellDark);
  add(0, 0, 26, 17, C.ink);
  add(1, 1, 24, 15, C.paper);
  if (pet.signKind === 'event') {
    // 日历页：红色页眉、两个装订环、日期格子，今天那格是红的
    add(1, 1, 24, 4, C.red);
    add(6, -1, 2, 4, C.ink);
    add(18, -1, 2, 4, C.ink);
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 5; c++) add(3 + c * 4, 7 + r * 3, 3, 2, r === 1 && c === 3 ? C.red : C.faint);
    }
  } else {
    // 待办清单：三个勾选框，第一个打了勾
    for (let r = 0; r < 3; r++) {
      const y = 2 + r * 5;
      add(3, y, 3, 3, r === 0 ? C.check : C.faint);
      add(8, y + 1, r === 2 ? 9 : 14, 1, C.faint);
    }
  }
}

/** 被电：身体两边的闪电（折线），隔帧换个形状 */
function zapProps(pet: Pet, skin: Skin, out: Prop[]) {
  const [gw, gh] = skin.grid;
  const flick = Math.floor(pet.modeTime * 24) % 3;
  if (flick === 2) return;
  for (const side of [-1, 1]) {
    // 从身体上方往下的一道闪电：每段横着错开一点
    let x = side < 0 ? -2 : gw * 3 + 1;
    let y = Math.round(skin.bodyBox.y * 3) - 2 + flick * 2;
    const len = Math.round(gh * 3 * 0.7);
    for (let i = 0; i < len; i += 2) {
      out.push({ x: x * PX, y: (y + i) * PX, w: PX, h: 2 * PX, rgba: i % 4 === 0 ? C.bolt : C.boltCore });
      x += ((i / 2 + flick) % 3 === 0 ? 1 : -1) * side;
    }
  }
}

/** 扫帚：从手里斜着拄到地上，扫帚头跟着来回扫 */
function broomProps(pet: Pet, skin: Skin, swing: number, out: Prop[]) {
  const [gw, gh] = skin.grid;
  const d = pet.dir;
  // 道具像素坐标：手在身体靠 dir 那侧的中间高度，扫帚头落在身体外面的地上
  const hx = Math.round((gw / 2 + d * (gw / 2 - 1)) * 3);
  const hy = Math.round(gh * 3 * 0.45);
  const bx = Math.round(hx + d * (10 + swing * 3));
  const by = gh * 3 - 4;
  const steps = Math.max(Math.abs(bx - hx), by - hy);
  for (let i = 0; i <= steps; i++) {
    const x = Math.round(hx + ((bx - hx) * i) / steps);
    const y = Math.round(hy + ((by - hy) * i) / steps);
    out.push({ x: x * PX, y: y * PX, w: PX, h: PX, rgba: C.stick });
  }
  // 扫帚头：上窄下宽的一撮
  out.push({ x: (bx - 2) * PX, y: by * PX, w: 5 * PX, h: PX, rgba: C.strawDark });
  out.push({ x: (bx - 3) * PX, y: (by + 1) * PX, w: 7 * PX, h: 2 * PX, rgba: C.straw });
  out.push({ x: (bx - 4) * PX, y: (by + 3) * PX, w: 9 * PX, h: PX, rgba: C.straw });
}

/** 脸红：每只眼睛下面一小块，稍微偏外 */
function blushProps(skin: Skin, out: Prop[]) {
  for (const part of skin.parts) {
    if (part.role !== 'eye' || part.side === 0) continue;
    const [x, y, w, h] = part.rect;
    const cx = (x + w / 2) * 3 + part.side * 2;
    out.push({
      x: (cx - 2.5) * PX,
      y: ((y + h) * 3 + 1) * PX,
      w: 5 * PX,
      h: 2 * PX,
      rgba: C.blush,
      torso: true,
      soft: true,
    });
  }
}

export function computePose(pet: Pet, skin: Skin): Pose {
  const t = pet.t;
  const torso = ident();
  const parts = skin.parts.map(ident);
  const props: Prop[] = [];
  let look = lookVector(pet);
  const bodyH = skin.bodyBox.h;
  const p = pet.modeDuration > 0 ? clamp(pet.modeTime / pet.modeDuration, 0, 1) : 0;

  let eyeSquint = blinking(t) ? 0.25 : 1;
  let eyeLookScale = 1;

  const each = (fn: (pp: PartPose, part: Skin['parts'][number], i: number) => void) =>
    skin.parts.forEach((part, i) => fn(parts[i], part, i));

  // 躯干压低 crouch 格（保持底边不动）
  const crouchBy = (amount: number) => {
    torso.sy = (bodyH - amount) / bodyH;
  };

  switch (pet.mode) {
    case 'idle': {
      const breath = Math.sin(t * 2.4) > 0.55 ? 0.5 : 0;
      crouchBy(breath);
      if (pet.dizzy > 0) {
        torso.dx = Math.sin(t * 7) * 0.5;
        eyeSquint = 0.5;
      }
      break;
    }
    case 'walk': {
      const speed = pet.side === 'floor' ? pet.tuning.walkSpeed : pet.tuning.climbSpeed;
      const phase = (t * speed) / (3 * pet.cell);
      const bob = Math.sin(phase * Math.PI * 4) > 0 ? 0.5 : 0;
      torso.dy = -bob;
      each((pp, part) => {
        if (part.role === 'leg') {
          const lift = Math.max(0, Math.sin(phase * Math.PI * 2 + (part.order % 2) * Math.PI));
          pp.dy = -lift;
        } else if (part.role === 'arm') {
          pp.dy = Math.sin(phase * Math.PI * 2 + part.side) * 0.5;
        }
      });
      break;
    }
    case 'held': {
      each((pp, part, i) => {
        if (part.role === 'leg') {
          pp.dy = 0.5 + Math.sin(t * 14 + i) * 0.5;
          pp.dx = Math.sin(t * 11 + i * 1.3) * 0.5;
        } else if (part.role === 'arm') {
          pp.dy = -1.5;
          pp.dx = part.side * 0.5 + Math.sin(t * 13 + part.side) * 0.5;
        }
      });
      if (pet.dizzy > 1) eyeSquint = 0.5;
      else if (eyeSquint === 1) eyeSquint = 1.25;
      break;
    }
    case 'air': {
      const sp = Math.hypot(pet.vel.x, pet.vel.y);
      each((pp, part, i) => {
        if (part.role === 'leg') {
          pp.dy = Math.sin(t * 18 + i * 1.7) * 0.5;
          pp.dx = Math.sin(t * 15 + i) * 0.5;
        } else if (part.role === 'arm') {
          pp.dy = -1.5 + Math.sin(t * 20 + part.side) * 0.5;
        }
      });
      if (sp > 2500) eyeSquint = 0.5;
      break;
    }
    case 'roll': {
      each((pp, part) => {
        if (part.role === 'leg') pp.dy = -2;
        else if (part.role === 'arm') pp.dx = -part.side * 1.5;
      });
      eyeSquint = 0.5;
      eyeLookScale = 0;
      break;
    }
    case 'land': {
      if (p < 0.5) {
        each((pp, part) => {
          if (part.role === 'leg') pp.dy = -0.5;
        });
      }
      break;
    }
    case 'hero':
    case 'cling': {
      // 超级英雄/蜘蛛侠落地：蹲低、腿岔开、手撑地，最后 30% 慢慢站起来
      const crouch = 1 - smoothstep((p - 0.7) / 0.3);
      crouchBy(1.5 * crouch);
      each((pp, part) => {
        if (part.role === 'leg') {
          pp.dx = part.side * crouch;
        } else if (part.role === 'arm') {
          pp.dx = part.side * crouch;
          pp.dy = 2.5 * crouch;
        }
      });
      eyeSquint = blinking(t) ? 0.25 : 0.5 + 0.5 * (1 - crouch);
      break;
    }
    case 'splat': {
      const flat = 1 - smoothstep((p - 0.75) / 0.25);
      crouchBy(bodyH * 0.45 * flat);
      torso.sx = 1 + 0.15 * flat;
      each((pp, part) => {
        if (part.role === 'leg') {
          pp.dx = part.side * 1.5 * flat;
          pp.dy = -0.5 * flat;
        } else if (part.role === 'arm') {
          pp.dx = part.side * 1.5 * flat;
          pp.dy = 2.5 * flat;
        }
      });
      eyeSquint = 0.4;
      break;
    }
    case 'petted': {
      // 被摸头：眯眼、脸红、左右蹭、小手乱挥
      torso.dx = Math.sin(t * 7) * 0.5;
      crouchBy(0.5 + 0.25 * Math.sin(t * 14));
      each((pp, part, i) => {
        if (part.role === 'arm') pp.dy = -1 + Math.sin(t * 12 + part.side) * 0.5;
        else if (part.role === 'leg') pp.dy = Math.sin(t * 10 + i * Math.PI) > 0.6 ? -0.5 : 0;
      });
      eyeSquint = 0.25;
      eyeLookScale = 0;
      blushProps(skin, props);
      break;
    }
    case 'laptop':
    case 'stocks': {
      // 坐下来，靠电脑那只手敲键盘/点鼠标，眼睛盯着屏幕
      const open = laptopOpen(pet);
      const mood = pet.mode === 'stocks' ? pet.stockMood : 0;
      crouchBy(open * (mood < -0.25 ? 1.8 : 1));
      if (mood < -0.25) torso.dx = Math.sin(t * 40) * 0.25;
      let tap = 0;
      if (open >= 0.95) {
        if (pet.mode === 'laptop') tap = (Math.floor(t * 14) % 2) * 0.67;
        else if (Math.sin(t * 5) > 0.8) tap = 0.67;
      }
      each((pp, part) => {
        if (part.role !== 'arm') return;
        if (part.side === pet.dir) {
          // 手伸到键盘上（键盘在网格底边往上 2/3 格）
          const reach = skin.grid[1] - 0.67 - (part.rect[1] + part.rect[3]);
          pp.dx = part.side * open;
          pp.dy = reach * open + tap;
        } else if (mood > 0.25) {
          pp.dy = -2.5; // 涨了！挥拳
        } else {
          pp.dy = Math.sin(t * 2) * 0.5;
        }
      });
      if (open > 0.5) look = { x: pet.dir, y: 0.6 };
      if (mood > 0.25) eyeSquint = blinking(t) ? 0.25 : 1.25;
      else if (mood < -0.25) eyeSquint = 0.5;
      laptopProps(pet, skin.grid, props);
      break;
    }
    case 'coin': {
      const tm = pet.modeTime;
      const lastBite = pet.bites > 0 ? COIN_BITES[pet.bites - 1] : -Infinity;
      const done = pet.bites >= COIN_BITES.length && tm - lastBite > 0.25;
      each((pp, part) => {
        if (part.role !== 'arm') return;
        if (tm < COIN_S) {
          // 从身后掏出来：一只手先举起来
          if (part.side === pet.dir) pp.dy = -2.5 * smoothstep(tm / COIN_S);
        } else if (tm < COIN_A) {
          pp.dy = -2.5;
          pp.dx = -part.side * 0.5;
        } else if (!done) {
          pp.dy = -0.5;
          pp.dx = -part.side * 0.5;
        } else {
          // 吃饱了拍拍肚子
          pp.dy = 1 + (Math.floor(t * 6) % 2) * 0.5;
          pp.dx = -part.side * 0.5;
        }
      });
      if (tm >= COIN_S && tm < COIN_A) {
        look = { x: 0, y: -1 };
        eyeSquint = 1.25;
      } else if (tm >= COIN_A && !done) {
        look = { x: 0, y: 0.8 };
        if (tm - lastBite < 0.15) eyeSquint = 0.25;
      } else if (done) {
        eyeSquint = 0.25;
        eyeLookScale = 0;
        torso.dy = Math.sin(t * 9) > 0 ? -0.33 : 0;
        blushProps(skin, props);
      }
      coinProps(pet, skin, props);
      break;
    }
    case 'shake': {
      // 抖毛：身体左右猛甩、毛炸开一点，眼睛眯成缝，手脚跟着乱甩；脚踩在原地不动
      const tm = pet.modeTime;
      const env = smoothstep(tm / 0.2) * (1 - smoothstep((tm - (pet.modeDuration - 0.35)) / 0.35));
      const wob = Math.sin(tm * 38);
      crouchBy(0.4 * env);
      torso.dx = wob * 0.7 * env;
      torso.sx = 1 + 0.06 * env * Math.abs(wob);
      each((pp, part, i) => {
        if (part.role === 'arm') {
          pp.dx = part.side * 0.4 * env;
          pp.dy = (-0.8 + Math.sin(tm * 38 + part.side) * 0.5) * env;
        } else if (part.role === 'leg') {
          pp.dy = Math.sin(tm * 19 + i * Math.PI) > 0.3 ? -0.4 * env : 0;
        }
      });
      if (env > 0.3) eyeSquint = 0.25;
      eyeLookScale = 0;
      break;
    }
    case 'chime': {
      // 一只手把铃铛举过头顶，另一只叉腰；摇一下身子跟着一缩（缩的部分在引擎的果冻弹簧里）
      const raise = smoothstep(pet.modeTime / CHIME_LEAD) * (1 - smoothstep((p - 0.9) / 0.1));
      each((pp, part) => {
        if (part.role !== 'arm') return;
        if (part.side === pet.dir) pp.dy = -3 * raise;
        else pp.dy = 0.5 * raise;
      });
      look = { x: pet.dir * 0.4, y: -1 };
      const since = pet.bites > 0 ? pet.modeTime - (CHIME_LEAD + (pet.bites - 1) * CHIME_GAP) : 1;
      if (since < 0.15) eyeSquint = 0.25;
      bellProps(pet, skin, raise, props);
      break;
    }
    case 'stretch': {
      // 伸懒腰：慢慢伸长、双手举过头顶、闭眼抖一抖，然后一松劲
      const tm = pet.modeTime;
      const k = smoothstep(tm / 0.8) * (1 - smoothstep((tm - STRETCH_RELEASE) / 0.25));
      torso.sy = 1 + 0.18 * k;
      torso.sx = 1 - 0.06 * k;
      if (tm > 0.8 && tm < STRETCH_RELEASE) torso.dx = Math.sin(t * 30) * 0.15;
      each((pp, part) => {
        if (part.role === 'arm') {
          pp.dy = -3.5 * k;
          pp.dx = -part.side * 0.5 * k;
        }
      });
      if (k > 0.4) eyeSquint = 0.25;
      eyeLookScale = 1 - k;
      // 松劲之后满足地眯一会儿
      if (tm > STRETCH_RELEASE + 0.25) eyeSquint = blinking(t) ? 0.25 : 0.6;
      break;
    }
    case 'zap': {
      // 被电：全身绷直乱颤，手脚炸开，眼睛一闪一闪
      const flick = Math.floor(t * 30) % 2;
      torso.dx = flick ? 0.6 : -0.6;
      torso.sy = 1.06;
      each((pp, part, i) => {
        if (part.role === 'arm') {
          pp.dx = part.side * 1.2;
          pp.dy = flick ? -2 : -1;
        } else if (part.role === 'leg') {
          pp.dx = part.side * 0.8;
          pp.dy = (i + flick) % 2 ? -0.6 : 0;
        }
      });
      eyeSquint = flick ? 0.25 : 1.4;
      eyeLookScale = 0;
      zapProps(pet, skin, props);
      break;
    }
    case 'knock': {
      // 跺脚：两手举着往下砸，每一脚之前抬一只脚
      const tm = pet.modeTime;
      const next = KNOCK_BEATS.find((b) => b > tm) ?? Infinity;
      const prev = [...KNOCK_BEATS].reverse().find((b) => b <= tm) ?? -Infinity;
      const since = tm - prev;
      const until = next - tm;
      const stompSide = pet.bites % 2 ? 1 : -1;
      each((pp, part) => {
        if (part.role === 'arm') {
          pp.dy = since < 0.12 ? 0.5 : -2.5;
          pp.dx = part.side * 0.3;
        } else if (part.role === 'leg' && part.side === stompSide && until < 0.2) {
          pp.dy = -1;
        }
      });
      crouchBy(since < 0.12 ? 0.6 : 0);
      eyeSquint = blinking(t) ? 0.25 : 0.6;
      break;
    }
    case 'sweep': {
      // 扫地：低着头，两手握扫帚来回扫，身子跟着晃
      const phase = (pet.modeTime % SWEEP_STROKE) / SWEEP_STROKE;
      const swing = Math.sin(phase * Math.PI * 2);
      crouchBy(0.5);
      torso.dx = swing * 0.4 * pet.dir;
      each((pp, part) => {
        if (part.role === 'arm') {
          pp.dx = pet.dir * (0.8 + swing * 0.4);
          pp.dy = 0.5;
        }
      });
      look = { x: pet.dir * 0.8, y: 0.8 };
      broomProps(pet, skin, swing, props);
      break;
    }
    case 'sign': {
      // 双手把牌子举过头顶，一颠一颠的
      const k = smoothstep(pet.modeTime / 0.3);
      each((pp, part, i) => {
        if (part.role === 'arm') {
          pp.dy = -2.5 * k;
          pp.dx = -part.side * 0.5 * k;
        } else if (part.role === 'leg') {
          pp.dy = Math.sin(t * 8 + i * Math.PI) > 0.5 ? -0.5 : 0;
        }
      });
      eyeSquint = blinking(t) ? 0.25 : 1.25;
      signProps(pet, skin, props);
      break;
    }
  }

  // "当当~" pose：翻滚收尾落地后举手
  if (pet.taDa > 0 && (pet.mode === 'land' || pet.mode === 'idle')) {
    each((pp, part) => {
      if (part.role === 'arm') {
        pp.dy = -2.5;
        pp.dx = part.side * 0.5;
      }
    });
  }

  each((pp, part) => {
    if (part.role !== 'eye') return;
    pp.dx += look.x * eyeLookScale;
    pp.dy += look.y * 0.6 * eyeLookScale;
    pp.sy *= eyeSquint;
  });

  return { torso, parts, props };
}

/**
 * 宠物本地坐标（格子单位，原点在网格中心）→ 世界坐标（CSS px）。
 * unit 由渲染器给出（取整到整数设备像素后的实际格子大小）。
 */
export function bodyTransform(pet: Pet, unit: number): Affine {
  const T = pet.tuning;
  const cx = pet.pos.x + pet.visOffset.x;
  const cy = pet.pos.y + pet.visOffset.y;
  const rot = pet.rot + pet.visRot;
  let m = mul(translate(cx, cy), mul(rotate(rot), scale(unit)));

  let deform: Affine | null = null;
  let px = cx;
  let py = cy;

  if (pet.mode === 'air') {
    const sp = Math.hypot(pet.vel.x, pet.vel.y);
    const k = 1 + Math.min(T.maxStretch, sp * T.stretchPerSpeed);
    if (k > 1.001) deform = squashAlong(Math.atan2(pet.vel.y, pet.vel.x), k);
  } else if (pet.mode === 'held') {
    const pivot = pet.holdPivot;
    if (pivot) {
      px = pivot.x;
      py = pivot.y;
    }
    if (T.holdStretch > 0) deform = squashAlong(rot + Math.PI / 2, 1 + T.holdStretch);
  } else if (pet.grounded) {
    // 贴着面时以接触点为锚，压扁时脚不离地
    const n = NORMAL[pet.side];
    const r = pet.mode === 'roll' ? pet.rollRadius : pet.halfH;
    px = cx - n.x * r;
    py = cy - n.y * r;
  }
  // 站在移动窗口上的惯性后仰，同样绕脚底转
  if (Math.abs(pet.lean) > 1e-3) deform = deform ? mul(deform, rotate(pet.lean)) : rotate(pet.lean);

  const s = clamp(pet.squash, -T.maxSquash, T.maxSquash);
  if (Math.abs(s) > 1e-3) {
    const sq = squashAlong(pet.squashAngle, 1 - s);
    deform = deform ? mul(sq, deform) : sq;
  }
  if (deform) m = mul(translate(px, py), mul(deform, mul(translate(-px, -py), m)));
  return m;
}

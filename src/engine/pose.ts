// 程序化动作：根据宠物状态给每个部件算偏移/缩放。
// 只依赖部件角色（body/eye/arm/leg），换皮肤不用改这里。

import { type Expression, type Skin, parseHex } from '../skin/types';
import { type Affine, type Vec2, clamp, mul, rotate, scale, squashAlong, translate } from './math';
import {
  CHIME_GAP,
  CHIME_LEAD,
  COIN_BITES,
  KNOCK_BEATS,
  MAGIC_DRAW,
  MAGIC_FIRE,
  MAGIC_FIRE_END,
  MAGIC_HAT,
  MAGIC_STOW,
  MAGIC_THRUST,
  NORMAL,
  type Pet,
  STOCK_LEN,
  STRETCH_RELEASE,
  SWEEP_STROKE,
  wandGeom,
  wandLift,
} from './pet';

/** 单个部件的局部变换（格子单位），缩放以部件中心为锚 */
export interface PartPose {
  dx: number;
  dy: number;
  sx: number;
  sy: number;
  /** 绕部件关节（pivot）转多少（弧度，顺时针）；没有关节的部件总是 0 */
  rot: number;
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
  /** 现在该是什么表情（有表情图的皮肤才看得出来） */
  face: Expression;
}

const ident = (): PartPose => ({ dx: 0, dy: 0, sx: 1, sy: 1, rot: 0 });
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
  logo: parseHex('#4d6bfe'),
  hat: parseHex('#3d6fd1'),
  hatShade: parseHex('#2c58ad'),
  hatDark: parseHex('#1d3270'),
  hatBand: parseHex('#1c2140'),
  sequin: parseHex('#f5d33f'),
  wand: parseHex('#d9b36a'),
  star: parseHex('#fee440'),
  starHot: parseHex('#f15bb5'),
  starCore: parseHex('#fff6fb'),
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

/** 笔记本：底座贴着地面，屏幕朝外摆在 dir 那一侧。inset：往身体那边挪几个道具像素 */
function laptopProps(pet: Pet, grid: [number, number], out: Prop[], inset = 0) {
  const open = laptopOpen(pet);
  if (open <= 0.02) return;
  const gwPx = grid[0] * 3;
  const flip = pet.dir < 0;
  // x, y, w, h 都是道具像素，按 16×10 格（48×30 道具像素）的网格写，
  // 再平移到实际网格：底座贴着网格底边，横向相对靠电脑那侧的边缘不变
  const ox = gwPx - 48 - inset;
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

/** 电脑背面的小鲸鱼标志 */
const LOGO_ART = ['.....o.', 'oooooo.', '.oooooo', '..ooo..'];

/**
 * 坐着用电脑（拟人角色）：电脑放在腿上，看到的是屏幕背面。
 * 屏幕高度按肩膀算，肩膀和手臂露在屏幕上面，手伸到屏幕后面敲键盘。
 */
function lapLaptopProps(pet: Pet, skin: Skin, open: number, drop: number, out: Prop[]) {
  if (open <= 0.02) return;
  const gx = skin.grid[0] * 3;
  const gy = skin.grid[1] * 3;
  const arms = skin.parts.filter((q) => q.role === 'arm' && q.pivot);
  const shoulder = arms.length ? (arms[0].pivot![1] + drop) * 3 : gy * 0.6;
  // 放在两肩中间：尾巴之类会把网格撑得不对称，网格中线不一定是身体中线
  const mid = arms.length === 2 ? ((arms[0].pivot![0] + arms[1].pivot![0]) / 2) * 3 : gx / 2;
  const full = clamp(Math.round(gy - 2 - shoulder - 3), 6, 15);
  const h = Math.max(1, Math.round(full * open));
  const w = 18;
  const x0 = Math.round(mid - w / 2);
  const add = (x: number, y: number, ww: number, hh: number, rgba: number) =>
    out.push({ x: x * PX, y: y * PX, w: ww * PX, h: hh * PX, rgba });
  add(x0 - 2, gy - 2, w + 4, 1, C.shell);
  add(x0 - 2, gy - 1, w + 4, 1, C.shellDark);
  add(x0, gy - 2 - h, w, h, C.bezel);
  if (h > 2) add(x0 + 1, gy - 1 - h, w - 2, h - 1, C.shell);
  if (open < 0.95 || full < 8) return;
  // 炒股时标志跟着涨跌变红变绿
  const s = pet.stock;
  const logo =
    pet.mode === 'stocks' && s.length > 1 ? (s[s.length - 1] >= s[s.length - 2] ? C.up : C.down) : C.logo;
  const lx = x0 + Math.round((w - 7) / 2);
  const ly = gy - 2 - h + Math.round((h - 4) / 2);
  LOGO_ART.forEach((row, r) =>
    [...row].forEach((ch, c) => {
      if (ch === 'o') add(lx + (pet.dir < 0 ? 6 - c : c), ly + r, 1, 1, logo);
    }),
  );
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

/**
 * 魔法帽（照着 Clawd 毛绒公仔的那顶画的）：44×20 道具像素，蓝色带黄色亮片，
 * 帽尖往 +x 拐过去垂在旁边，底下一圈深色帽带。画的时候让帽尖垂在身后。
 */
const HAT_ART = [
  '.........................dddddd.............',
  '.......................ddppppppdd...........',
  '.....................ddpppyypppppdd.........',
  '...................ddpppppyypppppppdd.......',
  '.............ddddddppppppppppppppdpssdd.....',
  '...........ddpppppppppppppppppppd.dssssd....',
  '..........dpppppppppyypppppppppppd.dssssd...',
  '.........dppppppppppyyppppppppppppd.dsssd...',
  '........dppppppppppppppppppppppppppdssssd...',
  '.......dpppppppppppppppppppyyppppppsssssd...',
  '......dpppppyypppppppppppppyyppppppssssd....',
  '.....dppppppyyppppppppppppppppppppppppd.....',
  '....dppppppppppppppppppppppppppppyyppppd....',
  '...dpppppppppppppppppppppyyppppppyypppppd...',
  '...dppppppppppppyypppppppyypppppppppppppd...',
  '..dpppppyyppppppyypppppppppppppppppppppppd..',
  '.dppppppyypppppppppppppppppppppyypppppppppd.',
  'dppppppppppppppppppppppppppppppyypppppppppd.',
  '.dnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnd.',
  '.dddddddddddddddddddddddddddddddddddddddddd.',
];

/**
 * 魔法帽：从天上掉下来扣到头上，落地弹一下。像公仔那样戴得很深：帽带压在眼睛正上方
 * （没有眼睛、或者眼睛太靠下的形象，最多压到身体的四成高）。
 */
function hatProps(pet: Pet, skin: Skin, out: Prop[]) {
  const tm = pet.modeTime;
  const fall = tm < MAGIC_HAT ? -Math.round((1 - (tm / MAGIC_HAT) ** 2) * 30) : tm < MAGIC_HAT + 0.12 ? -1 : 0;
  const w = HAT_ART[0].length;
  const h = HAT_ART.length;
  const body = skin.bodyBox;
  const bottom = Math.min(skin.eyeBox ? skin.eyeBox.y : Infinity, body.y + body.h * 0.4);
  const x0 = Math.round((body.x + body.w / 2) * 3 - w / 2);
  const y0 = Math.round(bottom * 3) - h + fall;
  const color: Record<string, number> = { p: C.hat, s: C.hatShade, d: C.hatDark, n: C.hatBand, y: C.sequin };
  const flip = pet.dir > 0;
  HAT_ART.forEach((line, r) =>
    [...line].forEach((ch, c) => {
      if (ch === '.') return;
      const x = x0 + (flip ? w - 1 - c : c);
      out.push({ x: x * PX, y: (y0 + r) * PX, w: PX, h: PX, rgba: color[ch], torso: true });
    }),
  );
}

/** 魔杖：从手里指向 pet.aim，杖尖一颗星；前摇时越聚越大、一闪一闪，放激光时最亮 */
function wandProps(pet: Pet, skin: Skin, out: Prop[]) {
  const tm = pet.modeTime;
  const g = wandGeom(skin.grid, pet.dir, pet.aim, wandLift(tm));
  const steps = Math.ceil(Math.max(Math.abs(g.tx - g.hx), Math.abs(g.ty - g.hy)));
  for (let i = 0; i < steps; i++) {
    const x = Math.round(g.hx + ((g.tx - g.hx) * i) / steps);
    const y = Math.round(g.hy + ((g.ty - g.hy) * i) / steps);
    out.push({ x: x * PX, y: y * PX, w: PX, h: PX, rgba: C.wand });
  }
  const firing = tm >= MAGIC_FIRE && tm < MAGIC_FIRE_END;
  const charging = tm >= MAGIC_DRAW && tm < MAGIC_FIRE;
  // 前摇越到后面闪得越快、星星越大
  const charge = charging ? (tm - MAGIC_DRAW) / (MAGIC_FIRE - MAGIC_DRAW) : 0;
  const pulse = Math.floor(pet.t * (8 + 16 * charge)) % 2 === 0;
  const arm = firing ? 3 : charging ? 1 + Math.round(charge * 2) - (pulse ? 0 : 1) : 1;
  const tx = Math.round(g.tx);
  const ty = Math.round(g.ty);
  const tipColor = charging && pulse ? C.starHot : C.star;
  for (let k = 1; k <= Math.max(1, arm); k++) {
    for (const [dx, dy] of [
      [k, 0],
      [-k, 0],
      [0, k],
      [0, -k],
    ]) {
      out.push({ x: (tx + dx) * PX, y: (ty + dy) * PX, w: PX, h: PX, rgba: k === 1 ? C.starCore : tipColor });
    }
  }
  // 大星星补上斜角，看起来更圆
  if (arm >= 2) {
    for (const [dx, dy] of [
      [1, 1],
      [-1, 1],
      [1, -1],
      [-1, -1],
    ]) {
      out.push({ x: (tx + dx) * PX, y: (ty + dy) * PX, w: PX, h: PX, rgba: tipColor });
    }
  }
  out.push({ x: tx * PX, y: ty * PX, w: PX, h: PX, rgba: C.starCore });
}

/** 脸红：每只眼睛下面一小块，稍微偏外 */
function blushProps(skin: Skin, out: Prop[]) {
  for (const part of skin.parts) {
    if (part.role !== 'eye') continue;
    const [x, y, w, h] = part.rect;
    // Faces can sit to one side of the body (for example the onigiri).
    // Place cheeks relative to the face, not the body's center line.
    const faceCenter = skin.eyeBox ? skin.eyeBox.x + skin.eyeBox.w / 2 : skin.grid[0] / 2;
    const side = Math.sign(x + w / 2 - faceCenter);
    const cx = (x + w / 2) * 3 + side * 2;
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
      const breath = skin.pixelArt ? (Math.sin(t * 2.4) > 0.55 ? 0.5 : 0) : (1 + Math.sin(t * 2.4)) * 0.18;
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
      const bob = skin.pixelArt ? (Math.sin(phase * Math.PI * 4) > 0 ? 0.5 : 0) : (1 + Math.sin(phase * Math.PI * 4)) * 0.2;
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
      if (skin.laptop === 'lap') {
        // 坐下来（身子往下挪一截腿长，不压扁），电脑放腿上，两只手轮流敲
        const open = laptopOpen(pet);
        const mood = pet.mode === 'stocks' ? pet.stockMood : 0;
        const legTop = Math.min(...skin.parts.filter((q) => q.role === 'leg').map((q) => q.rect[1]));
        const drop = Number.isFinite(legTop) ? (skin.grid[1] - legTop) * 0.4 : 1;
        torso.dy = drop * open;
        if (mood < -0.25) {
          crouchBy(0.6 * open);
          torso.dx = Math.sin(t * 40) * 0.25;
        }
        const beat = pet.mode === 'laptop' ? Math.floor(t * 12) % 2 : Math.sin(t * 5) > 0.8 ? 1 : -1;
        each((pp, part) => {
          if (part.role !== 'arm') return;
          if (mood > 0.25 && part.side !== pet.dir) {
            pp.dy = -2.5; // 涨了！挥拳
            return;
          }
          pp.dx = -part.side * 1.5 * open;
          if (open >= 0.95 && beat === (part.side > 0 ? 1 : 0)) pp.dy = -0.5;
        });
        if (open > 0.5) look = { x: 0, y: 0.7 };
        if (mood > 0.25) eyeSquint = blinking(t) ? 0.25 : 1.25;
        else if (mood < -0.25) eyeSquint = 0.5;
        lapLaptopProps(pet, skin, open, drop, props);
        break;
      }
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
      // 拟人角色的手臂在网格里面，电脑挪过来贴着手臂，不然够不着
      const hand = skin.parts.find((q) => q.role === 'arm' && q.side === pet.dir && q.pivot);
      const edge = hand ? (pet.dir > 0 ? skin.grid[0] - hand.rect[0] - hand.rect[2] : hand.rect[0]) : 0;
      laptopProps(pet, skin.grid, props, Math.max(0, Math.round(edge * 3) - 2));
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
    case 'magic': {
      // 帽子扣到头上 → 一只手掏出魔杖、另一只叉腰 → 前摇：魔杖举过头顶抡、身子往后仰、
      // 最后往前一戳 → 放激光，被顶得直哆嗦 → 得意地眯眼笑
      const tm = pet.modeTime;
      const holding = tm >= MAGIC_HAT && tm < pet.modeDuration - MAGIC_STOW;
      const lift = wandLift(tm);
      const firing = tm >= MAGIC_FIRE && tm < MAGIC_FIRE_END;
      each((pp, part, i) => {
        if (part.role === 'arm') {
          if (part.side === pet.dir) {
            if (holding) {
              pp.dy = -0.5 - lift;
              pp.dx = part.side * 0.3;
            }
          } else {
            pp.dy = 0.5;
          }
        } else if (part.role === 'leg' && firing) {
          // 被往后推：脚底下蹭着地
          pp.dx = -pet.dir * (Math.sin(t * 40 + i) > 0 ? 0.33 : 0);
        }
      });
      if (lift > 0) {
        // 前摇：身子跟着魔杖往后仰，越往后越蓄力
        torso.dx = -pet.dir * 0.3 * lift;
        crouchBy(0.3 * lift);
      } else if (tm >= MAGIC_FIRE - MAGIC_THRUST && tm < MAGIC_FIRE + 0.1) {
        // 往前一戳
        torso.dx = pet.dir * 0.5;
      } else if (firing) {
        torso.dx = -pet.dir * (Math.floor(t * 30) % 2 ? 0.5 : 0.2);
        crouchBy(0.5);
      }
      if (tm < MAGIC_HAT) {
        look = { x: 0, y: -1 };
      } else if (tm < MAGIC_FIRE_END) {
        look = { x: pet.dir * Math.cos(pet.aim), y: Math.sin(pet.aim) };
        if (firing) eyeSquint = 0.5;
        else if (tm >= MAGIC_DRAW) eyeSquint = 0.7;
      } else {
        eyeSquint = 0.25;
        eyeLookScale = 0;
      }
      hatProps(pet, skin, props);
      if (holding) wandProps(pet, skin, props);
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

  jointPoses(pet, skin, parts);

  each((pp, part) => {
    if (part.role !== 'eye') return;
    // 闭眼曲线保留安静的表情，跟随躯干动作，不当作瞳孔移动或压扁。
    if (part.shape === 'eyelid') return;
    const gaze = part.gaze ?? 1;
    pp.dx += look.x * eyeLookScale * gaze;
    pp.dy += look.y * 0.6 * eyeLookScale * gaze;
    pp.sy *= eyeSquint;
  });

  return { torso, parts, props, face: faceFor(pet) };
}

/** 按状态挑表情：被甩、被电挤成 >_<，被摸、庆祝笑开花，炒股赚了得意、亏了掉眼泪…… */
function faceFor(pet: Pet): Expression {
  const tm = pet.modeTime;
  if (pet.taDa > 0 && (pet.mode === 'land' || pet.mode === 'idle')) return 'happy';
  switch (pet.mode) {
    case 'idle':
      return pet.dizzy > 0 ? 'wince' : 'smile';
    case 'held':
      return pet.dizzy > 1 ? 'wince' : 'surprised';
    case 'air':
      return Math.hypot(pet.vel.x, pet.vel.y) > 2500 ? 'wince' : 'surprised';
    case 'roll':
    case 'splat':
    case 'shake':
      return 'wince';
    case 'hero':
    case 'cling':
      return 'smug';
    case 'petted':
    case 'sign':
      return 'happy';
    case 'laptop':
    case 'sweep':
      return 'focus';
    case 'stocks':
      return pet.stockMood > 0.25 ? 'smug' : pet.stockMood < -0.25 ? 'cry' : 'focus';
    case 'coin': {
      if (pet.bites >= COIN_BITES.length && tm - COIN_BITES[COIN_BITES.length - 1] > 0.25) return 'happy';
      if (tm < COIN_A) return tm < COIN_S ? 'smile' : 'happy';
      // 嘴边张嘴，咬下去的一瞬间合上
      const lastBite = pet.bites > 0 ? COIN_BITES[pet.bites - 1] : -Infinity;
      return tm - lastBite < 0.15 ? 'smile' : 'eat';
    }
    case 'chime': {
      const since = pet.bites > 0 ? tm - (CHIME_LEAD + (pet.bites - 1) * CHIME_GAP) : 1;
      return since < 0.3 ? 'happy' : 'smile';
    }
    case 'stretch':
      return tm > 0.5 && tm < STRETCH_RELEASE ? 'yawn' : 'smile';
    case 'zap':
      return Math.floor(pet.t * 30) % 2 ? 'wince' : 'surprised';
    case 'knock':
      return 'surprised';
    case 'magic':
      return tm < MAGIC_HAT ? 'surprised' : tm < MAGIC_FIRE ? 'focus' : tm < MAGIC_FIRE_END ? 'smug' : 'happy';
    default:
      return 'smile';
  }
}

/**
 * 有关节的部件：
 * - 手臂：上面的动作都是按 Clawd 的小短手写的"手往上抬几格、往外伸几格"，
 *   这里换算成绕肩膀的角度（抬 3 格 ≈ 举过头顶），平移清零。这样拟人角色不用另写一套动作。
 * - 带 sway 的部件（尾巴、耳朵、呆毛）：自己慢慢晃，走路、AI 思考时晃得快，飞在空中往后甩。
 */
function jointPoses(pet: Pet, skin: Skin, parts: PartPose[]) {
  const v = pet.mode === 'held' ? pet.holdVel ?? pet.vel : pet.vel;
  const drag = pet.mode === 'air' || pet.mode === 'held' ? clamp(-v.x / 1500, -1, 1) : 0;
  skin.parts.forEach((part, i) => {
    if (!part.pivot) return;
    const pp = parts[i];
    if (part.role === 'arm') {
      const raise = -pp.dy;
      const out = pp.dx * part.side;
      // 最多抬到 135°：Q 版的手臂短，再往上就藏到头后面去了，举成"\o/"才看得见
      const up = raise > 0 ? clamp(raise / 3, 0, 1) * Math.PI * 0.75 : 0;
      pp.rot += -part.side * (up + out * 0.4);
      pp.dx = 0;
      pp.dy = 0;
    }
    if (part.sway) {
      const { amp, speed = 0.5, phase = 0 } = part.sway;
      // 走路晃得快；AI 在思考时甩得更快（DeepSeek Harness 思考时那条尾巴就是这么甩的）
      const rate = pet.mode === 'walk' ? 2.5 : pet.agentMood === 'thinking' ? 4 : 1;
      const deg = amp * Math.sin((pet.t * speed * rate + phase) * Math.PI * 2) + amp * 1.5 * drag;
      pp.rot += (deg * Math.PI) / 180;
    }
  });
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

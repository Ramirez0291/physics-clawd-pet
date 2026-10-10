// 平滑画风：按实际分辨率画平滑的形状（不做像素化）。
// 毛茸茸的部件先按当前大小生成一张"毛发贴图"缓存起来，每帧只是带着姿势变换贴上去。

import type { Affine } from '../engine/math';
import type { Pose } from '../engine/pose';
import type { PartShape, Skin, SkinPart } from '../skin/types';

/** 摆好姿势后的一个部件或道具：中心、半宽高（网格坐标，原点在网格左上角）、旋转（弧度） */
export interface Item {
  cx: number;
  cy: number;
  hw: number;
  hh: number;
  rot: number;
  part: SkinPart | null;
  /** 道具的颜色（ImageData 打包格式） */
  rgba: number;
  /** 柔边椭圆的道具（腮红） */
  soft: boolean;
}

/** 部件在前，道具在后（画在最上面）。跟像素渲染器同一套姿势计算。 */
export function layoutItems(skin: Skin, pose: Pose): Item[] {
  const ta = skin.torsoAnchor;
  const t = pose.torso;
  const out: Item[] = [];
  const add = (
    x: number,
    y: number,
    w: number,
    h: number,
    pp: { dx: number; dy: number; sx: number; sy: number },
    torso: boolean,
    rot: number,
    part: SkinPart | null,
    rgba: number,
    soft = false,
  ) => {
    let cx = x + w / 2 + pp.dx;
    let cy = y + h / 2 + pp.dy;
    let hw = (w / 2) * pp.sx;
    let hh = (h / 2) * pp.sy;
    if (torso) {
      cx = ta.x + (cx - ta.x) * t.sx + t.dx;
      cy = ta.y + (cy - ta.y) * t.sy + t.dy;
      hw *= t.sx;
      hh *= t.sy;
    }
    out.push({ cx, cy, hw, hh, rot, part, rgba, soft });
  };
  skin.parts.forEach((part, i) => {
    const [x, y, w, h] = part.rect;
    add(x, y, w, h, pose.parts[i], part.role !== 'leg', ((part.rot ?? 0) * Math.PI) / 180, part, part.rgba);
  });
  const none = { dx: 0, dy: 0, sx: 1, sy: 1 };
  for (const p of pose.props) add(p.x, p.y, p.w, p.h, none, !!p.torso, 0, null, p.rgba, !!p.soft);
  return out;
}

/** 形状路径，以 (cx, cy) 为中心、半宽高 rw × rh */
export function shapePath(path: CanvasPath, shape: PartShape, cx: number, cy: number, rw: number, rh: number) {
  if (rw <= 0 || rh <= 0) return;
  if (shape === 'ellipse') {
    path.ellipse(cx, cy, rw, rh, 0, 0, Math.PI * 2);
  } else if (shape === 'cloud') {
    // 云朵：中间一个椭圆，外圈一圈大小交替的圆鼓包（同方向的子路径，非零环绕规则下就是并集）
    const n = 9;
    const r = Math.min(rw, rh) * 0.34;
    path.ellipse(cx, cy, rw - r * 0.6, rh - r * 0.6, 0, 0, Math.PI * 2);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 - Math.PI / 2 + 0.2;
      const ri = r * (i % 2 ? 0.9 : 1.05);
      const x = cx + (rw - ri) * Math.cos(a);
      const y = cy + (rh - ri) * Math.sin(a);
      path.moveTo(x + ri, y);
      path.arc(x, y, ri, 0, Math.PI * 2);
    }
  } else {
    const r = Math.min(rw, rh) * 0.3;
    path.roundRect(cx - rw, cy - rh, rw * 2, rh * 2, r);
  }
}

// ---------- 颜色 ----------

type RGB = [number, number, number];

function hexRgb(hex: string): RGB {
  const v = parseInt(hex.replace('#', '').slice(0, 6), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}
const mix = (a: RGB, b: RGB, t: number): RGB => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];
const css = (c: RGB, alpha = 1) =>
  `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${alpha})`;
const unpack = (rgba: number) => css([rgba & 255, (rgba >>> 8) & 255, (rgba >>> 16) & 255], (rgba >>> 24) / 255);

/** 稳定的伪随机：同一个部件每次生成的毛都一样 */
function seeded(text: string) {
  let s = 2166136261;
  for (let i = 0; i < text.length; i++) s = Math.imul(s ^ text.charCodeAt(i), 16777619);
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- 毛发贴图 ----------

const TONES = 14;

/**
 * 毛茸茸的部件：rect 就是连毛在内的外轮廓。里面先铺一层底色，
 * 再从内轮廓（往里缩一个毛长）里撒上几千根短毛，越靠边的毛越长、方向越朝外，轮廓就"毛"了。
 * 光从左上方来：左上的毛偏亮，右下的偏暗。
 */
export class FurCache {
  private map = new Map<string, HTMLCanvasElement>();

  clear() {
    this.map.clear();
  }

  get(skin: Skin, part: SkinPart, unitDev: number): HTMLCanvasElement {
    const [, , w, h] = part.rect;
    const W = Math.max(2, Math.ceil(w * unitDev));
    const H = Math.max(2, Math.ceil(h * unitDev));
    const key = `${skin.id}/${part.id}/${W}x${H}`;
    let c = this.map.get(key);
    if (!c) {
      if (this.map.size > 48) this.map.clear();
      c = this.build(skin, part, W, H, unitDev);
      this.map.set(key, c);
    }
    return c;
  }

  private build(skin: Skin, part: SkinPart, W: number, H: number, unitDev: number): HTMLCanvasElement {
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const g = c.getContext('2d')!;
    const rng = seeded(`${skin.id}/${part.id}`);
    const base = hexRgb(part.hex);
    const light = skin.fur?.light ? hexRgb(skin.fur.light) : mix(base, [255, 255, 255], 0.35);
    const shade = skin.fur?.shade ? hexRgb(skin.fur.shade) : mix(base, [0, 0, 0], 0.32);
    const shape = part.shape ?? 'rect';
    const cx = W / 2;
    const cy = H / 2;
    const L = Math.min((skin.fur?.length ?? 0.4) * unitDev, W / 3, H / 3);
    const rw = W / 2 - L;
    const rh = H / 2 - L;

    // 底色：径向渐变，左上亮右下暗
    const inner = new Path2D();
    shapePath(inner, shape, cx, cy, rw, rh);
    const grad = g.createRadialGradient(W * 0.36, H * 0.3, 0, cx, cy, Math.max(W, H) * 0.62);
    grad.addColorStop(0, css(mix(base, light, 0.55)));
    grad.addColorStop(0.55, css(base));
    grad.addColorStop(1, css(mix(base, shade, 0.7)));
    g.fillStyle = grad;
    g.fill(inner);

    // 毛：按色调分桶，每桶一条路径一次画完
    const buckets: Path2D[] = Array.from({ length: TONES }, () => new Path2D());
    const area = W * H;
    const n = Math.round(Math.min(26000, Math.max(500, area / 3.2)));
    const lw = Math.max(1, unitDev * 0.085);
    for (let k = 0, tries = 0; k < n && tries < n * 4; tries++) {
      const x = rng() * W;
      const y = rng() * H;
      if (!g.isPointInPath(inner, x, y)) continue;
      k++;
      // 归一化后的位置：中心 0，内轮廓边上约 1
      const ux = (x - cx) / Math.max(1, rw);
      const uy = (y - cy) / Math.max(1, rh);
      const d = Math.min(1, Math.hypot(ux, uy));
      // 朝外，再往下顺一点（毛是垂着的），加一点随机
      let dx = ux + (rng() - 0.5) * 0.9;
      let dy = uy + 0.45 + (rng() - 0.5) * 0.9;
      const len0 = Math.hypot(dx, dy) || 1;
      dx /= len0;
      dy /= len0;
      const len = L * (0.3 + 0.9 * d * d) * (0.65 + rng() * 0.5);
      // 光照：左上亮、右下暗，再抖一点
      const lit = 0.5 - uy * 0.38 - ux * 0.22 + (rng() - 0.5) * 0.35;
      const tone = Math.max(0, Math.min(TONES - 1, Math.round(lit * (TONES - 1))));
      const p = buckets[tone];
      p.moveTo(x, y);
      p.lineTo(x + dx * len, y + dy * len);
    }
    g.lineCap = 'round';
    g.lineWidth = lw;
    for (let i = 0; i < TONES; i++) {
      const t = i / (TONES - 1);
      const col = t < 0.5 ? mix(shade, base, t * 2) : mix(base, light, (t - 0.5) * 2);
      g.strokeStyle = css(col, 0.85);
      g.stroke(buckets[i]);
    }
    return c;
  }
}

/**
 * 把摆好姿势的部件画进精灵画布。m：网格坐标（原点在网格中心）→ 设备像素；
 * (ox, oy)：精灵画布左上角在屏幕上的设备像素坐标。
 */
export function drawItems(
  g: CanvasRenderingContext2D,
  items: Item[],
  skin: Skin,
  m: Affine,
  ox: number,
  oy: number,
  unitDev: number,
  fur: FurCache,
) {
  const [gw, gh] = skin.grid;
  g.imageSmoothingEnabled = true;
  for (const it of items) {
    if (it.hw <= 0 || it.hh <= 0) continue;
    g.setTransform(m.a, m.b, m.c, m.d, m.e - ox, m.f - oy);
    g.translate(it.cx - gw / 2, it.cy - gh / 2);
    if (it.rot) g.rotate(it.rot);
    const part = it.part;
    if (!part) {
      if (it.soft) {
        // 腮红：柔边椭圆
        const c: RGB = [it.rgba & 255, (it.rgba >>> 8) & 255, (it.rgba >>> 16) & 255];
        g.scale(1, it.hh / it.hw);
        const grad = g.createRadialGradient(0, 0, 0, 0, 0, it.hw * 1.15);
        grad.addColorStop(0, css(c, 0.75));
        grad.addColorStop(0.6, css(c, 0.5));
        grad.addColorStop(1, css(c, 0));
        g.fillStyle = grad;
        g.beginPath();
        g.arc(0, 0, it.hw * 1.15, 0, Math.PI * 2);
        g.fill();
        continue;
      }
      // 其他道具（电脑、金币）本来就是像素画，照原样画成小方块
      g.fillStyle = unpack(it.rgba);
      g.fillRect(-it.hw, -it.hh, it.hw * 2, it.hh * 2);
      continue;
    }
    if (part.fur) {
      g.drawImage(fur.get(skin, part, unitDev), -it.hw, -it.hh, it.hw * 2, it.hh * 2);
      continue;
    }
    const shape = part.shape ?? 'rect';
    const path = new Path2D();
    shapePath(path, shape, 0, 0, it.hw, it.hh);
    const base = hexRgb(part.hex);
    if (part.role === 'eye') {
      g.fillStyle = css(base);
      g.fill(path);
      // 眼睛里一个小高光；眨眼（压扁）时不画
      if (it.hh > it.hw * 0.9) {
        g.fillStyle = 'rgba(255,255,255,0.85)';
        g.beginPath();
        g.ellipse(-it.hw * 0.25, -it.hh * 0.4, it.hw * 0.32, it.hw * 0.32, 0, 0, Math.PI * 2);
        g.fill();
      }
      continue;
    }
    // 其他平滑部件（比如帽子）：上亮下暗的一点立体感，底下投一层软阴影压在毛上
    const grad = g.createLinearGradient(0, -it.hh, 0, it.hh);
    grad.addColorStop(0, css(mix(base, [255, 255, 255], 0.16)));
    grad.addColorStop(1, css(mix(base, [0, 0, 0], 0.25)));
    g.fillStyle = grad;
    g.shadowColor = 'rgba(0, 20, 60, 0.35)';
    g.shadowBlur = unitDev * 0.7;
    g.shadowOffsetY = unitDev * 0.25;
    g.fill(path);
    g.shadowColor = 'transparent';
    g.shadowBlur = 0;
    g.shadowOffsetY = 0;
  }
  g.setTransform(1, 0, 0, 1, 0, 0);
}

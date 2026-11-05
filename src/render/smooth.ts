// 平滑画风：按实际分辨率画平滑的形状（不做像素化）。
// 毛茸茸的部件先按当前大小生成一张"毛发贴图"缓存起来，每帧只是带着姿势变换贴上去。

import type { Affine } from '../engine/math';
import type { Pose } from '../engine/pose';
import type { PartShape, Skin, SkinPart } from '../skin/types';
import { imagePiece } from './sprites';

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
    // 贴图和像素部件共用肩关节、发根：旋转时围绕关节移动部件中心。
    if (part?.pivot && rot) {
      const px = part.pivot[0] + pp.dx;
      const py = part.pivot[1] + pp.dy;
      const dx = cx - px;
      const dy = cy - py;
      cx = px + Math.cos(rot) * dx - Math.sin(rot) * dy;
      cy = py + Math.sin(rot) * dx + Math.cos(rot) * dy;
    }
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
    const rot = pose.parts[i].rot + ((part.rot ?? 0) * Math.PI) / 180;
    add(x, y, w, h, pose.parts[i], part.role !== 'leg' && !part.anchored, rot, part, part.rgba);
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
  } else if (shape === 'onigiri') {
    // Rounded triangular rice-ball silhouette, with a broad, nearly flat base.
    path.moveTo(cx - rw * 0.27, cy - rh * 0.87);
    path.bezierCurveTo(cx - rw * 0.12, cy - rh * 1.04, cx + rw * 0.18, cy - rh * 1.04, cx + rw * 0.34, cy - rh * 0.78);
    path.bezierCurveTo(cx + rw * 0.52, cy - rh * 0.48, cx + rw * 0.75, cy - rh * 0.02, cx + rw * 0.94, cy + rh * 0.38);
    path.bezierCurveTo(cx + rw * 1.09, cy + rh * 0.77, cx + rw * 0.92, cy + rh * 0.97, cx + rw * 0.57, cy + rh * 0.98);
    path.bezierCurveTo(cx + rw * 0.18, cy + rh, cx - rw * 0.43, cy + rh, cx - rw * 0.73, cy + rh * 0.96);
    path.bezierCurveTo(cx - rw * 1.02, cy + rh * 0.93, cx - rw * 1.08, cy + rh * 0.68, cx - rw * 0.94, cy + rh * 0.35);
    path.bezierCurveTo(cx - rw * 0.72, cy - rh * 0.06, cx - rw * 0.46, cy - rh * 0.56, cx - rw * 0.27, cy - rh * 0.87);
    path.closePath();
  } else if (shape === 'frog') {
    // One continuous coat: the eye hoods grow out of the body without seams.
    path.moveTo(cx - rw * 0.9, cy - rh * 0.02);
    path.bezierCurveTo(cx - rw * 0.79, cy - rh * 0.36, cx - rw * 0.76, cy - rh * 0.98, cx - rw * 0.43, cy - rh * 0.98);
    path.bezierCurveTo(cx - rw * 0.17, cy - rh * 1.01, cx - rw * 0.18, cy - rh * 0.67, cx, cy - rh * 0.68);
    path.bezierCurveTo(cx + rw * 0.16, cy - rh * 0.69, cx + rw * 0.18, cy - rh, cx + rw * 0.44, cy - rh * 0.98);
    path.bezierCurveTo(cx + rw * 0.74, cy - rh * 0.97, cx + rw * 0.74, cy - rh * 0.42, cx + rw * 0.9, cy - rh * 0.05);
    path.bezierCurveTo(cx + rw * 1.15, cy + rh * 0.55, cx + rw * 0.72, cy + rh * 0.99, cx, cy + rh * 0.99);
    path.bezierCurveTo(cx - rw * 0.76, cy + rh * 1.02, cx - rw * 1.14, cy + rh * 0.57, cx - rw * 0.9, cy - rh * 0.02);
    path.closePath();
  } else if (shape === 'pear') {
    // 上窄下宽的软团子，肩膀过渡到圆润的肚子。
    path.moveTo(cx, cy - rh);
    path.bezierCurveTo(cx + rw * 0.8, cy - rh, cx + rw * 0.62, cy - rh * 0.15, cx + rw * 0.86, cy + rh * 0.2);
    path.bezierCurveTo(cx + rw * 1.12, cy + rh * 0.75, cx + rw * 0.65, cy + rh, cx, cy + rh);
    path.bezierCurveTo(cx - rw * 0.65, cy + rh, cx - rw * 1.12, cy + rh * 0.75, cx - rw * 0.86, cy + rh * 0.2);
    path.bezierCurveTo(cx - rw * 0.62, cy - rh * 0.15, cx - rw * 0.8, cy - rh, cx, cy - rh);
    path.closePath();
  } else if (shape === 'bow') {
    path.moveTo(cx, cy - rh * 0.2);
    path.bezierCurveTo(cx - rw * 0.5, cy - rh * 0.7, cx - rw, cy - rh * 1.15, cx - rw, cy - rh * 0.65);
    path.bezierCurveTo(cx - rw, cy + rh * 0.1, cx - rw, cy + rh, cx - rw * 0.78, cy + rh * 0.8);
    path.lineTo(cx, cy + rh * 0.2);
    path.lineTo(cx + rw * 0.78, cy + rh * 0.8);
    path.bezierCurveTo(cx + rw, cy + rh, cx + rw, cy + rh * 0.1, cx + rw, cy - rh * 0.65);
    path.bezierCurveTo(cx + rw, cy - rh * 1.15, cx + rw * 0.5, cy - rh * 0.7, cx, cy - rh * 0.2);
    path.closePath();
  } else if (shape === 'arch') {
    path.ellipse(cx, cy + rh, rw, rh * 2, 0, Math.PI, Math.PI * 2);
  } else if (shape === 'eyelid') {
    path.moveTo(cx - rw, cy - rh * 0.5);
    path.quadraticCurveTo(cx, cy + rh * 1.3, cx + rw, cy - rh * 0.5);
  } else if (shape === 'cloud') {
    const pt = (x: number, y: number) => [cx + x * rw, cy + y * rh] as const;
    path.moveTo(...pt(-0.7, -0.64));
    for (const [a, b, c, d, e, f] of [
      [-0.64,-0.96,-0.28,-0.97,-0.08,-0.88], [0.2,-1.08,0.55,-0.94,0.61,-0.73],
      [0.92,-0.76,1.03,-0.44,0.87,-0.22], [1.12,0.01,1.02,0.32,0.83,0.39],
      [0.94,0.69,0.64,0.88,0.43,0.82], [0.28,1.06,-0.03,1.05,-0.19,0.87],
      [-0.46,1.04,-0.75,0.86,-0.72,0.64], [-1.02,0.6,-1.06,0.27,-0.89,0.09],
      [-1.08,-0.2,-0.99,-0.55,-0.7,-0.64],
    ]) path.bezierCurveTo(...pt(a,b), ...pt(c,d), ...pt(e,f));
    path.closePath();
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

const TONES = 18;

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
    const settings = typeof part.fur === 'object' ? part.fur : skin.fur;
    const light = settings?.light ? hexRgb(settings.light) : mix(base, [255, 255, 255], 0.35);
    const shade = settings?.shade ? hexRgb(settings.shade) : mix(base, [0, 0, 0], 0.32);
    const shape = part.shape ?? 'rect';
    const cx = W / 2;
    const cy = H / 2;
    const L = Math.min((settings?.length ?? 0.4) * unitDev, W / 3, H / 3);
    const rw = W / 2 - L * 0.8;
    const rh = H / 2 - L * 0.8;
    const density = Math.max(0.4, Math.min(2, settings?.density ?? 1));
    const curl = Math.max(0, Math.min(1, settings?.curl ?? 0.25));

    // 底色：径向渐变，左上亮右下暗
    const inner = new Path2D();
    shapePath(inner, shape, cx, cy, rw, rh);
    const grad = g.createRadialGradient(W * 0.34, H * 0.28, 0, W * 0.52, H * 0.54, Math.max(W, H) * 0.52);
    grad.addColorStop(0, css(mix(base, light, 0.6)));
    grad.addColorStop(0.42, css(mix(base, light, 0.12)));
    grad.addColorStop(0.68, css(base));
    grad.addColorStop(0.92, css(mix(base, shade, 0.6)));
    grad.addColorStop(1, css(mix(base, shade, 0.85)));
    g.fillStyle = grad;
    // A soft undercoat prevents a hard cut-out edge beneath the individual hairs.
    g.shadowColor = css(base, 0.6);
    g.shadowBlur = L * 0.55;
    g.fill(inner);
    g.shadowColor = 'transparent';
    g.shadowBlur = 0;

    // 毛：按色调分桶，每桶一条路径一次画完
    const buckets: Path2D[][] = Array.from({ length: 2 }, () => Array.from({ length: TONES }, () => new Path2D()));
    const area = W * H;
    const n = Math.round(Math.min(52000, Math.max(700, area * 0.38 * density)));
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
      // Neighbouring fibres form small wisps rather than independent speckles.
      const flow = Math.sin(ux * 19 + Math.sin(uy * 13) * 2) * 0.5;
      let dx = ux * 0.7 + flow + (rng() - 0.5) * 0.65;
      let dy = uy * 0.7 + 0.4 + Math.cos(uy * 17 + ux * 9) * 0.28 + (rng() - 0.5) * 0.65;
      const len0 = Math.hypot(dx, dy) || 1;
      dx /= len0;
      dy /= len0;
      const guard = rng() < 0.38;
      const layer = guard ? 1 : 0;
      const len = L * (0.48 + 0.52 * d * d) * (0.5 + rng() * 0.5) * (guard ? 1 : 0.65);
      // 光照：左上亮、右下暗，再抖一点
      const lit = 0.7 - uy * 0.28 - ux * 0.18 - d * d * 0.2 + (rng() - 0.5) * 0.2;
      const tone = Math.max(0, Math.min(TONES - 1, Math.round(lit * (TONES - 1))));
      const p = buckets[layer][tone];
      const bend = curl * len * (flow + (rng() - 0.5) * 0.9);
      p.moveTo(x, y);
      p.quadraticCurveTo(x + dx * len * 0.55 - dy * bend, y + dy * len * 0.55 + dx * bend, x + dx * len, y + dy * len);
    }
    // 外轮廓上的细绒毛，毛尖留在部件贴图内，动作和桌面点击范围跟着轮廓走。
    const fringe = Array.from({ length: TONES }, () => new Path2D());
    const edgeCount = Math.min(2200, Math.max(90, Math.round((W + H) * 1.4 * density)));
    for (let i = 0; i < edgeCount; i++) {
      const a = (i + rng() * 0.8) / edgeCount * Math.PI * 2;
      const dx = Math.cos(a);
      const dy = Math.sin(a);
      // Follow the actual silhouette, including cloud scallops and the frog's notch.
      let lo = 0;
      let hi = Math.hypot(W, H);
      for (let j = 0; j < 13; j++) {
        const mid = (lo + hi) / 2;
        if (g.isPointInPath(inner, cx + dx * mid, cy + dy * mid)) lo = mid;
        else hi = mid;
      }
      const x = cx + dx * lo;
      const y = cy + dy * lo;
      const length = L * (0.3 + rng() * 0.43);
      const bend = Math.sin(a * 5) * curl * length * 0.5;
      const tone = Math.max(0, Math.min(TONES - 1, Math.round((0.55 - dy * 0.26 - dx * 0.16 + rng() * 0.12) * (TONES - 1))));
      const p = fringe[tone];
      p.moveTo(x - dx * length * 0.25, y - dy * length * 0.25);
      p.quadraticCurveTo(x + dx * length * 0.55 - dy * bend, y + dy * length * 0.55 + dx * bend, x + dx * length, y + dy * length);
    }
    g.lineCap = 'round';
    for (let layer = 0; layer < 3; layer++) {
      g.lineWidth = Math.max(0.45, unitDev * (layer === 0 ? 0.036 : 0.021));
      for (let i = 0; i < TONES; i++) {
        const t = i / (TONES - 1);
        const col = t < 0.5 ? mix(shade, base, t * 2) : mix(base, light, (t - 0.5) * 2);
        g.strokeStyle = css(col, layer === 2 ? 0.48 : layer === 0 ? 0.28 : 0.5);
        g.stroke(layer === 2 ? fringe[i] : buckets[layer][i]);
      }
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
    g.globalAlpha = part ? (it.rgba >>> 24) / 255 : 1;
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
    if (part.image) {
      const image = imagePiece(part.image);
      if (image) {
        g.imageSmoothingEnabled = false;
        g.drawImage(image, -it.hw, -it.hh, it.hw * 2, it.hh * 2);
        g.imageSmoothingEnabled = true;
      }
      continue;
    }
    if (part.fur) {
      g.drawImage(fur.get(skin, part, unitDev), -it.hw, -it.hh, it.hw * 2, it.hh * 2);
      continue;
    }
    const shape = part.shape ?? 'rect';
    if (part.outline) {
      const width = Math.min(part.outline, it.hw, it.hh);
      const path = new Path2D();
      shapePath(path, shape, 0, 0, Math.max(0.01, it.hw - width / 2), Math.max(0.01, it.hh - width / 2));
      g.lineWidth = width;
      g.lineCap = 'round';
      g.strokeStyle = css(hexRgb(part.hex));
      g.stroke(path);
      continue;
    }
    const path = new Path2D();
    shapePath(path, shape, 0, 0, it.hw, it.hh);
    const base = hexRgb(part.hex);
    if (part.role === 'eye') {
      g.fillStyle = css(base);
      g.fill(path);
      // 眼睛里一个小高光；眨眼（压扁）时不画
      if (it.hh > it.hw * 0.9) {
        g.fillStyle = 'rgba(255,255,255,0.25)';
        g.beginPath();
        g.ellipse(-it.hw * 0.25, -it.hh * 0.4, it.hw * 0.16, it.hw * 0.16, 0, 0, Math.PI * 2);
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
  g.globalAlpha = 1;
}

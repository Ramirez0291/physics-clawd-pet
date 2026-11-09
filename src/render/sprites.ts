// 原画贴图只解码一次；裁片使用同一张源图，静止时能按原坐标拼回完整角色。
import type { PartImage, Polygon } from '../skin/types';

const sources = new Map<string, HTMLImageElement>();
let revision = 0;
const pieces = new WeakMap<PartImage, HTMLCanvasElement>();

/** 图片异步载入后使渲染签名失效，即使宠物正暂停也能显示第一帧。 */
export function spriteRevision() { return revision; }

function trace(g: CanvasRenderingContext2D, polygon: Polygon, ox: number, oy: number) {
  g.moveTo(polygon[0][0] - ox, polygon[0][1] - oy);
  for (const [x, y] of polygon.slice(1)) g.lineTo(x - ox, y - oy);
  g.closePath();
}

/** 把描边外沿混进 RGB 的白底还原为透明度，保留轮廓里面的白色衣饰。 */
function removePaperFringe(data: ImageData) {
  const { width: w, height: h, data: rgba } = data;
  const alpha = Uint8Array.from({ length: w * h }, (_, i) => rgba[i * 4 + 3]);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (!alpha[i]) continue;
    if (x > 0 && x < w - 1 && y > 0 && y < h - 1 &&
      alpha[i - 1] >= 32 && alpha[i + 1] >= 32 && alpha[i - w] >= 32 && alpha[i + w] >= 32) continue;
    const o = i * 4;
    const lo = Math.min(rgba[o], rgba[o + 1], rgba[o + 2]);
    const hi = Math.max(rgba[o], rgba[o + 1], rgba[o + 2]);
    if (lo <= 70 || hi - lo > 100) continue;
    const coverage = (255 - lo) / (255 - 45);
    rgba[o + 3] = coverage < 0.3 ? 0 : alpha[i] * coverage;
    if (!rgba[o + 3]) continue;
    for (let c = 0; c < 3; c++) rgba[o + c] = 255 - (255 - rgba[o + c]) / coverage;
  }
}

export function imagePiece(def: PartImage): HTMLCanvasElement | null {
  const cached = pieces.get(def);
  if (cached) return cached;
  let source = sources.get(def.src);
  if (!source) {
    source = new Image();
    source.onload = () => { revision++; };
    source.onerror = () => { console.warn('皮肤原画加载失败', def.src); };
    source.src = def.src;
    sources.set(def.src, source);
  }
  if (!source.complete || !source.naturalWidth) return null;
  const [x, y, w, h] = def.crop;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext('2d')!;
  g.save();
  if (def.polygon) {
    g.beginPath();
    trace(g, def.polygon, x, y);
    g.clip();
  }
  g.drawImage(source, x, y, w, h, 0, 0, w, h);
  g.restore();
  if (def.matte === 'paper' || def.matte === 'paper-outline') {
    // 设定图作为原生动作图集读取：仅在显示裁片时去掉与外部连通的纸色。
    // 黑色闭合描边保护衣服、眼白和呆毛，不修改或另存参考图。
    const data = g.getImageData(0, 0, w, h);
    const seen = new Uint8Array(w * h);
    const queue = new Int32Array(w * h);
    let head = 0, tail = 0;
    const visit = (i: number) => {
      if (seen[i]) return;
      seen[i] = 1;
      const o = i * 4;
      const r = data.data[o], green = data.data[o + 1], b = data.data[o + 2];
      const lo = Math.min(r, green, b), hi = Math.max(r, green, b);
      if (data.data[o + 3] < 32 || (lo > 180 && hi - lo < 40) || (lo > 135 && hi - lo < 16)) queue[tail++] = i;
    };
    for (let x = 0; x < w; x++) { visit(x); visit((h - 1) * w + x); }
    for (let y = 0; y < h; y++) { visit(y * w); visit(y * w + w - 1); }
    while (head < tail) {
      const i = queue[head++];
      data.data[i * 4 + 3] = 0;
      const x = i % w, y = Math.floor(i / w);
      if (x) visit(i - 1);
      if (x + 1 < w) visit(i + 1);
      if (y) visit(i - w);
      if (y + 1 < h) visit(i + w);
    }
    for (const [hx, hy, hw, hh] of def.paperHoles ?? []) {
      for (let j = Math.max(0, hy - y); j < Math.min(h, hy + hh - y); j++) {
        for (let i = Math.max(0, hx - x); i < Math.min(w, hx + hw - x); i++) {
          const o = (j * w + i) * 4;
          const r = data.data[o], green = data.data[o + 1], b = data.data[o + 2];
          if (Math.min(r, green, b) > 145 && Math.max(r, green, b) - Math.min(r, green, b) < 75) data.data[o + 3] = 0;
        }
      }
    }
    if (def.matte === 'paper-outline') removePaperFringe(data);
    // 裁片边缘偶尔碰到说明文字的一两个像素。只丢弃主体以外的微小孤点；
    // 心形、气泡及气泡内部的省略号都保留。
    seen.fill(0);
    const components: { x0: number; y0: number; x1: number; y1: number; count: number; pixels?: Int32Array }[] = [];
    for (let seed = 0; seed < seen.length; seed++) {
      if (seen[seed] || data.data[seed * 4 + 3] < 32) continue;
      head = 0; tail = 1; queue[0] = seed; seen[seed] = 1;
      let x0 = w, y0 = h, x1 = 0, y1 = 0;
      while (head < tail) {
        const i = queue[head++], x = i % w, y = Math.floor(i / w);
        x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
        for (const n of [x ? i - 1 : -1, x + 1 < w ? i + 1 : -1, y ? i - w : -1, y + 1 < h ? i + w : -1]) {
          if (n < 0 || seen[n] || data.data[n * 4 + 3] < 32) continue;
          seen[n] = 1; queue[tail++] = n;
        }
      }
      components.push({ x0, y0, x1, y1, count: tail, ...(tail <= 18 ? { pixels: queue.slice(0, tail) } : {}) });
    }
    for (const c of components.filter((c) => c.pixels)) {
      if (components.some((b) => b.count > 18 && b.x0 <= c.x0 && b.y0 <= c.y0 && b.x1 >= c.x1 && b.y1 >= c.y1)) continue;
      for (const i of c.pixels!) data.data[i * 4 + 3] = 0;
    }
    g.putImageData(data, 0, 0);
  }
  if (def.matte === 'light') {
    const data = g.getImageData(0, 0, w, h);
    const keep = new Uint8Array(w * h);
    for (let i = 0; i < keep.length; i++) {
      const [r, green, b, a] = data.data.subarray(i * 4, i * 4 + 4);
      if (a && r > 160 && green > 135 && b > 110 && r - green < 70 && green - b < 65) keep[i] = 1;
    }
    // 源图里的深色细边也留下，但不把整块黑色马甲当成手臂。
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      if (keep[j * w + i]) continue;
      let near = false;
      for (let dy = -3; dy <= 3 && !near; dy++) for (let dx = -3; dx <= 3; dx++) {
        const nx = i + dx, ny = j + dy;
        if (nx >= 0 && nx < w && ny >= 0 && ny < h && keep[ny * w + nx]) { near = true; break; }
      }
      if (!near) data.data[(j * w + i) * 4 + 3] = 0;
    }
    g.putImageData(data, 0, 0);
  }
  for (const cutout of def.cutouts ?? []) {
    g.globalCompositeOperation = 'destination-out';
    g.beginPath();
    trace(g, cutout, x, y);
    g.fill();
  }
  for (const region of def.cutoutImages ?? []) {
    const image = imagePiece({ ...region, src: def.src });
    if (!image) continue;
    g.globalCompositeOperation = 'destination-out';
    g.drawImage(image, region.crop[0] - x, region.crop[1] - y);
  }
  // 补色只出现在被独立部件遮住的空洞，不能盖掉原画里的马甲和卷发。
  g.globalCompositeOperation = 'destination-over';
  for (const fill of [...(def.fills ?? [])].reverse()) {
    if (fill.sample) {
      const xs = fill.polygon.map((p) => p[0]), ys = fill.polygon.map((p) => p[1]);
      const bx = Math.min(...xs), by = Math.min(...ys);
      g.save();
      g.beginPath();
      trace(g, fill.polygon, x, y);
      g.clip();
      g.drawImage(source, ...fill.sample, bx - x, by - y, Math.max(...xs) - bx, Math.max(...ys) - by);
      g.restore();
    }
    g.fillStyle = fill.color;
    g.beginPath();
    trace(g, fill.polygon, x, y);
    g.fill();
  }
  g.globalCompositeOperation = 'source-over';
  if (def.sampleStep && def.sampleStep > 1) {
    const sampled = document.createElement('canvas');
    sampled.width = Math.max(1, Math.round(w / def.sampleStep));
    sampled.height = Math.max(1, Math.round(h / def.sampleStep));
    sampled.getContext('2d')!.drawImage(canvas, 0, 0, sampled.width, sampled.height);
    pieces.set(def, sampled);
    return sampled;
  }
  pieces.set(def, canvas);
  return canvas;
}

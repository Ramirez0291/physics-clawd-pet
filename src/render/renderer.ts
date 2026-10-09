import { type Affine, apply, invert, mul, scale } from '../engine/math';
import type { Tuning } from '../engine/params';
import type { ParticleSystem } from '../engine/particles';
import type { Pet } from '../engine/pet';
import { bodyTransform, computePose } from '../engine/pose';
import type { Skin } from '../skin/types';

/** 设备像素矩形 */
interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface SpriteFrame {
  /** 精灵左上角（设备像素） */
  ox: number;
  oy: number;
  /** 一个精灵像素对应多少设备像素 */
  up: number;
  w: number;
  h: number;
  /** 本地格子坐标 → 设备像素 */
  m: Affine;
  opaque: { x0: number; y0: number; x1: number; y1: number } | null;
  hash: number;
}

interface Ghost {
  canvas: HTMLCanvasElement;
  ox: number;
  oy: number;
  w: number;
  h: number;
  up: number;
  age: number;
}

const GHOST_LIFE = 0.12;
const STAR = '#f5c542';
const INK = '#141413';

/**
 * 像素风渲染：宠物先在低分辨率网格里按"旋转+形变"逐像素采样，再用最近邻放大。
 * 这样转起来像素块也始终整齐，不会糊边。
 */
export class Renderer {
  private ctx: CanvasRenderingContext2D;
  private sprite = document.createElement('canvas');
  private sctx: CanvasRenderingContext2D;
  private dpr = 1;
  private dirty: Rect[] = [];
  private frame: SpriteFrame | null = null;
  private ghosts: Ghost[] = [];
  private ghostPool: HTMLCanvasElement[] = [];
  private lastSig = '';
  private fullClear = true;

  constructor(
    private canvas: HTMLCanvasElement,
    private skin: Skin,
  ) {
    this.ctx = canvas.getContext('2d')!;
    this.sctx = this.sprite.getContext('2d', { willReadFrequently: false })!;
    this.sprite.width = 128;
    this.sprite.height = 128;
  }

  /** 还有残影在消散 */
  get animating() {
    return this.ghosts.length > 0;
  }

  setSkin(skin: Skin) {
    this.skin = skin;
    this.lastSig = '';
  }

  resize(cssW: number, cssH: number, dpr: number) {
    this.dpr = dpr;
    this.canvas.width = Math.round(cssW * dpr);
    this.canvas.height = Math.round(cssH * dpr);
    this.fullClear = true;
    this.lastSig = '';
  }

  /** 可点击区域 [x0, y0, x1, y1]（CSS 像素）：不透明像素包围盒 + 外扩 */
  hitRect(pad: number): [number, number, number, number] | null {
    const o = this.frame?.opaque;
    if (!o) return null;
    const d = this.dpr;
    return [o.x0 / d - pad, o.y0 / d - pad, o.x1 / d + pad, o.y1 / d + pad];
  }

  /** CSS 像素坐标是否点在宠物上 */
  hitTest(x: number, y: number, pad: number): boolean {
    const r = this.hitRect(pad);
    return r !== null && x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3];
  }

  draw(pet: Pet, particles: ParticleSystem, T: Tuning, dt: number) {
    const frame = this.rasterize(pet, T);
    this.frame = frame;

    const fast = Math.hypot(pet.vel.x, pet.vel.y) > T.trailSpeed;
    if (T.trail && fast && (pet.mode === 'air' || pet.mode === 'roll')) this.pushGhost(frame);
    for (const g of this.ghosts) g.age += dt;
    while (this.ghosts.length && this.ghosts[0].age > GHOST_LIFE) this.ghostPool.push(this.ghosts.shift()!.canvas);

    const showStars = pet.dizzy > 0.3 && pet.mode !== 'air' && pet.mode !== 'held';
    const animated =
      this.ghosts.length > 0 ||
      (T.particles && particles.list.length > 0) ||
      showStars ||
      pet.emote !== null ||
      T.showHitbox ||
      T.showVelocity;
    const sig = `${frame.ox},${frame.oy},${frame.w},${frame.h},${frame.up},${frame.hash}`;
    if (!animated && !this.fullClear && sig === this.lastSig) return;
    this.lastSig = animated ? '' : sig;

    const ctx = this.ctx;
    if (this.fullClear) {
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      this.fullClear = false;
    } else {
      for (const r of this.dirty) ctx.clearRect(r.x, r.y, r.w, r.h);
    }
    this.dirty = [];
    ctx.imageSmoothingEnabled = false;

    for (const g of this.ghosts) {
      ctx.globalAlpha = 0.35 * (1 - g.age / GHOST_LIFE);
      this.blit(g.canvas, g.ox, g.oy, g.w, g.h, g.up);
    }
    ctx.globalAlpha = 1;
    this.blit(this.sprite, frame.ox, frame.oy, frame.w, frame.h, frame.up);

    if (T.particles) this.drawParticles(particles, frame.up);
    if (showStars) this.drawStars(pet, frame);
    if (pet.emote) this.drawEmote(pet, frame);
    if (T.showHitbox || T.showVelocity) this.drawDebug(pet, T);
  }

  // ---------- 精灵栅格化 ----------

  private rasterize(pet: Pet, T: Tuning): SpriteFrame {
    const skin = this.skin;
    const dpr = this.dpr;
    const artRes = Math.max(1, Math.round(T.artRes));
    const up = Math.max(1, Math.round((T.petScale * dpr) / artRes));
    const unitCss = (up * artRes) / dpr;
    const pose = computePose(pet, skin);
    const m = mul(scale(dpr), bodyTransform(pet, unitCss));

    // 精灵像素网格对齐到宠物中心（取整），这样平移时像素不会闪
    const anchor = apply(m, 0, 0);
    m.e += Math.round(anchor.x) - anchor.x;
    m.f += Math.round(anchor.y) - anchor.y;
    const ax = Math.round(anchor.x);
    const ay = Math.round(anchor.y);

    const [gw, gh] = skin.grid;
    const ta = skin.torsoAnchor;
    const n = skin.parts.length;
    const rects = new Float64Array(n * 4);
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < n; i++) {
      const part = skin.parts[i];
      const pp = pose.parts[i];
      const [x, y, w, h] = part.rect;
      let cx = x + w / 2 + pp.dx;
      let cy = y + h / 2 + pp.dy;
      let hw = (w / 2) * pp.sx;
      let hh = (h / 2) * pp.sy;
      if (part.role !== 'leg') {
        const t = pose.torso;
        cx = ta.x + (cx - ta.x) * t.sx + t.dx;
        cy = ta.y + (cy - ta.y) * t.sy + t.dy;
        hw *= t.sx;
        hh *= t.sy;
      }
      const x0 = cx - hw - gw / 2;
      const y0 = cy - hh - gh / 2;
      const x1 = cx + hw - gw / 2;
      const y1 = cy + hh - gh / 2;
      rects.set([x0, y0, x1, y1], i * 4);
      for (const [px, py] of [
        [x0, y0],
        [x1, y0],
        [x0, y1],
        [x1, y1],
      ]) {
        const p = apply(m, px, py);
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
      }
    }

    const ox = ax - Math.ceil((ax - minX) / up) * up;
    const oy = ay - Math.ceil((ay - minY) / up) * up;
    const W = Math.min(512, Math.max(1, Math.ceil((maxX - ox) / up)));
    const H = Math.min(512, Math.max(1, Math.ceil((maxY - oy) / up)));

    if (this.sprite.width < W || this.sprite.height < H) {
      this.sprite.width = Math.max(this.sprite.width, W);
      this.sprite.height = Math.max(this.sprite.height, H);
    }
    const img = new ImageData(W, H);
    const buf = new Uint32Array(img.data.buffer);
    const inv = invert(m);
    const colors = skin.parts.map((p) => p.rgba);
    let hash = 2166136261;
    let ox0 = Infinity;
    let oy0 = Infinity;
    let ox1 = -Infinity;
    let oy1 = -Infinity;

    for (let j = 0; j < H; j++) {
      const py = oy + (j + 0.5) * up;
      for (let i = 0; i < W; i++) {
        const px = ox + (i + 0.5) * up;
        const lx = inv.a * px + inv.c * py + inv.e;
        const ly = inv.b * px + inv.d * py + inv.f;
        let color = 0;
        for (let k = n - 1; k >= 0; k--) {
          const b = k * 4;
          if (lx >= rects[b] && lx < rects[b + 2] && ly >= rects[b + 1] && ly < rects[b + 3]) {
            color = colors[k];
            break;
          }
        }
        if (color) {
          buf[j * W + i] = color;
          if (i < ox0) ox0 = i;
          if (i > ox1) ox1 = i;
          if (j < oy0) oy0 = j;
          if (j > oy1) oy1 = j;
          hash = Math.imul(hash ^ (j * W + i) ^ color, 16777619);
        }
      }
    }
    this.sctx.putImageData(img, 0, 0);

    const opaque =
      ox1 >= ox0
        ? { x0: ox + ox0 * up, y0: oy + oy0 * up, x1: ox + (ox1 + 1) * up, y1: oy + (oy1 + 1) * up }
        : null;
    return { ox, oy, up, w: W, h: H, m, opaque, hash: hash >>> 0 };
  }

  private blit(src: HTMLCanvasElement, ox: number, oy: number, w: number, h: number, up: number) {
    this.ctx.drawImage(src, 0, 0, w, h, ox, oy, w * up, h * up);
    this.markDirty(ox, oy, w * up, h * up);
  }

  private pushGhost(f: SpriteFrame) {
    const c = this.ghostPool.pop() ?? document.createElement('canvas');
    if (c.width < f.w || c.height < f.h) {
      c.width = Math.max(c.width, f.w);
      c.height = Math.max(c.height, f.h);
    }
    const g = c.getContext('2d')!;
    g.clearRect(0, 0, c.width, c.height);
    g.drawImage(this.sprite, 0, 0, f.w, f.h, 0, 0, f.w, f.h);
    this.ghosts.push({ canvas: c, ox: f.ox, oy: f.oy, w: f.w, h: f.h, up: f.up, age: 0 });
    if (this.ghosts.length > 6) this.ghostPool.push(this.ghosts.shift()!.canvas);
  }

  // ---------- 特效 ----------

  private markDirty(x: number, y: number, w: number, h: number) {
    this.dirty.push({ x: Math.floor(x) - 2, y: Math.floor(y) - 2, w: Math.ceil(w) + 4, h: Math.ceil(h) + 4 });
  }

  private px(x: number, y: number, s: number, color: string) {
    const X = Math.round(x - s / 2);
    const Y = Math.round(y - s / 2);
    this.ctx.fillStyle = color;
    this.ctx.fillRect(X, Y, s, s);
    this.markDirty(X, Y, s, s);
  }

  private drawParticles(ps: ParticleSystem, up: number) {
    const d = this.dpr;
    for (const p of ps.list) {
      const k = p.life / p.maxLife;
      if (p.kind === 'shock') {
        // 沿表面向两边扩散的冲击线
        const r = (p.radius ?? 80) * (1 - k * k) * d;
        const len = 3;
        for (const s of [-1, 1]) {
          for (let i = 0; i < len; i++) {
            const off = r + i * up;
            this.px(p.x * d + (p.tx ?? 1) * off * s, p.y * d + (p.ty ?? 0) * off * s - up / 2, up, p.color);
          }
        }
        continue;
      }
      // 像素风：不做透明渐隐，用"缩小一格一格"表现消散
      const cells = Math.max(1, Math.round(p.size * (0.4 + 0.6 * k)));
      this.px(p.x * d, p.y * d, cells * up, p.color);
    }
  }

  private drawStars(pet: Pet, f: SpriteFrame) {
    const [gw, gh] = this.skin.grid;
    const t = pet.t;
    for (let i = 0; i < 3; i++) {
      const a = t * 5 + (i * Math.PI * 2) / 3;
      const lx = Math.cos(a) * gw * 0.35;
      const ly = -gh / 2 - 2 + Math.sin(a) * 0.8;
      const p = apply(f.m, lx, ly);
      const u = f.up;
      this.px(p.x, p.y, u, STAR);
      this.px(p.x - u, p.y, u, STAR);
      this.px(p.x + u, p.y, u, STAR);
      this.px(p.x, p.y - u, u, STAR);
      this.px(p.x, p.y + u, u, STAR);
    }
  }

  private drawEmote(pet: Pet, f: SpriteFrame) {
    const e = pet.emote!;
    const ctx = this.ctx;
    const d = this.dpr;
    const u = f.up;
    const rise = Math.min(1, e.t / 0.08);
    const cx = Math.round((pet.pos.x + pet.visOffset.x) * d);
    const bottom = Math.round(
      (pet.pos.y + pet.visOffset.y - Math.max(pet.halfW, pet.halfH)) * d - u * (2 + 2 * rise),
    );
    // 感叹号：2 格宽，竖条 4 格 + 空 1 格 + 点 1 格，深色描边
    const cells: [number, number][] = [];
    for (let y = 0; y < 4; y++) cells.push([0, y], [1, y]);
    cells.push([0, 5], [1, 5]);
    const x0 = cx - u;
    const y0 = bottom - 6 * u;
    const o = Math.max(1, Math.round(u / 2));
    ctx.fillStyle = INK;
    for (const [x, y] of cells) ctx.fillRect(x0 + x * u - o, y0 + y * u - o, u + 2 * o, u + 2 * o);
    ctx.fillStyle = STAR;
    for (const [x, y] of cells) ctx.fillRect(x0 + x * u, y0 + y * u, u, u);
    this.markDirty(x0 - o, y0 - o, 2 * u + 2 * o, 6 * u + 2 * o);
  }

  private drawDebug(pet: Pet, T: Tuning) {
    const ctx = this.ctx;
    const d = this.dpr;
    const cx = pet.pos.x * d;
    const cy = pet.pos.y * d;
    ctx.lineWidth = Math.max(1, d);
    if (T.showHitbox) {
      // 可站的窗口顶边：绿色；脚下那段：橙色
      for (const p of pet.platforms) {
        const on = pet.support !== null && pet.support.id === p.id && pet.pos.x >= p.x0 && pet.pos.x <= p.x1;
        ctx.fillStyle = on ? '#f97316' : '#22c55e';
        const h = Math.max(2, Math.round(2 * d));
        ctx.fillRect(p.x0 * d, p.y * d - h, (p.x1 - p.x0) * d, h);
        this.markDirty(p.x0 * d, p.y * d - h, (p.x1 - p.x0) * d, h);
      }
      const c = Math.abs(Math.cos(pet.rot));
      const s = Math.abs(Math.sin(pet.rot));
      const ex = (c * pet.halfW + s * pet.halfH) * d;
      const ey = (s * pet.halfW + c * pet.halfH) * d;
      ctx.strokeStyle = '#22c55e';
      ctx.strokeRect(cx - ex, cy - ey, ex * 2, ey * 2);
      this.markDirty(cx - ex - 2, cy - ey - 2, ex * 2 + 4, ey * 2 + 4);
      const o = this.frame?.opaque;
      if (o) {
        const pad = T.hitPadding * d;
        ctx.strokeStyle = '#3b82f6';
        ctx.strokeRect(o.x0 - pad, o.y0 - pad, o.x1 - o.x0 + pad * 2, o.y1 - o.y0 + pad * 2);
        this.markDirty(o.x0 - pad - 2, o.y0 - pad - 2, o.x1 - o.x0 + pad * 2 + 4, o.y1 - o.y0 + pad * 2 + 4);
      }
      const label = `${pet.mode}${pet.grounded ? '@' + pet.side : ''} ${Math.round(Math.hypot(pet.vel.x, pet.vel.y))}`;
      ctx.font = `${Math.round(12 * d)}px ui-monospace, monospace`;
      const tw = ctx.measureText(label).width;
      const tx = cx - tw / 2;
      const ty = cy - ey - 8 * d;
      ctx.fillStyle = 'rgba(0,0,0,0.7)';
      ctx.fillRect(tx - 4 * d, ty - 13 * d, tw + 8 * d, 17 * d);
      ctx.fillStyle = '#fff';
      ctx.fillText(label, tx, ty);
      this.markDirty(tx - 4 * d, ty - 13 * d, tw + 8 * d, 17 * d);
    }
    if (T.showVelocity) {
      const vx = pet.vel.x * 0.1 * d;
      const vy = pet.vel.y * 0.1 * d;
      ctx.strokeStyle = '#ef4444';
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + vx, cy + vy);
      ctx.stroke();
      this.markDirty(Math.min(cx, cx + vx), Math.min(cy, cy + vy), Math.abs(vx), Math.abs(vy));
    }
  }
}

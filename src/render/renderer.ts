import { type Affine, apply, clamp, invert, mul, scale } from '../engine/math';
import { type Tuning, cellSize, spritePixel } from '../engine/params';
import type { ParticleSystem } from '../engine/particles';
import { MAGIC_FIRE, MAGIC_FIRE_END, MAGIC_GROW, type Pet, wandGeom, wandLift } from '../engine/pet';
import { bodyTransform, computePose } from '../engine/pose';
import type { Skin } from '../skin/types';
import { type Clip, clipFrame } from './clips';
import { FurCache, drawItems, layoutItems } from './smooth';

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
  /** 特效（星星、爱心、感叹号、粒子）的像素块大小（设备像素） */
  fx: number;
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

/** 一块精灵画布：宠物先画进这里，再贴到主画布上 */
interface Target {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  fur: FurCache;
}

function makeTarget(): Target {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  return { canvas, ctx: canvas.getContext('2d', { willReadFrequently: false })!, fur: new FurCache() };
}
const STAR = '#f5c542';
const INK = '#141413';
const HEART = ['.#.#.', '#####', '.###.', '..#..'];
/** 魔法激光：从外到里 深紫、紫、粉、白芯；每层的基础粗细（特效像素） */
const BEAM = ['#6d3bd7', '#b15cff', '#ff7ad9', '#fff6fb'];
const BEAM_W = [11, 8, 5, 2];
/** 光束旁边蹦的亮点 */
const GLINT = ['#fff6fb', '#fee440'];
/** 八分音符 */
const NOTE = ['..##.', '..#.#', '..#..', '###..', '###..'];

/**
 * 像素风渲染：宠物先在低分辨率网格里按"旋转+形变"逐像素采样，再用最近邻放大。
 * 这样转起来像素块也始终整齐，不会糊边。
 * 平滑画风的皮肤（见 smooth.ts）按实际分辨率画进同一块精灵画布，残影、点击判定都照常用。
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
  private fur = new FurCache();
  /** 迷你 Clawd 之类的附加宠物：各有一块精灵画布 */
  private extras = new Map<Pet, Target>();
  /** 当前皮肤解码好了的播片 */
  private clips = new Map<string, Clip>();

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
    this.fur.clear();
    this.extras.clear();
    this.clips.clear();
  }

  setClip(id: string, clip: Clip) {
    this.clips.set(id, clip);
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

  /** extras：一起画的附加宠物（不参与点击判定、没有残影） */
  draw(pet: Pet, particles: ParticleSystem, T: Tuning, dt: number, extras: readonly Pet[] = []) {
    const main: Target = { canvas: this.sprite, ctx: this.sctx, fur: this.fur };
    const frame = this.rasterize(pet, T, main);
    this.frame = frame;
    for (const p of this.extras.keys()) if (!extras.includes(p)) this.extras.delete(p);

    const fast = Math.hypot(pet.vel.x, pet.vel.y) > T.trailSpeed;
    if (T.trail && fast && (pet.mode === 'air' || pet.mode === 'roll')) this.pushGhost(frame);
    for (const g of this.ghosts) g.age += dt;
    while (this.ghosts.length && this.ghosts[0].age > GHOST_LIFE) this.ghostPool.push(this.ghosts.shift()!.canvas);

    const showStars = pet.dizzy > 0.3 && pet.mode !== 'air' && pet.mode !== 'held';
    // Claude Code 在思考：头顶冒"……"
    const showThink = pet.agentMood === 'thinking' && pet.emote === null && (pet.mode === 'idle' || pet.mode === 'walk');
    const animated =
      this.ghosts.length > 0 ||
      (T.particles && particles.list.length > 0) ||
      showStars ||
      showThink ||
      extras.length > 0 ||
      pet.emote !== null ||
      pet.beamEnd !== null ||
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
    // 激光压在宠物下面：杖尖的星星盖住光束的起点
    if (pet.beamEnd) this.drawBeam(pet, frame);
    this.blit(this.sprite, frame.ox, frame.oy, frame.w, frame.h, frame.up);
    for (const p of extras) {
      let t = this.extras.get(p);
      if (!t) this.extras.set(p, (t = makeTarget()));
      const f = this.rasterize(p, p.tuning, t);
      this.blit(t.canvas, f.ox, f.oy, f.w, f.h, f.up);
    }

    if (T.particles) this.drawParticles(particles, frame.fx);
    if (showStars) this.drawStars(pet, frame);
    if (pet.emote) this.drawEmote(pet, frame);
    if (showThink) this.drawThink(pet, frame);
    if (T.showHitbox || T.showVelocity) this.drawDebug(pet, T);
  }

  // ---------- 精灵栅格化 ----------

  private rasterize(pet: Pet, T: Tuning, target: Target): SpriteFrame {
    const clip = pet.mode === 'clip' && pet.clip !== null ? this.clips.get(pet.clip) : undefined;
    if (clip) return this.drawClip(pet, T, target, clip);
    if (!this.skin.pixelArt) return this.drawSmooth(pet, T, target);
    const skin = this.skin;
    const dpr = this.dpr;
    const up = spritePixel(T, dpr);
    const unitCss = cellSize(T, dpr);
    const pose = computePose(pet, skin);
    const m = mul(scale(dpr), bodyTransform(pet, unitCss));

    // 精灵像素网格对齐到宠物中心（取整），这样平移时像素不会闪
    const anchor = apply(m, 0, 0);
    m.e += Math.round(anchor.x) - anchor.x;
    m.f += Math.round(anchor.y) - anchor.y;
    const ax = Math.round(anchor.x);
    const ay = Math.round(anchor.y);

    const [gw, gh] = skin.grid;
    // 躯干变换（以身体底边中点为锚缩放再平移），坐标都换成以网格中心为原点
    const t = pose.torso;
    const tax = skin.torsoAnchor.x - gw / 2;
    const tay = skin.torsoAnchor.y - gh / 2;
    // 部件在前，道具在后（画在最上面）
    const np = skin.parts.length;
    const n = np + pose.props.length;
    /** 每项：摆好姿势、还没转也没跟躯干缩放的矩形 x0 y0 x1 y1 */
    const rects = new Float64Array(n * 4);
    /** 每项：绕关节旋转的 cos、sin 和关节位置 */
    const joints = new Float64Array(n * 4);
    const torsoed = new Uint8Array(n);
    const colors = new Uint32Array(n);
    const bitmaps: ({ w: number; h: number; data: Uint32Array } | null)[] = new Array(n).fill(null);
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < n; i++) {
      let x: number, y: number, w: number, h: number;
      let pp = { dx: 0, dy: 0, sx: 1, sy: 1, rot: 0 };
      let followTorso: boolean;
      let pivot: [number, number] | undefined;
      if (i < np) {
        const part = skin.parts[i];
        [x, y, w, h] = part.rect;
        pp = { ...pose.parts[i] };
        followTorso = part.role !== 'leg' && !part.anchored;
        colors[i] = part.rgba;
        pivot = part.pivot;
        const bm = part.bitmap;
        if (bm) {
          // 有这个表情的图就用表情图；没有的话眯眼、眨眼时换闭眼图。换了图都不再压扁
          const face = bm.faces?.[pose.face];
          const closed = !face && bm.closed && pp.sy < 0.6;
          bitmaps[i] = { w: bm.w, h: bm.h, data: face ?? (closed ? bm.closed! : bm.data) };
          if (face || closed) pp.sy = 1;
        }
      } else {
        const prop = pose.props[i - np];
        ({ x, y, w, h } = prop);
        followTorso = !!prop.torso;
        colors[i] = prop.rgba;
      }
      const cx = x + w / 2 + pp.dx - gw / 2;
      const cy = y + h / 2 + pp.dy - gh / 2;
      const hw = (w / 2) * pp.sx;
      const hh = (h / 2) * pp.sy;
      rects.set([cx - hw, cy - hh, cx + hw, cy + hh], i * 4);
      const c = Math.cos(pp.rot);
      const sn = Math.sin(pp.rot);
      const pvx = (pivot ? pivot[0] : x + w / 2) + pp.dx - gw / 2;
      const pvy = (pivot ? pivot[1] : y + h / 2) + pp.dy - gh / 2;
      joints.set([c, sn, pvx, pvy], i * 4);
      torsoed[i] = followTorso ? 1 : 0;
      for (const [qx, qy] of [
        [cx - hw, cy - hh],
        [cx + hw, cy - hh],
        [cx - hw, cy + hh],
        [cx + hw, cy + hh],
      ]) {
        let px = pvx + c * (qx - pvx) - sn * (qy - pvy);
        let py = pvy + sn * (qx - pvx) + c * (qy - pvy);
        if (followTorso) {
          px = tax + (px - tax) * t.sx + t.dx;
          py = tay + (py - tay) * t.sy + t.dy;
        }
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

    if (target.canvas.width < W || target.canvas.height < H) {
      target.canvas.width = Math.max(target.canvas.width, W);
      target.canvas.height = Math.max(target.canvas.height, H);
    }
    const img = new ImageData(W, H);
    const buf = new Uint32Array(img.data.buffer);
    const inv = invert(m);
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
        // 撤掉躯干变换后的坐标：跟躯干走的部件都在这个坐标系里比
        const tx = tax + (lx - t.dx - tax) / t.sx;
        const ty = tay + (ly - t.dy - tay) / t.sy;
        let color = 0;
        for (let k = n - 1; k >= 0 && !color; k--) {
          const b = k * 4;
          let qx = torsoed[k] ? tx : lx;
          let qy = torsoed[k] ? ty : ly;
          const sn = joints[b + 1];
          if (sn !== 0) {
            // 撤掉绕关节的旋转
            const c = joints[b];
            const dx = qx - joints[b + 2];
            const dy = qy - joints[b + 3];
            qx = joints[b + 2] + c * dx + sn * dy;
            qy = joints[b + 3] - sn * dx + c * dy;
          }
          if (!(qx >= rects[b] && qx < rects[b + 2] && qy >= rects[b + 1] && qy < rects[b + 3])) continue;
          const bm = bitmaps[k];
          if (!bm) {
            color = colors[k];
            continue;
          }
          // 像素图：透明的地方露出下面的部件
          const u = Math.min(bm.w - 1, Math.floor(((qx - rects[b]) / (rects[b + 2] - rects[b])) * bm.w));
          const v = Math.min(bm.h - 1, Math.floor(((qy - rects[b + 1]) / (rects[b + 3] - rects[b + 1])) * bm.h));
          color = bm.data[v * bm.w + u];
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
    target.ctx.putImageData(img, 0, 0);

    const opaque =
      ox1 >= ox0
        ? { x0: ox + ox0 * up, y0: oy + oy0 * up, x1: ox + (ox1 + 1) * up, y1: oy + (oy1 + 1) * up }
        : null;
    return { ox, oy, up, w: W, h: H, m, opaque, hash: hash >>> 0, fx: up };
  }

  /** 平滑画风：画进精灵画布，1 个精灵像素 = 1 个设备像素 */
  private drawSmooth(pet: Pet, T: Tuning, target: Target): SpriteFrame {
    const skin = this.skin;
    const dpr = this.dpr;
    const unit = cellSize(T, dpr, false);
    const m = mul(scale(dpr), bodyTransform(pet, unit));
    const items = layoutItems(skin, computePose(pet, skin));
    const [gw, gh] = skin.grid;

    // 包围盒（设备像素）：每个部件的四个角（考虑部件自身的旋转）变换到屏幕上
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let hash = 2166136261;
    for (const it of items) {
      const c = Math.cos(it.rot);
      const s = Math.sin(it.rot);
      for (const [px, py] of [
        [-it.hw, -it.hh],
        [it.hw, -it.hh],
        [-it.hw, it.hh],
        [it.hw, it.hh],
      ]) {
        const p = apply(m, it.cx - gw / 2 + c * px - s * py, it.cy - gh / 2 + s * px + c * py);
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
      }
      for (const v of [it.cx, it.cy, it.hw, it.hh, it.rgba]) hash = Math.imul(hash ^ Math.round(v * 64), 16777619);
    }
    for (const v of [m.a, m.b, m.c, m.d, m.e, m.f]) hash = Math.imul(hash ^ Math.round(v * 64), 16777619);

    const ox = Math.floor(minX) - 1;
    const oy = Math.floor(minY) - 1;
    const W = Math.min(2048, Math.max(1, Math.ceil(maxX) + 1 - ox));
    const H = Math.min(2048, Math.max(1, Math.ceil(maxY) + 1 - oy));
    if (target.canvas.width < W || target.canvas.height < H) {
      target.canvas.width = Math.max(target.canvas.width, W);
      target.canvas.height = Math.max(target.canvas.height, H);
    }
    const g = target.ctx;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, W, H);
    drawItems(g, items, skin, m, ox, oy, unit * dpr, target.fur);

    const opaque = Number.isFinite(minX) ? { x0: minX, y0: minY, x1: maxX, y1: maxY } : null;
    return { ox, oy, up: 1, w: W, h: H, m, opaque, hash: hash >>> 0, fx: spritePixel(T, dpr) };
  }

  /**
   * 播片：GIF 的一格 = 2 个精灵像素（clawd-400 的 Clawd 脚宽 16 格，和我们的 Clawd 差不多宽），
   * 脚底贴着宠物脚下的地面、左右居中。只在地上播，所以不管旋转和压扁。
   */
  private drawClip(pet: Pet, T: Tuning, target: Target, clip: Clip): SpriteFrame {
    const dpr = this.dpr;
    const f = clipFrame(clip, pet.modeTime);
    const up = Math.max(1, Math.round((cellSize(T, dpr, this.skin.pixelArt) * dpr * 2) / 3));
    const ox = Math.round((pet.pos.x + pet.visOffset.x) * dpr - (clip.w / 2) * up);
    const oy = Math.round((pet.pos.y + pet.visOffset.y + pet.halfH) * dpr - clip.floor * up);
    if (target.canvas.width < clip.w || target.canvas.height < clip.h) {
      target.canvas.width = Math.max(target.canvas.width, clip.w);
      target.canvas.height = Math.max(target.canvas.height, clip.h);
    }
    target.ctx.putImageData(f.image, 0, 0);
    const b = f.box;
    const opaque = b ? { x0: ox + b.x0 * up, y0: oy + b.y0 * up, x1: ox + b.x1 * up, y1: oy + b.y1 * up } : null;
    const hash = Math.imul(clip.frames.indexOf(f) + 1, 2654435761) >>> 0;
    const m = mul(scale(dpr), bodyTransform(pet, cellSize(T, dpr, this.skin.pixelArt)));
    return { ox, oy, up, w: clip.w, h: clip.h, m, opaque, hash, fx: spritePixel(T, dpr) };
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
      if (p.kind === 'heart' || p.kind === 'note') {
        // 像素小爱心/音符，快消失时缩小一号
        const art = p.kind === 'heart' ? HEART : NOTE;
        const u = Math.max(1, Math.round(up * (k > 0.35 ? 1.5 : 1)));
        const x0 = Math.round(p.x * d - 2.5 * u);
        const y0 = Math.round(p.y * d - (art.length / 2) * u);
        this.ctx.fillStyle = p.color;
        for (let j = 0; j < art.length; j++) {
          for (let i = 0; i < art[j].length; i++) {
            if (art[j][i] === '#') this.ctx.fillRect(x0 + i * u, y0 + j * u, u, u);
          }
        }
        this.markDirty(x0, y0, 5 * u, art.length * u);
        continue;
      }
      if (p.kind === 'fluff') {
        // 一小撮毛：实心小团 + 一圈往外翘的短毛，边飘边变淡、边转
        const rad = p.size * up * (0.7 + 0.3 * k);
        const x = p.x * d;
        const y = p.y * d;
        const ctx = this.ctx;
        ctx.globalAlpha = Math.min(1, k * 1.6);
        ctx.fillStyle = p.color;
        ctx.strokeStyle = p.color;
        ctx.lineWidth = Math.max(1, up * 0.3);
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.arc(x, y, rad * 0.45, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        const spin = p.life * 3 + p.maxLife * 10;
        for (let i = 0; i < 9; i++) {
          const a = spin + (i / 9) * Math.PI * 2;
          const len = rad * (i % 2 ? 0.8 : 1);
          ctx.moveTo(x + Math.cos(a) * rad * 0.3, y + Math.sin(a) * rad * 0.3);
          ctx.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len);
        }
        ctx.stroke();
        ctx.globalAlpha = 1;
        this.markDirty(x - rad, y - rad, rad * 2, rad * 2);
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
      const u = f.fx;
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
    const u = f.fx;
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

  /**
   * 魔法激光：从杖尖射到 beamEnd，0.1 秒射出去，最后 0.25 秒变细消失。
   * 粗细沿着光束一鼓一鼓地往前涌，旁边蹦亮点；杖尖先炸一圈光芒，打中的地方先一大团白光，
   * 之后一圈一圈往外扩的冲击环。都按特效像素一格一格画，斜着射也是像素台阶。
   */
  private drawBeam(pet: Pet, f: SpriteFrame) {
    const end = pet.beamEnd!;
    const d = this.dpr;
    const u = f.fx;
    const ctx = this.ctx;
    const [gw, gh] = this.skin.grid;
    const g = wandGeom(this.skin.grid, pet.dir, pet.aim, wandLift(pet.modeTime));
    const a = apply(f.m, g.tx / 3 - gw / 2, g.ty / 3 - gh / 2);
    const since = pet.modeTime - MAGIC_FIRE;
    const grow = clamp(since / MAGIC_GROW, 0, 1);
    const fade = clamp((MAGIC_FIRE_END - pet.modeTime) / 0.25, 0, 1);
    const flick = Math.floor(pet.t * 24) % 2;
    const ex = end.x * d;
    const ey = end.y * d;
    const bx = a.x + (ex - a.x) * grow;
    const by = a.y + (ey - a.y) * grow;
    const len = Math.hypot(bx - a.x, by - a.y);
    const n = Math.max(1, Math.ceil(len / u));
    // 垂直于光束的方向：亮点往两边蹦
    const nx = len > 0 ? -(by - a.y) / len : 0;
    const ny = len > 0 ? (bx - a.x) / len : 1;
    const snap = (v: number) => Math.round(v / u) * u;
    let x0 = Math.min(a.x, bx);
    let y0 = Math.min(a.y, by);
    let x1 = Math.max(a.x, bx);
    let y1 = Math.max(a.y, by);
    const growBox = (x: number, y: number, r: number) => {
      x0 = Math.min(x0, x - r);
      y0 = Math.min(y0, y - r);
      x1 = Math.max(x1, x + r);
      y1 = Math.max(y1, y + r);
    };
    const dot = (x: number, y: number, s: number) => ctx.fillRect(snap(x) - s / 2, snap(y) - s / 2, s, s);
    /** 实心像素圆 */
    const disk = (cx: number, cy: number, r: number, color: string) => {
      ctx.fillStyle = color;
      const k = Math.ceil(r / u);
      for (let j = -k; j <= k; j++) {
        const w = Math.floor(Math.sqrt(Math.max(0, k * k - j * j)));
        ctx.fillRect(snap(cx) - w * u - u / 2, snap(cy) + j * u - u / 2, (2 * w + 1) * u, u);
      }
      growBox(cx, cy, (k + 1) * u);
    };

    // 光束：每层粗细沿着光束一鼓一鼓地往前涌
    BEAM.forEach((color, layer) => {
      const base = BEAM_W[layer] * (layer === BEAM.length - 1 ? Math.min(1, fade * 2) : fade);
      if (base < 0.5) return;
      ctx.fillStyle = color;
      for (let i = 0; i <= n; i++) {
        const surge = layer === BEAM.length - 1 ? 1 : 1 + 0.3 * Math.sin(i * 0.45 - pet.t * 50) + 0.1 * flick;
        const s = Math.max(1, Math.round(base * surge)) * u;
        dot(a.x + ((bx - a.x) * i) / n, a.y + ((by - a.y) * i) / n, s);
      }
    });
    const halfW = (BEAM_W[0] * 1.4 * u) / 2;
    growBox(a.x, a.y, halfW);
    growBox(bx, by, halfW);

    // 光束两边蹦的亮点：每帧换一批
    const frame = Math.floor(pet.t * 30);
    for (let i = 0; i < n; i += 5) {
      const h = Math.imul(i * 2654435761 ^ frame * 40503, 2246822519) >>> 0;
      if (h % 3) continue;
      const side = (h & 8 ? 1 : -1) * (halfW + ((h >>> 4) % 4) * u);
      ctx.fillStyle = GLINT[(h >>> 8) & 1];
      dot(a.x + ((bx - a.x) * i) / n + nx * side, a.y + ((by - a.y) * i) / n + ny * side, u);
    }
    growBox(a.x, a.y, halfW + 4 * u);
    growBox(bx, by, halfW + 4 * u);

    // 杖尖：刚开火炸出一圈八道光芒，之后一直亮着一团
    if (since < 0.18) {
      const k = 1 - since / 0.18;
      const r = (4 + 12 * k) * u;
      ctx.fillStyle = BEAM[3];
      for (let i = 0; i < 8; i++) {
        const ang = (i / 8) * Math.PI * 2;
        for (let s = u; s <= r; s += u) dot(a.x + Math.cos(ang) * s, a.y + Math.sin(ang) * s, i % 2 ? u : 2 * u);
      }
      growBox(a.x, a.y, r + 2 * u);
    }
    disk(a.x, a.y, (3 + flick) * u * Math.max(0.4, fade), BEAM[2]);
    disk(a.x, a.y, 1.5 * u * Math.max(0.4, fade), BEAM[3]);

    if (grow < 1 || fade <= 0) {
      this.markDirty(x0, y0, x1 - x0, y1 - y0);
      return;
    }
    const hit = since - MAGIC_GROW;
    // 刚打中：一大团白光，0.15 秒缩回去
    if (hit < 0.15) {
      const k = 1 - hit / 0.15;
      disk(bx, by, (6 + 10 * k) * u, BEAM[1]);
      disk(bx, by, (4 + 8 * k) * u, BEAM[3]);
    }
    // 一圈一圈往外扩的冲击环
    for (let ring = 0; ring < 3; ring++) {
      const ph = (hit * 3.5 + ring / 3) % 1;
      if (ph > 0.85) continue;
      const r = (3 + ph * 18) * u * (0.5 + 0.5 * fade);
      ctx.fillStyle = BEAM[3 - Math.min(3, Math.floor(ph * 4))];
      const steps = Math.max(8, Math.ceil((2 * Math.PI * r) / u));
      for (let i = 0; i < steps; i++) {
        const ang = (i / steps) * Math.PI * 2;
        dot(bx + Math.cos(ang) * r, by + Math.sin(ang) * r, u);
      }
      growBox(bx, by, r + 2 * u);
    }
    // 打中的地方：一团亮光 + 十字闪光
    disk(bx, by, (3 + flick * 2) * u * fade, BEAM[2]);
    const r = (flick ? 6 : 4) * u * fade;
    ctx.fillStyle = BEAM[3];
    ctx.fillRect(snap(bx) - r - u / 2, snap(by) - u / 2, 2 * r + u, u);
    ctx.fillRect(snap(bx) - u / 2, snap(by) - r - u / 2, u, 2 * r + u);
    disk(bx, by, 1.5 * u, BEAM[3]);
    this.markDirty(x0, y0, x1 - x0, y1 - y0);
  }

  /** 思考中：头顶三个点，像聊天软件的"对方正在输入"一样轮流亮 */
  private drawThink(pet: Pet, f: SpriteFrame) {
    const ctx = this.ctx;
    const d = this.dpr;
    const u = f.fx;
    const cx = Math.round((pet.pos.x + pet.visOffset.x) * d);
    const y = Math.round((pet.pos.y + pet.visOffset.y - Math.max(pet.halfW, pet.halfH)) * d - u * 4);
    const lit = Math.floor(pet.t * 3) % 3;
    const o = Math.max(1, Math.round(u / 2));
    for (let i = 0; i < 3; i++) {
      const x = cx + (i - 1) * 3 * u - Math.round(u / 2);
      const yy = y - (i === lit ? u : 0);
      ctx.fillStyle = INK;
      ctx.fillRect(x - o, yy - o, u + 2 * o, u + 2 * o);
      ctx.fillStyle = i === lit ? '#ffffff' : '#c9ccd3';
      ctx.fillRect(x, yy, u, u);
      this.markDirty(x - o, yy - o, u + 2 * o, u + 2 * o + u);
    }
  }

  private drawDebug(pet: Pet, T: Tuning) {
    const ctx = this.ctx;
    const d = this.dpr;
    const cx = pet.pos.x * d;
    const cy = pet.pos.y * d;
    ctx.lineWidth = Math.max(1, d);
    if (T.showHitbox) {
      // 正在输入的输入框：紫色
      const z = pet.inputZone;
      if (z) {
        ctx.strokeStyle = '#a855f7';
        ctx.strokeRect(z.left * d, z.top * d, (z.right - z.left) * d, (z.bottom - z.top) * d);
        this.markDirty(z.left * d - 2, z.top * d - 2, (z.right - z.left) * d + 4, (z.bottom - z.top) * d + 4);
      }
      // 屏幕边框（多块屏幕拼出来的）：青色；正贴着的那段加粗
      for (const g of pet.world.segs) {
        const on = g === pet.seg;
        const t = Math.max(1, Math.round((on ? 3 : 1.5) * d));
        const horizontal = g.side === 'floor' || g.side === 'ceiling';
        // 画在屏幕里侧，不然贴边的线画到屏幕外面去了
        const inward = g.side === 'floor' || g.side === 'right' ? -t : 0;
        const [x, y, w, h] = horizontal
          ? [g.a * d, g.c * d + inward, (g.b - g.a) * d, t]
          : [g.c * d + inward, g.a * d, t, (g.b - g.a) * d];
        ctx.fillStyle = on ? '#06b6d4' : 'rgba(6, 182, 212, 0.7)';
        ctx.fillRect(x, y, w, h);
        this.markDirty(x, y, w, h);
      }
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

import { rand } from './math';
import type { ImpactTier, PetEvent } from './pet';

export type ParticleKind = 'dust' | 'debris' | 'shock' | 'heart' | 'fluff' | 'note' | 'confetti' | 'spark' | 'smoke';

export interface Particle {
  kind: ParticleKind;
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  /** 以"像素格"为单位的大小（渲染器乘上像素尺寸） */
  size: number;
  color: string;
  drag: number;
  gravity: number;
  /** shock 用：沿表面的切线方向和最大半径 */
  tx?: number;
  ty?: number;
  radius?: number;
}

// 深浅两种烟尘颜色，浅色桌面和深色桌面上都看得见
const DUST = ['#e9e1d5', '#9b8f82'];
const DEBRIS = '#b45f43';
const HEART = '#ff6b8a';
const GOLD = ['#f5c542', '#b07d12', '#fff4b8'];
const NOTE = ['#f5c542', '#79c0ff', '#ff9d8f'];
const CONFETTI = ['#f0524f', '#f5c542', '#2fbf71', '#79c0ff', '#c084fc', '#ff9d8f', '#fffbe6'];
const SPARK = ['#fff4b8', '#f5c542', '#ffffff', '#9fd8ff'];
const SMOKE = ['#5b5752', '#7d7770', '#3f3c39'];

const DUST_COUNT: Record<ImpactTier, number> = {
  soft: 3,
  bounce: 5,
  roll: 8,
  hero: 16,
  splat: 20,
  wall: 5,
  cling: 10,
};

export class ParticleSystem {
  list: Particle[] = [];
  private max = 400;
  /** 抖毛时甩出来的毛团颜色（跟着皮肤换） */
  fluffColor = '#ffffff';

  constructor(private rng: () => number = Math.random) {}

  clear() {
    this.list.length = 0;
  }

  handle(ev: PetEvent) {
    if (ev.type === 'impact') this.impact(ev.tier, ev.x, ev.y, ev.nx, ev.ny, ev.speed);
    else if (ev.type === 'rolling') this.rolling(ev.x, ev.y, ev.vx);
    else if (ev.type === 'fling') this.impact('bounce', ev.x, ev.y, 0, -1, Math.hypot(ev.vx, ev.vy));
    else if (ev.type === 'heart') this.heart(ev.x, ev.y, ev.nx, ev.ny);
    else if (ev.type === 'chomp') this.chomp(ev.x, ev.y, ev.nx, ev.ny);
    else if (ev.type === 'fluff') this.fluff(ev.x, ev.y, ev.nx, ev.ny);
    else if (ev.type === 'ding') this.ding(ev.x, ev.y, ev.nx, ev.ny);
    else if (ev.type === 'confetti') this.confetti(ev.x, ev.y, ev.nx, ev.ny);
    else if (ev.type === 'spark') this.spark(ev.x, ev.y);
    else if (ev.type === 'smoke') this.smoke(ev.x, ev.y);
    else if (ev.type === 'sweep') this.sweep(ev.x, ev.y, ev.dir);
    else if (ev.type === 'poof') this.poof(ev.x, ev.y);
  }

  /** 庆祝：一把彩纸沿法线方向往外喷，慢悠悠飘下来 */
  private confetti(x: number, y: number, nx: number, ny: number) {
    const r = this.rng;
    const base = Math.atan2(ny, nx);
    for (let i = 0; i < 30; i++) {
      const a = base + (r() - 0.5) * 2.2;
      const sp = rand(450, 1100, r);
      const life = rand(1.3, 2.2, r);
      this.push({
        kind: 'confetti',
        x,
        y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        life,
        maxLife: life,
        size: r() < 0.3 ? 1.5 : 1,
        color: CONFETTI[Math.floor(r() * CONFETTI.length)],
        drag: 2.2,
        gravity: 700,
      });
    }
  }

  /** 被电：一个点上崩出几粒很快熄灭的火花 */
  private spark(x: number, y: number) {
    const r = this.rng;
    for (let i = 0; i < 3; i++) {
      const a = r() * Math.PI * 2;
      const sp = rand(250, 700, r);
      const life = rand(0.12, 0.28, r);
      this.push({
        kind: 'spark',
        x,
        y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        life,
        maxLife: life,
        size: 1,
        color: SPARK[Math.floor(r() * SPARK.length)],
        drag: 4,
        gravity: 0,
      });
    }
  }

  /** 电糊了：头顶冒一股黑烟 */
  private smoke(x: number, y: number) {
    const r = this.rng;
    for (let i = 0; i < 7; i++) {
      const life = rand(1, 1.7, r);
      this.push({
        kind: 'smoke',
        x: x + rand(-12, 12, r),
        y,
        vx: rand(-40, 40, r),
        vy: rand(-160, -60, r),
        life,
        maxLife: life,
        size: rand(2, 3.5, r),
        color: SMOKE[Math.floor(r() * SMOKE.length)],
        drag: 1,
        gravity: -30,
      });
    }
  }

  /** 扫地：顺着扫帚的方向贴地扬起一小撮灰 */
  private sweep(x: number, y: number, dir: number) {
    const r = this.rng;
    for (let i = 0; i < 4; i++) {
      const life = rand(0.45, 0.8, r);
      this.push({
        kind: 'dust',
        x: x + rand(-6, 6, r),
        y: y - 2,
        vx: dir * rand(140, 360, r),
        vy: rand(-170, -50, r),
        life,
        maxLife: life,
        size: rand(1, 2, r),
        color: DUST[i % 2],
        drag: 3,
        gravity: 500,
      });
    }
  }

  /** 迷你 Clawd 消失：噗地一团白烟 */
  private poof(x: number, y: number) {
    const r = this.rng;
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2 + r() * 0.4;
      const sp = rand(120, 260, r);
      const life = rand(0.35, 0.6, r);
      this.push({
        kind: 'dust',
        x,
        y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        life,
        maxLife: life,
        size: rand(1.5, 2.5, r),
        color: DUST[0],
        drag: 5,
        gravity: 0,
      });
    }
  }

  /** 摇铃：一个音符飘起来，晃晃悠悠往外走 */
  private ding(x: number, y: number, nx: number, ny: number) {
    const r = this.rng;
    const side = r() < 0.5 ? 1 : -1;
    const life = rand(0.9, 1.3, r);
    this.push({
      kind: 'note',
      x,
      y,
      vx: -ny * side * rand(40, 90, r) + nx * rand(60, 100, r),
      vy: nx * side * rand(40, 90, r) + ny * rand(60, 100, r),
      life,
      maxLife: life,
      size: 1,
      color: NOTE[Math.floor(r() * NOTE.length)],
      drag: 1.5,
      gravity: 0,
    });
  }

  /** 抖毛：几撮毛往两边甩出去，轻飘飘地落下 */
  private fluff(x: number, y: number, nx: number, ny: number) {
    const r = this.rng;
    const tx = -ny;
    const ty = nx;
    for (let i = 0; i < 4; i++) {
      const side = i % 2 === 0 ? 1 : -1;
      const along = side * rand(140, 320, r);
      const out = rand(40, 200, r);
      const life = rand(0.7, 1.2, r);
      this.push({
        kind: 'fluff',
        x: x + tx * side * rand(10, 30, r),
        y: y + ty * side * rand(10, 30, r),
        vx: tx * along + nx * out,
        vy: ty * along + ny * out,
        life,
        maxLife: life,
        size: rand(1.5, 2.5, r),
        color: this.fluffColor,
        drag: 3.5,
        gravity: -120 * ny, // 毛很轻：慢慢往"下"（远离表面法线的方向）飘
      });
    }
  }

  /** 摸摸：头顶冒出一颗小爱心，慢慢飘走 */
  private heart(x: number, y: number, nx: number, ny: number) {
    const r = this.rng;
    const life = rand(0.9, 1.3, r);
    const side = rand(-60, 60, r);
    this.push({
      kind: 'heart',
      x: x - ny * rand(-20, 20, r),
      y: y + nx * rand(-20, 20, r),
      vx: nx * 90 - ny * side,
      vy: ny * 90 + nx * side,
      life,
      maxLife: life,
      size: 1,
      color: HEART,
      drag: 1.5,
      gravity: 0,
    });
  }

  /** 咬金币：金屑往外蹦 */
  private chomp(x: number, y: number, nx: number, ny: number) {
    const r = this.rng;
    for (let i = 0; i < 6; i++) {
      const life = rand(0.35, 0.7, r);
      const a = Math.atan2(ny, nx) + rand(-1.2, 1.2, r);
      const sp = rand(180, 420, r);
      this.push({
        kind: 'debris',
        x: x + rand(-6, 6, r),
        y: y + rand(-6, 6, r),
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        life,
        maxLife: life,
        size: 1,
        color: GOLD[i % 3],
        drag: 1,
        gravity: 1800,
      });
    }
  }

  private push(p: Particle) {
    if (this.list.length >= this.max) this.list.shift();
    this.list.push(p);
  }

  private impact(tier: ImpactTier, x: number, y: number, nx: number, ny: number, speed: number) {
    const r = this.rng;
    // 表面切线
    const tx = -ny;
    const ty = nx;
    const power = Math.min(1.6, speed / 1800);
    const n = Math.round(DUST_COUNT[tier] * (0.6 + power * 0.4));

    for (let i = 0; i < n; i++) {
      const side = i % 2 === 0 ? 1 : -1;
      const along = side * rand(60, 320, r) * (0.5 + power);
      const out = rand(10, 140, r) * (0.4 + power * 0.6);
      const life = rand(0.3, 0.7, r);
      this.push({
        kind: 'dust',
        x: x + tx * rand(-8, 8, r),
        y: y + ty * rand(-8, 8, r),
        vx: tx * along + nx * out,
        vy: ty * along + ny * out,
        life,
        maxLife: life,
        size: tier === 'soft' ? 2 : rand(2, 4, r),
        color: DUST[i % 2],
        drag: 5,
        gravity: 30 * ny, // 地面的烟往上飘一点，天花板的往下落
        tx,
        ty,
      });
    }

    if (tier === 'hero' || tier === 'splat' || tier === 'cling') {
      this.push({
        kind: 'shock',
        x,
        y,
        vx: 0,
        vy: 0,
        life: 0.28,
        maxLife: 0.28,
        size: 1,
        color: DUST[1],
        drag: 0,
        gravity: 0,
        tx,
        ty,
        radius: 60 + 90 * power,
      });
      const debris = tier === 'cling' ? 3 : 6;
      for (let i = 0; i < debris; i++) {
        const life = rand(0.4, 0.8, r);
        const along = rand(-280, 280, r);
        const out = rand(300, 700, r) * power;
        this.push({
          kind: 'debris',
          x,
          y,
          vx: tx * along + nx * out,
          vy: ty * along + ny * out,
          life,
          maxLife: life,
          size: 1,
          color: DEBRIS,
          drag: 0.5,
          gravity: 2600,
        });
      }
    }
  }

  private rolling(x: number, y: number, vx: number) {
    const r = this.rng;
    const life = rand(0.25, 0.45, r);
    this.push({
      kind: 'dust',
      x: x - Math.sign(vx) * rand(10, 20, r),
      y,
      vx: -vx * 0.15 + rand(-30, 30, r),
      vy: -rand(20, 90, r),
      life,
      maxLife: life,
      size: rand(1, 3, r),
      color: DUST[r() < 0.5 ? 0 : 1],
      drag: 4,
      gravity: 0,
    });
  }

  step(dt: number) {
    const out: Particle[] = [];
    for (const p of this.list) {
      p.life -= dt;
      if (p.life <= 0) continue;
      const d = Math.max(0, 1 - p.drag * dt);
      p.vx *= d;
      p.vy *= d;
      p.vy += p.gravity * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      out.push(p);
    }
    this.list = out;
  }
}

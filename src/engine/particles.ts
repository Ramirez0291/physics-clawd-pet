import { rand } from './math';
import type { ImpactTier, PetEvent } from './pet';

export type ParticleKind = 'dust' | 'debris' | 'shock';

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

  constructor(private rng: () => number = Math.random) {}

  clear() {
    this.list.length = 0;
  }

  handle(ev: PetEvent) {
    if (ev.type === 'impact') this.impact(ev.tier, ev.x, ev.y, ev.nx, ev.ny, ev.speed);
    else if (ev.type === 'rolling') this.rolling(ev.x, ev.y, ev.vx);
    else if (ev.type === 'fling') this.impact('bounce', ev.x, ev.y, 0, -1, Math.hypot(ev.vx, ev.vy));
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

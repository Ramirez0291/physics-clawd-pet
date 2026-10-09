import type { Vec2 } from './math';

interface Sample {
  t: number; // ms
  x: number;
  y: number;
}

/**
 * 记录鼠标轨迹，用松手前一小段时间的平均速度作为甩出速度。
 * 只看最后一帧会非常抖（鼠标事件间隔不均匀），所以取一个时间窗口做最小二乘拟合。
 */
export class VelocitySampler {
  private samples: Sample[] = [];

  constructor(private keepMs = 400) {}

  clear() {
    this.samples.length = 0;
  }

  add(t: number, x: number, y: number) {
    const last = this.samples[this.samples.length - 1];
    if (last && t < last.t) this.samples.length = 0; // 时间回退（不同时钟源），重新开始
    this.samples.push({ t, x, y });
    const cutoff = t - this.keepMs;
    let drop = 0;
    while (drop < this.samples.length - 2 && this.samples[drop].t < cutoff) drop++;
    if (drop) this.samples.splice(0, drop);
  }

  /** 窗口 [now - windowMs, now] 内的速度（px/s）。样本不足返回 0。 */
  velocity(now: number, windowMs: number): Vec2 {
    const pts = this.samples.filter((s) => s.t >= now - windowMs);
    if (pts.length < 2) return { x: 0, y: 0 };
    const span = pts[pts.length - 1].t - pts[0].t;
    if (span < 8) return { x: 0, y: 0 };
    // 最小二乘斜率
    let mt = 0;
    let mx = 0;
    let my = 0;
    for (const p of pts) {
      mt += p.t;
      mx += p.x;
      my += p.y;
    }
    mt /= pts.length;
    mx /= pts.length;
    my /= pts.length;
    let stt = 0;
    let stx = 0;
    let sty = 0;
    for (const p of pts) {
      const dt = p.t - mt;
      stt += dt * dt;
      stx += dt * (p.x - mx);
      sty += dt * (p.y - my);
    }
    if (stt === 0) return { x: 0, y: 0 };
    return { x: (stx / stt) * 1000, y: (sty / stt) * 1000 };
  }

  /** 最后一个样本距 now 的时间（ms），用来判断"松手前是否已经停住" */
  idleMs(now: number): number {
    const last = this.samples[this.samples.length - 1];
    return last ? now - last.t : Infinity;
  }
}

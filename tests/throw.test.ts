import { describe, expect, it } from 'vitest';
import { VelocitySampler } from '../src/engine/throw';

describe('VelocitySampler', () => {
  it('采样间隔不均匀时也能拟合出匀速', () => {
    const s = new VelocitySampler();
    let t = 1000;
    for (const gap of [7, 9, 16, 8, 3, 12, 9, 11]) {
      t += gap;
      s.add(t, t * 2, t * -0.5); // 2000 px/s, -500 px/s
    }
    const v = s.velocity(t, 80);
    expect(v.x).toBeCloseTo(2000, 3);
    expect(v.y).toBeCloseTo(-500, 3);
  });

  it('样本不够时速度为 0', () => {
    const s = new VelocitySampler();
    s.add(0, 0, 0);
    expect(s.velocity(0, 80)).toEqual({ x: 0, y: 0 });
    s.add(4, 100, 0);
    expect(s.velocity(4, 80)).toEqual({ x: 0, y: 0 });
  });

  it('只看窗口内的样本', () => {
    const s = new VelocitySampler();
    for (let t = 0; t <= 200; t += 10) s.add(t, t < 100 ? t * 10 : 1000, 0);
    // 后 100ms 鼠标停住了
    expect(Math.abs(s.velocity(200, 80).x)).toBeLessThan(1e-9);
    expect(s.idleMs(260)).toBe(60);
  });
});

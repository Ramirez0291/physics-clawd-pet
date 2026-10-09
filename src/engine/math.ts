export interface Vec2 {
  x: number;
  y: number;
}

export const TAU = Math.PI * 2;

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const len = (x: number, y: number) => Math.hypot(x, y);
export const rand = (lo: number, hi: number, rng: () => number = Math.random) => lo + (hi - lo) * rng();

/** 把角度规范到 (-π, π] */
export function wrapAngle(a: number): number {
  a = a % TAU;
  if (a > Math.PI) a -= TAU;
  if (a <= -Math.PI) a += TAU;
  return a;
}

/** 与 a 最接近、且与 target 同余（模 2π）的角度 */
export function nearestEquivalent(a: number, target: number): number {
  return a + wrapAngle(target - a);
}

/** 帧率无关的指数趋近系数 */
export const approach = (rate: number, dt: number) => 1 - Math.exp(-rate * dt);

/** 2D 仿射矩阵 [a c e; b d f]：x' = a x + c y + e, y' = b x + d y + f */
export interface Affine {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

export const identity = (): Affine => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });

/** m1 · m2（先 m2 后 m1） */
export function mul(m1: Affine, m2: Affine): Affine {
  return {
    a: m1.a * m2.a + m1.c * m2.b,
    b: m1.b * m2.a + m1.d * m2.b,
    c: m1.a * m2.c + m1.c * m2.d,
    d: m1.b * m2.c + m1.d * m2.d,
    e: m1.a * m2.e + m1.c * m2.f + m1.e,
    f: m1.b * m2.e + m1.d * m2.f + m1.f,
  };
}

export const translate = (x: number, y: number): Affine => ({ a: 1, b: 0, c: 0, d: 1, e: x, f: y });
export const scale = (sx: number, sy: number = sx): Affine => ({ a: sx, b: 0, c: 0, d: sy, e: 0, f: 0 });
export function rotate(t: number): Affine {
  const c = Math.cos(t);
  const s = Math.sin(t);
  return { a: c, b: s, c: -s, d: c, e: 0, f: 0 };
}

/** 沿方向 angle 缩放 k 倍、垂直方向缩放 1/k（面积守恒的挤压/拉伸） */
export function squashAlong(angle: number, k: number): Affine {
  return mul(rotate(angle), mul(scale(k, 1 / k), rotate(-angle)));
}

export function invert(m: Affine): Affine {
  const det = m.a * m.d - m.b * m.c;
  const id = det === 0 ? 0 : 1 / det;
  return {
    a: m.d * id,
    b: -m.b * id,
    c: -m.c * id,
    d: m.a * id,
    e: (m.c * m.f - m.d * m.e) * id,
    f: (m.b * m.e - m.a * m.f) * id,
  };
}

export const apply = (m: Affine, x: number, y: number): Vec2 => ({
  x: m.a * x + m.c * y + m.e,
  y: m.b * x + m.d * y + m.f,
});

// 程序化动作：根据宠物状态给每个部件算偏移/缩放。
// 只依赖部件角色（body/eye/arm/leg），换皮肤不用改这里。

import type { Skin } from '../skin/types';
import { type Affine, type Vec2, clamp, mul, rotate, scale, squashAlong, translate } from './math';
import { NORMAL, type Pet } from './pet';

/** 单个部件的局部变换（格子单位），缩放以部件中心为锚 */
export interface PartPose {
  dx: number;
  dy: number;
  sx: number;
  sy: number;
}

/** 躯干（身体+眼睛+手臂）整体变换，以身体底边中点为锚 */
export interface Pose {
  torso: PartPose;
  parts: PartPose[];
}

const ident = (): PartPose => ({ dx: 0, dy: 0, sx: 1, sy: 1 });
const smoothstep = (x: number) => {
  const t = clamp(x, 0, 1);
  return t * t * (3 - 2 * t);
};

function blinking(t: number): boolean {
  // 两个不同周期叠加，眨眼间隔看起来不那么机械
  return t % 3.3 < 0.11 || (t + 1.3) % 7.7 < 0.11;
}

/** 眼睛看向哪里（宠物本地坐标，长度 ≤ 1） */
function lookVector(pet: Pet): Vec2 {
  const rot = pet.rot + pet.visRot;
  let wx = 0;
  let wy = 0;
  const v = pet.mode === 'held' ? pet.holdVel : pet.vel;
  if ((pet.mode === 'air' || pet.mode === 'held') && v && Math.hypot(v.x, v.y) > 200) {
    const sp = Math.hypot(v.x, v.y);
    wx = v.x / sp;
    wy = v.y / sp;
  } else if (pet.mode === 'walk') {
    // 沿面的切线方向（dir=+1 时 x 或 y 增大）
    const horizontal = pet.side === 'floor' || pet.side === 'ceiling';
    wx = horizontal ? pet.dir : 0;
    wy = horizontal ? 0 : pet.dir;
  } else if (pet.cursor) {
    const dx = pet.cursor.x - pet.pos.x;
    const dy = pet.cursor.y - pet.pos.y;
    const d = Math.hypot(dx, dy);
    if (d < 1200) {
      const m = Math.max(d, 140);
      wx = dx / m;
      wy = dy / m;
    }
  }
  const c = Math.cos(-rot);
  const s = Math.sin(-rot);
  return { x: clamp(c * wx - s * wy, -1, 1), y: clamp(s * wx + c * wy, -1, 1) };
}

export function computePose(pet: Pet, skin: Skin): Pose {
  const t = pet.t;
  const torso = ident();
  const parts = skin.parts.map(ident);
  const look = lookVector(pet);
  const bodyH = skin.parts.find((p) => p.role === 'body')?.rect[3] ?? skin.grid[1];
  const p = pet.modeDuration > 0 ? clamp(pet.modeTime / pet.modeDuration, 0, 1) : 0;

  let eyeSquint = blinking(t) ? 0.25 : 1;
  let eyeLookScale = 1;

  const each = (fn: (pp: PartPose, part: Skin['parts'][number], i: number) => void) =>
    skin.parts.forEach((part, i) => fn(parts[i], part, i));

  // 躯干压低 crouch 格（保持底边不动）
  const crouchBy = (amount: number) => {
    torso.sy = (bodyH - amount) / bodyH;
  };

  switch (pet.mode) {
    case 'idle': {
      const breath = Math.sin(t * 2.4) > 0.55 ? 0.5 : 0;
      crouchBy(breath);
      if (pet.dizzy > 0) {
        torso.dx = Math.sin(t * 7) * 0.5;
        eyeSquint = 0.5;
      }
      break;
    }
    case 'walk': {
      const speed = pet.side === 'floor' ? pet.tuning.walkSpeed : pet.tuning.climbSpeed;
      const phase = (t * speed) / (3 * pet.tuning.petScale);
      const bob = Math.sin(phase * Math.PI * 4) > 0 ? 0.5 : 0;
      torso.dy = -bob;
      each((pp, part) => {
        if (part.role === 'leg') {
          const lift = Math.max(0, Math.sin(phase * Math.PI * 2 + (part.order % 2) * Math.PI));
          pp.dy = -lift;
        } else if (part.role === 'arm') {
          pp.dy = Math.sin(phase * Math.PI * 2 + part.side) * 0.5;
        }
      });
      break;
    }
    case 'held': {
      each((pp, part, i) => {
        if (part.role === 'leg') {
          pp.dy = 0.5 + Math.sin(t * 14 + i) * 0.5;
          pp.dx = Math.sin(t * 11 + i * 1.3) * 0.5;
        } else if (part.role === 'arm') {
          pp.dy = -1.5;
          pp.dx = part.side * 0.5 + Math.sin(t * 13 + part.side) * 0.5;
        }
      });
      if (pet.dizzy > 1) eyeSquint = 0.5;
      else if (eyeSquint === 1) eyeSquint = 1.25;
      break;
    }
    case 'air': {
      const sp = Math.hypot(pet.vel.x, pet.vel.y);
      each((pp, part, i) => {
        if (part.role === 'leg') {
          pp.dy = Math.sin(t * 18 + i * 1.7) * 0.5;
          pp.dx = Math.sin(t * 15 + i) * 0.5;
        } else if (part.role === 'arm') {
          pp.dy = -1.5 + Math.sin(t * 20 + part.side) * 0.5;
        }
      });
      if (sp > 2500) eyeSquint = 0.5;
      break;
    }
    case 'roll': {
      each((pp, part) => {
        if (part.role === 'leg') pp.dy = -2;
        else if (part.role === 'arm') pp.dx = -part.side * 1.5;
      });
      eyeSquint = 0.5;
      eyeLookScale = 0;
      break;
    }
    case 'land': {
      if (p < 0.5) {
        each((pp, part) => {
          if (part.role === 'leg') pp.dy = -0.5;
        });
      }
      break;
    }
    case 'hero':
    case 'cling': {
      // 超级英雄/蜘蛛侠落地：蹲低、腿岔开、手撑地，最后 30% 慢慢站起来
      const crouch = 1 - smoothstep((p - 0.7) / 0.3);
      crouchBy(1.5 * crouch);
      each((pp, part) => {
        if (part.role === 'leg') {
          pp.dx = part.side * crouch;
        } else if (part.role === 'arm') {
          pp.dx = part.side * crouch;
          pp.dy = 2.5 * crouch;
        }
      });
      eyeSquint = blinking(t) ? 0.25 : 0.5 + 0.5 * (1 - crouch);
      break;
    }
    case 'splat': {
      const flat = 1 - smoothstep((p - 0.75) / 0.25);
      crouchBy(bodyH * 0.45 * flat);
      torso.sx = 1 + 0.15 * flat;
      each((pp, part) => {
        if (part.role === 'leg') {
          pp.dx = part.side * 1.5 * flat;
          pp.dy = -0.5 * flat;
        } else if (part.role === 'arm') {
          pp.dx = part.side * 1.5 * flat;
          pp.dy = 2.5 * flat;
        }
      });
      eyeSquint = 0.4;
      break;
    }
  }

  // "当当~" pose：翻滚收尾落地后举手
  if (pet.taDa > 0 && (pet.mode === 'land' || pet.mode === 'idle')) {
    each((pp, part) => {
      if (part.role === 'arm') {
        pp.dy = -2.5;
        pp.dx = part.side * 0.5;
      }
    });
  }

  each((pp, part) => {
    if (part.role !== 'eye') return;
    pp.dx += look.x * eyeLookScale;
    pp.dy += look.y * 0.6 * eyeLookScale;
    pp.sy *= eyeSquint;
  });

  return { torso, parts };
}

/**
 * 宠物本地坐标（格子单位，原点在网格中心）→ 世界坐标（CSS px）。
 * unit 由渲染器给出（取整到整数设备像素后的实际格子大小）。
 */
export function bodyTransform(pet: Pet, unit: number): Affine {
  const T = pet.tuning;
  const cx = pet.pos.x + pet.visOffset.x;
  const cy = pet.pos.y + pet.visOffset.y;
  const rot = pet.rot + pet.visRot;
  let m = mul(translate(cx, cy), mul(rotate(rot), scale(unit)));

  let deform: Affine | null = null;
  let px = cx;
  let py = cy;

  if (pet.mode === 'air') {
    const sp = Math.hypot(pet.vel.x, pet.vel.y);
    const k = 1 + Math.min(T.maxStretch, sp * T.stretchPerSpeed);
    if (k > 1.001) deform = squashAlong(Math.atan2(pet.vel.y, pet.vel.x), k);
  } else if (pet.mode === 'held') {
    const pivot = pet.holdPivot;
    if (pivot) {
      px = pivot.x;
      py = pivot.y;
    }
    if (T.holdStretch > 0) deform = squashAlong(rot + Math.PI / 2, 1 + T.holdStretch);
  } else if (pet.grounded) {
    // 贴着面时以接触点为锚，压扁时脚不离地
    const n = NORMAL[pet.side];
    const r = pet.mode === 'roll' ? pet.rollRadius : pet.halfH;
    px = cx - n.x * r;
    py = cy - n.y * r;
  }
  // 站在移动窗口上的惯性后仰，同样绕脚底转
  if (Math.abs(pet.lean) > 1e-3) deform = deform ? mul(deform, rotate(pet.lean)) : rotate(pet.lean);

  const s = clamp(pet.squash, -T.maxSquash, T.maxSquash);
  if (Math.abs(s) > 1e-3) {
    const sq = squashAlong(pet.squashAngle, 1 - s);
    deform = deform ? mul(sq, deform) : sq;
  }
  if (deform) m = mul(translate(px, py), mul(deform, mul(translate(-px, -py), m)));
  return m;
}

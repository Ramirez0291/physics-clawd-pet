import { describe, expect, it } from 'vitest';
import { DEFAULT_TUNING } from '../src/engine/params';
import { Pet, UPRIGHT, type Side } from '../src/engine/pet';
import { bodyTransform } from '../src/engine/pose';
import { motionFrameIndex, motionMirrored } from '../src/render/motions';
import { findSkin } from '../src/skin/registry';

const skin = findSkin('miss-claude');
const walk = skin.motions!.walk!;
const sides: Side[] = ['floor', 'left', 'right', 'ceiling'];
function make() {
  const pet = new Pet({ ...DEFAULT_TUNING, walkSpeed: 40, climbSpeed: 50, activityChance: 0 }, skin.grid,
    [{ left: -1000, top: 0, right: 0, bottom: 700 }, { left: 0, top: 0, right: 1000, bottom: 700 }], () => 0.5);
  pet.setGrid(skin.grid, { pixelArt: skin.pixelArt, actions: skin.actions });
  pet.placeOnFloor(500);
  return pet;
}

describe('拟人贴图沿面朝向', () => {
  for (const side of sides) for (const dir of [-1, 1] as const) {
    it(`${side} / ${dir}：画面面向与真实移动方向一致`, () => {
      const pet = make();
      pet.mode = 'walk'; pet.modeDuration = 100; pet.side = side; pet.dir = dir;
      pet.surfaceStay = 100; pet.rot = UPRIGHT[side]; pet.visRot = 0;
      pet.pos = side === 'right' ? { x: 1000 - pet.halfH, y: 350 }
        : side === 'left' ? { x: -1000 + pet.halfH, y: 350 }
        : { x: 500, y: side === 'floor' ? 700 - pet.halfH : pet.halfH };
      const before = { ...pet.pos };
      pet.step(1 / 120, null);
      expect(pet.mode).toBe('walk');
      const dx = pet.pos.x - before.x, dy = pet.pos.y - before.y;
      expect(Math.hypot(dx, dy)).toBeGreaterThan(0);
      const m = bodyTransform(pet, 1, skin.category);
      const facing = (walk.facing ?? 1) * (motionMirrored(walk, side, dir) ? -1 : 1);
      // 屏幕上鼻子朝向的矢量与实际位移必须同向，包括右墙向上/向下、倒挂的天花板。
      expect((m.a * facing) * dx + (m.b * facing) * dy).toBeGreaterThan(0);
    });
  }

  it('从左屏走到右屏时不会额外翻转贴图', () => {
    const pet = make(); pet.placeOnFloor(-10); pet.mode = 'walk'; pet.modeDuration = 100; pet.dir = 1;
    for (let i = 0; i < 120; i++) {
      pet.step(1 / 120, null);
      expect(pet.side).toBe('floor');
      expect(motionMirrored(walk, pet.side, pet.dir)).toBe(false);
    }
    expect(pet.pos.x).toBeGreaterThan(0);
    expect(pet.screen.left).toBe(0);
  });

  it('朝左绘制的原始爬墙素材也能正确适配右墙', () => {
    const cling = skin.motions!.cling!;
    const localFacing = (cling.facing ?? 1) * (motionMirrored(cling, 'right', 1) ? -1 : 1);
    expect(Math.sin(UPRIGHT.right) * localFacing).toBeGreaterThan(0);
  });
});

describe('伸懒腰动作序列', () => {
  it('起手、抬手、伸展、收手只播放一次，末尾不会重新跳回起手', () => {
    const pet = make(); pet.cue('stretch');
    const motion = skin.motions!.stretch!;
    expect(motion.frames).toHaveLength(4);
    expect(motion.src).toContain('stretch');
    const frames = [0, 0.81, 1.61, 2.41, 3.19, 8].map((t) => {
      pet.modeTime = t;
      return motionFrameIndex(motion, pet);
    });
    expect(frames).toEqual([0, 1, 2, 3, 3, 3]);
  });

  it('行走动作仍连续循环', () => {
    const pet = make(); pet.mode = 'walk'; pet.modeTime = 0.5;
    expect(motionFrameIndex(walk, pet)).toBe(0);
  });
});

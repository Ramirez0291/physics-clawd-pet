import { describe, expect, it } from 'vitest';
import { DEFAULT_TUNING } from '../src/engine/params';
import { Pet, type Side } from '../src/engine/pet';
import { computePose } from '../src/engine/pose';
import { motionForSide, motionMirrored } from '../src/render/motions';
import { findSkin } from '../src/skin/registry';

const skin = findSkin('gemini');

describe('Gemini 的动作帧', () => {
  it('地面、墙面和天花板都使用对应朝向的原画', () => {
    const sides: Side[] = ['floor', 'left', 'right', 'ceiling'];
    for (const side of sides) for (const dir of [-1, 1] as const) {
      const facesRight = (side === 'right' || side === 'ceiling' ? -dir : dir) > 0;
      for (const action of ['walk', 'cling'] as const) {
        const name = motionForSide(skin, action, side, dir);
        expect(name).toBe(facesRight ? action + 'Right' : action);
        expect(motionMirrored(skin.motions![name]!, side, dir)).toBe(false);
      }
    }
    expect(motionForSide(findSkin('miss-claude'), 'walk', 'floor', -1)).toBe('walk');
  });

  it('按光标位置和受击状态选表情，并加载跨图集的摸摸帧', () => {
    const pet = new Pet(DEFAULT_TUNING, skin.grid, { left: 0, top: 0, right: 800, bottom: 600 });
    pet.setGrid(skin.grid, { pixelArt: skin.pixelArt, actions: skin.actions, windowPlay: skin.windowPlay });
    pet.placeOnFloor(400);
    pet.cursor = { x: 260, y: pet.pos.y };
    expect(computePose(pet, skin).motion).toBe('glanceLeft');
    pet.cursor.x = 540;
    expect(computePose(pet, skin).motion).toBe('glanceRight');
    pet.dizzy = 0.5;
    expect(computePose(pet, skin).motion).toBe('wince');
    pet.dizzy = 0;
    expect(pet.perform('petted')).toBe(true);
    expect(computePose(pet, skin).motion).toBe('love');
    expect(skin.motions!.love!.frames.some(frame => frame.src?.includes('faces'))).toBe(true);
  });
});

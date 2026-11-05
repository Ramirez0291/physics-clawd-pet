import { describe, expect, it } from 'vitest';
import { DEFAULT_TUNING } from '../src/engine/params';
import { Pet } from '../src/engine/pet';
import { computePose, type Pose } from '../src/engine/pose';
import { layoutItems } from '../src/render/smooth';
import { findSkin } from '../src/skin/registry';
import { loadSkin, type SkinDef } from '../src/skin/types';

const def: SkinDef = {
  id: 'sprite-test', name: 'Sprite', render: 'sprite', grid: [4, 6],
  palette: { body: '#ffeedd' },
  parts: [{ id: 'arm', role: 'arm', rect: [1, 2, 1, 2], pivot: [1.5, 2],
    image: { src: 'character.png', crop: [0, 0, 20, 40] } }],
};

describe('原画贴图骨架', () => {
  it('部件围绕肩膀转动，不能只在原地旋转图片', () => {
    const skin = loadSkin(def);
    const pose: Pose = {
      face: 'smile', props: [], torso: { dx: 0, dy: 0, sx: 1, sy: 1, rot: 0 },
      parts: [{ dx: 0, dy: 0, sx: 1, sy: 1, rot: Math.PI / 2 }],
    };
    const [arm] = layoutItems(skin, pose);
    expect(arm.cx).toBeCloseTo(0.5);
    expect(arm.cy).toBeCloseTo(2);
    expect(arm.rot).toBeCloseTo(Math.PI / 2);
  });

  it('无效的裁片和蒙版在加载时被拒绝', () => {
    const invalid = (image: unknown) => loadSkin({ ...def, parts: [{ ...def.parts[0], image: image as never }] });
    expect(() => invalid({ src: 'a.png', crop: [0, 0, 0, 3] })).toThrow(/裁剪/);
    expect(() => invalid({ src: 'a.png', crop: [0, 0, 2, 3], polygon: [[0, 0], [1, 1]] })).toThrow(/轮廓/);
    expect(() => invalid({ src: 'a.png', crop: [0, 0, 2, 3], cutoutImages: [{ crop: [0, 0, -2, 3] }] })).toThrow(/裁剪/);
  });

  it('miss.claude 能切换、坐下来敲电脑并绕肩举手，沿用全部物理状态', () => {
    const skin = findSkin('miss-claude');
    expect(skin.id).toBe('miss-claude');
    expect(skin.name).toBe('miss.claude');
    const pet = new Pet({ ...DEFAULT_TUNING }, [16, 10], { left: 0, top: 0, right: 1600, bottom: 900 }, () => 0.5);
    pet.placeOnFloor(800);
    pet.setGrid(skin.grid, { pixelArt: skin.pixelArt, actions: skin.actions });
    expect(pet.pos.y + pet.halfH).toBeCloseTo(900);
    expect(pet.perform('laptop')).toBe(true);
    for (let i = 0; i < 120; i++) pet.step(1 / 120, null);
    const pose = computePose(pet, skin);
    expect(pose.torso.dy).toBeGreaterThan(0);
    const arms = layoutItems(skin, pose).filter((p) => p.part?.role === 'arm');
    expect(arms).toHaveLength(2);
    expect(arms.every((p) => Math.abs(p.rot) > 0.1)).toBe(true);
    pet.grab(pet.pos.x, pet.pos.y);
    expect(pet.mode).toBe('held');
    expect(layoutItems(skin, computePose(pet, skin)).every((p) => [p.cx, p.cy, p.hw, p.hh, p.rot].every(Number.isFinite))).toBe(true);
  });
});

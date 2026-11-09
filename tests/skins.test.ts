import { describe, expect, it } from 'vitest';
import { DEFAULT_TUNING } from '../src/engine/params';
import { Pet } from '../src/engine/pet';
import { computePose } from '../src/engine/pose';
import { DEFAULT_SKIN, SKINS, findSkin } from '../src/skin/registry';
import { type Skin, parseHex } from '../src/skin/types';

const STEP = 1 / 120;
const W = 1600;
const H = 900;
const BLUSH = parseHex('#ff9d8f');

function makePet(skin: Skin, seed = 3) {
  const rng = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
  const pet = new Pet(DEFAULT_TUNING, skin.grid, { left: 0, top: 0, right: W, bottom: H }, rng);
  pet.setGrid(skin.grid, { pixelArt: skin.pixelArt, actions: skin.actions });
  pet.placeOnFloor(W / 2);
  return pet;
}

const run = (pet: Pet, seconds: number) => {
  for (let i = 0; i < seconds / STEP; i++) pet.step(STEP, null);
};

describe('皮肤注册表', () => {
  it('收进了 Clawd 和四款 Dots，默认皮肤排第一', () => {
    expect(SKINS.map((s) => s.id)).toEqual(expect.arrayContaining(['clawd', 'dots', 'dots-green', 'dots-yellow', 'dots-pink']));
    expect(SKINS[0].id).toBe(DEFAULT_SKIN);
  });

  it('Clawd 是像素风；Dots 是平滑画风、毛茸茸，大小不量化', () => {
    expect(findSkin('clawd').pixelArt).toBe(true);
    const dots = findSkin('dots');
    expect(dots.pixelArt).toBe(false);
    expect(dots.parts.some((p) => p.fur)).toBe(true);
    // 像素风 petScale 5 会画成 6px/格；平滑画风就是 5
    const pet = makePet(dots);
    pet.setTuning({ ...pet.tuning, petScale: 5 });
    expect(pet.cell).toBe(5);
    expect(pet.pos.y + pet.halfH).toBeCloseTo(H);
  });

  it('每个形象只做自己会的小动作', () => {
    const clawd = makePet(findSkin('clawd'));
    expect(clawd.perform('shake')).toBe(false);
    const dots = makePet(findSkin('dots'));
    expect(dots.perform('stocks')).toBe(false);
    expect(dots.perform('shake')).toBe(true);
    expect(dots.mode).toBe('shake');
  });

  it('Dots 随机挑小动作时不会去炒股，但会抖毛', () => {
    const seen = new Set<string>();
    for (let seed = 1; seed < 80; seed++) {
      const pet = makePet(findSkin('dots'), seed);
      pet.tuning = { ...pet.tuning, activityChance: 1, idleMin: 0.1, idleMax: 0.2 };
      for (let i = 0; i < 2 / STEP && pet.mode !== 'laptop' && pet.mode !== 'coin' && pet.mode !== 'shake'; i++) {
        pet.step(STEP, null);
        if (pet.mode === 'stocks') seen.add('stocks');
      }
      seen.add(pet.mode);
    }
    expect(seen.has('stocks')).toBe(false);
    expect(seen.has('shake')).toBe(true);
  });

  it('抖毛会甩出毛团，抖完回到发呆', () => {
    const pet = makePet(findSkin('dots'));
    pet.perform('shake');
    let fluffs = 0;
    for (let i = 0; i < 2 / STEP && pet.mode === 'shake'; i++) {
      pet.step(STEP, null);
      fluffs += pet.consumeEvents().filter((e) => e.type === 'fluff').length;
    }
    expect(fluffs).toBe(4);
    expect(pet.mode).toBe('idle');
  });

  it('换成不会当前动作的形象时，动作停下', () => {
    const pet = makePet(findSkin('clawd'));
    expect(pet.perform('stocks')).toBe(true);
    const dots = findSkin('dots');
    pet.setGrid(dots.grid, { pixelArt: dots.pixelArt, actions: dots.actions });
    expect(pet.mode).toBe('idle');
  });

  it('找不到的皮肤退回默认', () => {
    expect(findSkin('no-such-skin').id).toBe(DEFAULT_SKIN);
    expect(findSkin(undefined).id).toBe(DEFAULT_SKIN);
    expect(findSkin('dots').id).toBe('dots');
  });

  it('粉色 Dots 保持闭眼曲线，呼吸继续；睁眼角色仍跟着光标看和眨眼', () => {
    const snapshots = (skin: Skin) => {
      const pet = makePet(skin);
      pet.t = 0;
      pet.cursor = { x: pet.pos.x - 300, y: pet.pos.y };
      const first = computePose(pet, skin);
      pet.t = 1.2;
      pet.cursor = { x: pet.pos.x + 300, y: pet.pos.y };
      const second = computePose(pet, skin);
      const eyes = (pose: ReturnType<typeof computePose>) =>
        skin.parts.flatMap((part, i) => part.role === 'eye' ? [pose.parts[i]] : []);
      return { first, second, eyes };
    };
    const pink = snapshots(findSkin('dots-pink'));
    expect(pink.eyes(pink.first)).toEqual(pink.eyes(pink.second));
    expect(pink.first.torso).not.toEqual(pink.second.torso);
    const green = snapshots(findSkin('dots-green'));
    expect(green.eyes(green.first)).not.toEqual(green.eyes(green.second));
  });
});

describe.each(SKINS.map((s) => [s.id, s] as const))('皮肤 %s', (_id, skin) => {
  it('部件都在网格里，有身体和腿', () => {
    const [gw, gh] = skin.grid;
    // 会晃的装饰（比如 Clawd? 的尾巴）可以伸出碰撞盒，别的部件都要在网格里
    for (const p of skin.parts.filter((q) => !q.sway)) {
      const [x, y, w, h] = p.rect;
      expect(x >= 0 && y >= 0 && x + w <= gw && y + h <= gh, p.id).toBe(true);
    }
    expect(skin.parts.some((p) => p.role === 'body')).toBe(true);
    // 碰撞盒底边就是脚：至少有一个部件贴着网格底边
    expect(skin.parts.some((p) => Math.abs(p.rect[1] + p.rect[3] - gh) < 1e-9)).toBe(true);
  });

  it('站在地上时脚贴着地面', () => {
    const pet = makePet(skin);
    expect(pet.pos.y + pet.halfH).toBeCloseTo(H);
    expect(pet.halfH).toBeCloseTo((skin.grid[1] * pet.cell) / 2);
  });

  it('换皮肤后碰撞盒跟着变，脚还贴着地面', () => {
    const pet = makePet(findSkin(DEFAULT_SKIN));
    pet.setGrid(skin.grid);
    expect(pet.pos.y + pet.halfH).toBeCloseTo(H);
  });

  it('电脑使用原画姿势或贴地的程序化道具', () => {
    if (!skin.actions.includes('laptop')) return;
    const pet = makePet(skin);
    expect(pet.perform('laptop')).toBe(true);
    run(pet, 1);
    const { motion, props } = computePose(pet, skin);
    if (skin.motions?.laptop) {
      expect(motion).toBe('laptop');
      expect(props).toHaveLength(0);
      return;
    }
    expect(props.length).toBeGreaterThan(0);
    const bottom = Math.max(...props.map((p) => p.y + p.h));
    expect(bottom).toBeCloseTo(skin.grid[1]);
  });

  it('腮红在各自的眼睛下面，也支持高低不对称的眼睛', () => {
    if (!skin.eyeBox) return;
    const pet = makePet(skin);
    pet.perform('petted');
    run(pet, 0.2);
    const pose = computePose(pet, skin);
    if (skin.motions?.love) {
      expect(pose.motion).toBe('love');
      expect(pose.props.filter((p) => p.rgba === BLUSH)).toHaveLength(0);
      return;
    }
    const blush = pose.props.filter((p) => p.rgba === BLUSH);
    expect(blush.length).toBe(2);
    const eyes = skin.parts.filter((part) => part.role === 'eye');
    for (const [i, b] of blush.entries()) {
      const eyeBottom = eyes[i].rect[1] + eyes[i].rect[3];
      expect(b.y).toBeGreaterThanOrEqual(eyeBottom);
      expect(b.y).toBeLessThan(eyeBottom + 1);
    }
    const faceCenter = skin.eyeBox.x + skin.eyeBox.w / 2;
    for (const [i, b] of blush.entries()) {
      const eyeCenter = eyes[i].rect[0] + eyes[i].rect[2] / 2;
      expect(Math.sign(b.x + b.w / 2 - eyeCenter)).toBe(Math.sign(eyeCenter - faceCenter));
    }
  });
});

import { describe, expect, it } from 'vitest';
import { DEFAULT_TUNING } from '../src/engine/params';
import { Pet } from '../src/engine/pet';
import { computePose } from '../src/engine/pose';
import { findSkin } from '../src/skin/registry';
import { EXPRESSIONS, type Skin, type SkinDef, loadSkin } from '../src/skin/types';

const STEP = 1 / 120;
const W = 1600;
const H = 900;

function makePet(skin: Skin) {
  let seed = 7;
  const rng = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
  const pet = new Pet(DEFAULT_TUNING, skin.grid, { left: 0, top: 0, right: W, bottom: H }, rng);
  pet.setGrid(skin.grid, { pixelArt: skin.pixelArt, actions: skin.actions });
  pet.placeOnFloor(W / 2);
  return pet;
}

const tiny = (part: Partial<SkinDef['parts'][number]>): SkinDef => ({
  id: 't',
  name: 't',
  grid: [2, 2],
  palette: { a: '#ff0000', b: '#0000ff' },
  legend: { A: 'a', B: 'b' },
  parts: [{ id: 'p', role: 'body', rect: [0, 0, 1, 1], ...part }],
});

describe('像素图部件', () => {
  it('按 legend 解析像素图，透明的地方是 0', () => {
    const skin = loadSkin(tiny({ pixels: ['AAB', 'A.B', 'BBB'] }));
    const bm = skin.parts[0].bitmap!;
    expect([bm.w, bm.h]).toEqual([3, 3]);
    expect(bm.data[4]).toBe(0);
    expect(bm.data[0]).not.toBe(0);
    // 用得最多的颜色当部件的代表色
    expect(skin.parts[0].hex).toBe('#0000ff');
  });

  it('尺寸不是 rect 的 3 倍、或者用了没定义的字符，就报错', () => {
    expect(() => loadSkin(tiny({ pixels: ['AA', 'AA'] }))).toThrow(/3×3/);
    expect(() => loadSkin(tiny({ pixels: ['AAA', 'AZA', 'AAA'] }))).toThrow(/"Z"/);
    expect(() => loadSkin(tiny({ color: 'a', closed: ['AAA', 'AAA', 'AAA'] }))).toThrow(/closed/);
    expect(() => loadSkin({ ...tiny({ pixels: ['AAA', 'AAA', 'AAA'] }), render: 'sprite' })).toThrow(/像素画风/);
    expect(() => loadSkin(tiny({ color: 'a', sway: { amp: 5 } }))).toThrow(/pivot/);
  });
});

describe('DeepSeek 娘：拟人骨骼', () => {
  const skin = findSkin('deepseek');
  const idx = (id: string) => skin.parts.findIndex((p) => p.id === id);

  it('是像素风，比 Clawd 高，手臂有肩关节、眼睛有闭眼图', () => {
    expect(skin.id).toBe('deepseek');
    expect(skin.pixelArt).toBe(true);
    expect(skin.grid[1]).toBeGreaterThan(skin.grid[0]);
    const arms = skin.parts.filter((p) => p.role === 'arm');
    expect(arms.map((a) => a.side).sort()).toEqual([-1, 1]);
    expect(arms.every((a) => a.pivot)).toBe(true);
    expect(skin.parts.filter((p) => p.role === 'eye').every((e) => e.bitmap?.closed)).toBe(true);
    // 脚贴着网格底边
    const feet = Math.max(...skin.parts.filter((p) => p.role === 'leg').map((p) => p.rect[1] + p.rect[3]));
    expect(feet).toBeCloseTo(skin.grid[1]);
  });

  it('伸懒腰时双手绕肩举过头顶，不再平移', () => {
    const pet = makePet(skin);
    pet.cue('stretch');
    for (let i = 0; i < 1.2 / STEP; i++) pet.step(STEP, null);
    expect(pet.mode).toBe('stretch');
    const pose = computePose(pet, skin);
    for (const id of ['armL', 'armR']) {
      const pp = pose.parts[idx(id)];
      expect(Math.abs(pp.rot)).toBeGreaterThan(2);
      expect([pp.dx, pp.dy]).toEqual([0, 0]);
    }
    // 左手逆着、右手顺着往外转
    expect(Math.sign(pose.parts[idx('armL')].rot)).toBe(-Math.sign(pose.parts[idx('armR')].rot));
  });

  it('发呆时手臂垂着，尾巴和呆毛自己晃', () => {
    const pet = makePet(skin);
    const seen = new Set<number>();
    for (let i = 0; i < 2 / STEP; i++) {
      pet.step(STEP, null);
      if (pet.mode !== 'idle') continue;
      const pose = computePose(pet, skin);
      expect(pose.parts[idx('armL')].rot).toBeCloseTo(0);
      seen.add(Math.round(pose.parts[idx('tail')].rot * 100));
      expect(Math.abs(pose.parts[idx('ahoge')].rot)).toBeLessThanOrEqual((12 * Math.PI) / 180 + 1e-9);
    }
    expect(seen.size).toBeGreaterThan(5);
  });

  it('敲电脑时坐下来，电脑放在腿上，两只手往里伸', () => {
    expect(skin.laptop).toBe('lap');
    expect(skin.parts[idx('tail')].anchored).toBe(true);
    const pet = makePet(skin);
    expect(pet.perform('laptop')).toBe(true);
    for (let i = 0; i < 1.5 / STEP; i++) pet.step(STEP, null);
    const pose = computePose(pet, skin);
    // 往下挪，不压扁
    expect(pose.torso.dy).toBeGreaterThan(0.5);
    expect(pose.torso.sy).toBe(1);
    // 两只手都往身体中间转（左手顺时针为负）
    expect(pose.parts[idx('armL')].rot).toBeLessThan(0);
    expect(pose.parts[idx('armR')].rot).toBeGreaterThan(0);
    // 电脑在两肩正中，贴着地面
    const arms = skin.parts.filter((p) => p.role === 'arm');
    const cx = (arms[0].pivot![0] + arms[1].pivot![0]) / 2;
    const xs = pose.props.map((p) => p.x + p.w / 2);
    expect(Math.abs(xs.reduce((a, b) => a + b, 0) / xs.length - cx)).toBeLessThan(1);
    expect(Math.max(...pose.props.map((p) => p.y + p.h))).toBeCloseTo(skin.grid[1]);
    expect(() => loadSkin({ ...tiny({ color: 'a' }), laptop: 'desk' as 'lap' })).toThrow(/电脑/);
  });

  it('表情跟着状态变，眼睛和嘴都画了表情图', () => {
    const mouth = skin.parts[idx('mouth')];
    for (const e of EXPRESSIONS.filter((x) => x !== 'smile')) expect(mouth.bitmap?.faces?.[e]).toBeDefined();
    for (const id of ['eyeL', 'eyeR']) {
      for (const e of ['happy', 'surprised', 'wince', 'cry', 'smug', 'yawn'] as const) {
        expect(skin.parts[idx(id)].bitmap?.faces?.[e]).toBeDefined();
      }
    }
    const faceIn = (setup: (p: Pet) => void) => {
      const pet = makePet(skin);
      setup(pet);
      return computePose(pet, skin).face;
    };
    expect(faceIn(() => {})).toBe('smile');
    expect(faceIn((p) => Object.assign(p, { mode: 'splat', modeTime: 0.1, modeDuration: 1 }))).toBe('wince');
    expect(faceIn((p) => Object.assign(p, { mode: 'held', modeTime: 0, modeDuration: 5 }))).toBe('surprised');
    expect(faceIn((p) => Object.assign(p, { mode: 'hero', modeTime: 0.1, modeDuration: 1 }))).toBe('smug');
    expect(
      faceIn((p) => {
        p.perform('petted');
        p.step(STEP, null);
      }),
    ).toBe('happy');
    expect(
      faceIn((p) => {
        p.perform('stocks');
        for (let i = 0; i < 1 / STEP; i++) p.step(STEP, null);
        p.stockMood = -1;
      }),
    ).toBe('cry');
    expect(() => loadSkin(tiny({ pixels: ['AAA', 'AAA', 'AAA'], faces: { angry: ['AAA', 'AAA', 'AAA'] } as never }))).toThrow(/表情/);
  });

  it('Clawd 没有关节，什么都不转', () => {
    const clawd = findSkin('clawd');
    const pet = makePet(clawd);
    pet.cue('stretch');
    for (let i = 0; i < 1.2 / STEP; i++) pet.step(STEP, null);
    expect(computePose(pet, clawd).parts.every((p) => p.rot === 0)).toBe(true);
  });
});

describe('Clawd 的表情和 Clawd? 的尾巴', () => {
  it('Clawd 被电、被摸时换成 > < 和 ^ ^ 的眼睛', () => {
    const clawd = findSkin('clawd');
    for (const p of clawd.parts.filter((q) => q.role === 'eye')) {
      for (const e of ['happy', 'wince', 'cry', 'smug', 'yawn'] as const) expect(p.bitmap?.faces?.[e]).toBeDefined();
    }
    const pet = makePet(clawd);
    pet.cue('zap');
    pet.step(STEP, null);
    expect(['wince', 'surprised']).toContain(computePose(pet, clawd).face);
  });

  it('Clawd? 的身体和 Clawd 一样大，尾巴伸出碰撞盒，AI 思考时甩得更快', () => {
    const clawd = findSkin('clawd');
    const fake = findSkin('clawd-dsh');
    expect(fake.grid).toEqual(clawd.grid);
    expect(fake.bodyBox).toEqual(clawd.bodyBox);
    const tail = fake.parts.findIndex((p) => p.id === 'tail');
    expect(fake.parts[tail].rect[1]).toBeLessThan(0);
    // 同样一段时间里，思考时尾巴转过的角度变化更大
    const swing = (thinking: boolean) => {
      const pet = makePet(fake);
      pet.agentMood = thinking ? 'thinking' : 'idle';
      let total = 0;
      let prev = computePose(pet, fake).parts[tail].rot;
      for (let i = 0; i < 60; i++) {
        pet.t += 1 / 60;
        const rot = computePose(pet, fake).parts[tail].rot;
        total += Math.abs(rot - prev);
        prev = rot;
      }
      return total;
    };
    expect(swing(true)).toBeGreaterThan(swing(false) * 2);
  });
});

import { describe, expect, it } from 'vitest';
import { DEFAULT_TUNING, type Tuning } from '../src/engine/params';
import { Pet, type PetEvent, type Platform } from '../src/engine/pet';

const STEP = 1 / 120;
const W = 1600;
const H = 900;

function makePet(over: Partial<Tuning> = {}) {
  let seed = 11;
  const rng = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
  // 默认关掉自主行为，只看物理
  const quiet: Partial<Tuning> = { walkSpeed: 0, platformJumpChance: 0, stepOffChance: 0, idleMin: 100, idleMax: 100 };
  return new Pet({ ...DEFAULT_TUNING, ...quiet, ...over }, [16, 10], { left: 0, top: 0, right: W, bottom: H }, rng);
}

function run(pet: Pet, seconds: number, until?: (p: Pet) => boolean, perStep?: () => void): PetEvent[] {
  const events: PetEvent[] = [];
  for (let i = 0; i < seconds / STEP; i++) {
    perStep?.();
    pet.step(STEP, null);
    events.push(...pet.consumeEvents());
    if (until?.(pet)) break;
  }
  return events;
}

const platform = (over: Partial<Platform> = {}): Platform => ({ id: 1, x0: 400, x1: 1000, y: 500, ...over });

/** 把宠物放到平台上站稳 */
function standOn(pet: Pet, p: Platform) {
  pet.setPlatforms([{ ...p }]);
  pet.dropFrom((p.x0 + p.x1) / 2, p.y - 80);
  run(pet, 2, (q) => q.mode !== 'air');
  run(pet, 0.5);
  expect(pet.support?.id).toBe(p.id);
  // 原生侧开始追踪时会先发一次窗口当前位置
  pet.updateCarrier(p.id, p.x0, p.y, 0, 0);
}

describe('窗口顶边是单向平台', () => {
  it('从上面掉下来会站在窗口顶上', () => {
    const pet = makePet();
    const p = platform();
    standOn(pet, p);
    expect(pet.pos.y).toBeCloseTo(p.y - pet.halfH);
  });

  it('从下面往上跳会穿过去，落回来时站在上面', () => {
    const pet = makePet();
    pet.setPlatforms([platform()]);
    pet.launch({ x: 700, y: 700, vx: 0, vy: -1800, rot: 0, angVel: 0 });
    const events = run(pet, 3, (q) => q.mode !== 'air' && q.mode !== 'land');
    const first = events.find((e) => e.type === 'impact');
    expect(first && first.type === 'impact' && first.y).toBe(500);
    expect(pet.support?.id).toBe(1);
  });

  it('走到窗口边缘可能跳下去，落到屏幕底部', () => {
    const pet = makePet({ walkSpeed: 200, stepOffChance: 1 });
    standOn(pet, platform());
    pet.mode = 'walk';
    pet.modeDuration = 100;
    pet.dir = 1;
    run(pet, 6, (q) => q.support === null && q.grounded);
    expect(pet.support).toBeNull();
    expect(pet.pos.y).toBeCloseTo(H - pet.halfH);
  });

  it('在窗口顶上翻滚会滚出边缘掉下去', () => {
    const pet = makePet();
    pet.setPlatforms([platform({ x0: 400, x1: 800 })]);
    pet.launch({ x: 450, y: 440, vx: 2000, vy: 200, rot: 0, angVel: 0 });
    run(pet, 1, (q) => q.mode === 'roll');
    expect(pet.support?.id).toBe(1);
    run(pet, 1, (q) => q.mode === 'air');
    expect(pet.mode).toBe('air');
    expect(pet.vel.x).toBeGreaterThan(0);
  });
});

describe('站在被拖动的窗口上', () => {
  it('窗口平稳加速时会被带着走，不会被甩飞', () => {
    const pet = makePet();
    standOn(pet, platform());
    const offset = pet.pos.x - 400;
    let left = 400;
    let v = 0;
    const events = run(pet, 0.5, undefined, () => {
      v = Math.min(1200, v + 5000 * STEP);
      left += v * STEP;
      pet.updateCarrier(1, left, 500, v, 0);
    });
    expect(events.some((e) => e.type === 'fling')).toBe(false);
    expect(pet.support?.id).toBe(1);
    // 起步时会往后滑一点点，但基本跟着窗口
    expect(Math.abs(pet.pos.x - left - offset)).toBeLessThan(30);
    expect(pet.lean).not.toBe(0);
  });

  it('快速拖动后急停，宠物会顺着惯性被甩飞', () => {
    const pet = makePet();
    standOn(pet, platform());
    let left = 400;
    let v = 0;
    run(pet, 0.4, undefined, () => {
      v = Math.min(1200, v + 5000 * STEP);
      left += v * STEP;
      pet.updateCarrier(1, left, 500, v, 0);
    });
    const events = run(pet, 0.2, (q) => q.mode === 'air', () => pet.updateCarrier(1, left, 500, 0, 0));
    expect(events.some((e) => e.type === 'fling')).toBe(true);
    expect(pet.mode).toBe('air');
    expect(pet.vel.x).toBeGreaterThan(1000);
    expect(pet.vel.y).toBeLessThan(0);
  });

  it('慢慢拖动再停下不会被甩飞', () => {
    const pet = makePet();
    standOn(pet, platform());
    let left = 400;
    const events = run(pet, 1, undefined, () => {
      const v = pet.t < 1.6 ? 300 : 0;
      left += v * STEP;
      pet.updateCarrier(1, left, 500, v, 0);
    });
    expect(events.some((e) => e.type === 'fling')).toBe(false);
    expect(pet.support?.id).toBe(1);
  });

  it('窗口被猛地抽走时宠物留在原地掉下去（抽桌布）', () => {
    const pet = makePet();
    standOn(pet, platform());
    const x0 = pet.pos.x;
    let left = 400;
    const events = run(pet, 0.1, (q) => q.mode === 'air', () => {
      left += 4000 * STEP;
      pet.updateCarrier(1, left, 500, 4000, 0);
    });
    const fling = events.find((e) => e.type === 'fling');
    expect(fling).toBeDefined();
    expect(fling && fling.type === 'fling' && fling.vx).toBeLessThan(1000);
    expect(Math.abs(pet.pos.x - x0)).toBeLessThan(60);
  });

  it('往上提再急停会被抛起来', () => {
    const pet = makePet();
    standOn(pet, platform({ y: 700 }));
    let top = 700;
    run(pet, 0.3, undefined, () => {
      top -= 900 * STEP;
      pet.updateCarrier(1, 400, top, 0, -900);
    });
    expect(pet.support?.id).toBe(1);
    expect(pet.pos.y).toBeCloseTo(top - pet.halfH, 0);
    run(pet, 0.1, (q) => q.mode === 'air', () => pet.updateCarrier(1, 400, top, 0, 0));
    expect(pet.mode).toBe('air');
    expect(pet.vel.y).toBeLessThan(-900);
  });
});

describe('脚下的窗口没了', () => {
  it('窗口关闭/最小化：掉下去', () => {
    const pet = makePet();
    standOn(pet, platform());
    pet.updateCarrier(1, 400, 500, 0, 0);
    pet.carrierGone(1);
    expect(pet.mode).toBe('air');
    expect(pet.support).toBeNull();
    expect(pet.consumeEvents().map((e) => e.type)).toContain('dropped');
  });

  it('窗口被别的窗口挡住（列表里没了这段）：掉下去', () => {
    const pet = makePet();
    standOn(pet, platform());
    pet.setPlatforms([platform({ x0: 400, x1: 450 })]);
    expect(pet.mode).toBe('air');
  });

  it('重新追踪一个没被追踪时挪过的窗口，不会把位置差当成瞬移', () => {
    const pet = makePet();
    standOn(pet, platform());
    pet.updateCarrier(1, 400, 500, 0, 0);
    // 宠物离开窗口，窗口被挪到左边 300px，宠物又落回去
    pet.launch({ x: 200, y: 300, vx: 0, vy: 0, rot: 0, angVel: 0 });
    pet.setPlatforms([platform({ x0: 100, x1: 700 })]);
    run(pet, 2, (q) => q.support !== null);
    const x = pet.pos.x;
    pet.resetCarrier();
    pet.updateCarrier(1, 100, 500, 0, 0);
    expect(pet.pos.x).toBe(x);
    expect(pet.platforms[0].x0).toBe(100);
  });

  it('列表刷新时窗口位置有小变化：跟着更新，不掉', () => {
    const pet = makePet();
    standOn(pet, platform());
    pet.setPlatforms([platform({ y: 520 })]);
    expect(pet.support?.y).toBe(520);
    expect(pet.pos.y).toBeCloseTo(520 - pet.halfH);
  });
});

describe('自己跳上窗口', () => {
  it('发呆时会跳上附近更高的窗口', () => {
    const pet = makePet({ platformJumpChance: 1, idleMin: 0.1, idleMax: 0.2 });
    pet.placeOnFloor(800);
    pet.setPlatforms([platform({ id: 2, x0: 600, x1: 1100, y: H - 250 })]);
    run(pet, 10, (q) => q.support?.id === 2 && q.grounded);
    expect(pet.support?.id).toBe(2);
  });
});

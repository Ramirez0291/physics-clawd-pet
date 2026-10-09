import { describe, expect, it } from 'vitest';
import { wrapAngle } from '../src/engine/math';
import { DEFAULT_TUNING, type Tuning } from '../src/engine/params';
import { type ImpactTier, Pet } from '../src/engine/pet';

const STEP = 1 / 120;
const W = 1600;
const H = 900;

function makePet(over: Partial<Tuning> = {}) {
  let seed = 7;
  const rng = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
  return new Pet({ ...DEFAULT_TUNING, ...over }, [16, 10], { left: 0, top: 0, right: W, bottom: H }, rng);
}

/** 跑到 until 成立或超时，返回途中所有冲击类型 */
function run(pet: Pet, seconds: number, until?: (p: Pet) => boolean): ImpactTier[] {
  const tiers: ImpactTier[] = [];
  for (let i = 0; i < seconds / STEP; i++) {
    pet.step(STEP, null);
    for (const e of pet.consumeEvents()) if (e.type === 'impact') tiers.push(e.tier);
    if (until?.(pet)) break;
  }
  return tiers;
}

const launch = (pet: Pet, x: number, y: number, vx: number, vy: number) =>
  pet.launch({ x, y, vx, vy, rot: 0, angVel: 0 });

describe('落地分级', () => {
  it('矮处掉落是普通落地', () => {
    const pet = makePet();
    pet.dropFrom(800, H - pet.halfH - 40);
    const tiers = run(pet, 2, (p) => p.mode !== 'air');
    expect(tiers).toEqual(['soft']);
    expect(pet.mode).toBe('land');
  });

  it('从屏幕顶上掉下来是超级英雄落地，有顿帧', () => {
    const pet = makePet();
    pet.dropFrom(800, 40);
    const tiers = run(pet, 3, (p) => p.mode !== 'air');
    expect(tiers).toEqual(['hero']);
    expect(pet.hitstop).toBeGreaterThan(0);
  });

  it('猛砸地面会脸着地并且晕', () => {
    const pet = makePet();
    launch(pet, 800, 400, 0, 3600);
    const tiers = run(pet, 2, (p) => p.mode !== 'air');
    expect(tiers).toEqual(['splat']);
    expect(pet.dizzy).toBeGreaterThan(1);
  });

  it('中等高度会弹一下再落地', () => {
    const pet = makePet();
    pet.dropFrom(800, H - 400);
    const tiers = run(pet, 3, (p) => p.mode === 'land');
    expect(tiers[0]).toBe('bounce');
    expect(tiers.at(-1)).toBe('soft');
  });

  it('水平速度大时成龙式翻滚，翻完弹起并且脚先着地', () => {
    const pet = makePet();
    launch(pet, 200, 700, 2600, 300);
    const tiers = run(pet, 1, (p) => p.mode !== 'air');
    expect(tiers).toEqual(['roll']);
    expect(pet.mode).toBe('roll');

    run(pet, 4, (p) => p.mode === 'land');
    expect(pet.mode).toBe('land');
    // attach 会把旋转归位，差值存在 visRot 里：差值小说明落地时已经转正了
    expect(Math.abs(pet.visRot)).toBeLessThan(0.6);
    expect(pet.taDa).toBeGreaterThan(0);
  });
});

describe('墙和天花板', () => {
  it('慢速撞墙会弹开', () => {
    const pet = makePet();
    launch(pet, 300, 400, -800, 0);
    const tiers = run(pet, 1, (p) => p.vel.x > 0);
    expect(tiers).toEqual(['wall']);
    expect(pet.mode).toBe('air');
  });

  it('高速撞墙会像蜘蛛侠一样贴住，然后开始爬', () => {
    const pet = makePet();
    launch(pet, 600, 400, -3400, -200);
    const tiers = run(pet, 1, (p) => p.mode === 'cling');
    expect(tiers).toEqual(['cling']);
    expect(pet.side).toBe('left');
    expect(pet.rot).toBeCloseTo(Math.PI / 2);
    expect(pet.pos.x).toBeCloseTo(pet.halfH);

    run(pet, 2, (p) => p.mode !== 'cling');
    expect(pet.mode).toBe('walk');
    expect(pet.side).toBe('left');
  });

  it('上抛够快会倒挂在天花板上', () => {
    const pet = makePet();
    launch(pet, 800, 700, 100, -3000);
    run(pet, 1, (p) => p.mode === 'cling');
    expect(pet.side).toBe('ceiling');
    expect(pet.rot).toBeCloseTo(Math.PI);
  });

  it('在墙上待够了会离开墙面', () => {
    const pet = makePet({ surfaceStayMin: 0.5, surfaceStayMax: 0.5 });
    launch(pet, 600, 400, -3400, -200);
    run(pet, 1, (p) => p.mode === 'cling');
    run(pet, 3, (p) => p.mode === 'air');
    expect(pet.mode).toBe('air');
    expect(pet.vel.x).toBeGreaterThan(0);
  });
});

describe('沿边框行走', () => {
  it('走到左下角会爬上左墙', () => {
    const pet = makePet({ climbChance: 1, walkSpeed: 400 });
    pet.placeOnFloor(300);
    pet.mode = 'walk';
    pet.modeDuration = 100;
    pet.dir = -1;
    run(pet, 3, (p) => p.side === 'left');
    expect(pet.side).toBe('left');
    expect(pet.rot).toBeCloseTo(Math.PI / 2);
    expect(pet.dir).toBe(-1);
  });

  it('不爬墙时在墙角掉头', () => {
    const pet = makePet({ climbChance: 0, walkSpeed: 400 });
    pet.placeOnFloor(300);
    pet.mode = 'walk';
    pet.modeDuration = 100;
    pet.dir = -1;
    run(pet, 3, (p) => p.dir === 1);
    expect(pet.side).toBe('floor');
    expect(pet.dir).toBe(1);
  });
});

describe('抓取与投掷', () => {
  it('鼠标向右加速时，身体会向后荡', () => {
    const pet = makePet();
    pet.placeOnFloor(800);
    const px = pet.pos.x;
    const py = pet.pos.y - pet.halfH + 2;
    pet.grab(px, py);
    let x = px;
    let v = 0;
    for (let i = 0; i < 12; i++) {
      v += 20000 * STEP;
      x += v * STEP;
      pet.moveHold(x, py, v, 0);
      pet.step(STEP, null);
    }
    expect(pet.pos.x).toBeLessThan(x);
  });

  it('抓着腿提起来会倒挂', () => {
    const pet = makePet();
    pet.placeOnFloor(800);
    pet.grab(pet.pos.x, pet.pos.y + pet.halfH - 2);
    run(pet, 3);
    expect(Math.cos(pet.rot)).toBeLessThan(-0.9);
  });

  it('点一下是戳，不是扔', () => {
    const pet = makePet();
    pet.placeOnFloor(800);
    pet.grab(pet.pos.x, pet.pos.y);
    pet.release(0, 0, true);
    expect(pet.mode).toBe('air');
    expect(pet.vel.y).toBeLessThan(0);
    expect(pet.consumeEvents().map((e) => e.type)).toContain('poke');
  });

  it('甩出速度有上限，并记录下来可以重放', () => {
    const pet = makePet();
    pet.placeOnFloor(800);
    pet.grab(pet.pos.x, pet.pos.y);
    pet.release(99999, 0, false);
    expect(Math.hypot(pet.vel.x, pet.vel.y)).toBeCloseTo(DEFAULT_TUNING.maxThrowSpeed, 0);
    const launched = pet.lastLaunch!;
    run(pet, 1);
    pet.launch(launched);
    expect(pet.vel.x).toBe(launched.vx);
    expect(wrapAngle(pet.rot - launched.rot)).toBe(0);
  });
});

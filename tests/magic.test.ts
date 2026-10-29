import { describe, expect, it } from 'vitest';
import { DEFAULT_TUNING } from '../src/engine/params';
import { MAGIC_FIRE, MAGIC_TIME, Pet, type PetEvent } from '../src/engine/pet';
import { computePose } from '../src/engine/pose';
import { SKINS } from '../src/skin/registry';

const STEP = 1 / 120;
const W = 1600;
const H = 900;

function makePet() {
  return new Pet({ ...DEFAULT_TUNING }, [16, 10], { left: 0, top: 0, right: W, bottom: H }, () => 0.5);
}

function run(pet: Pet, seconds: number, cursor: { x: number; y: number } | null = null): PetEvent[] {
  const events: PetEvent[] = [];
  for (let i = 0; i < seconds / STEP; i++) {
    pet.step(STEP, cursor);
    events.push(...pet.consumeEvents());
  }
  return events;
}

describe('魔法（万圣节彩蛋）', () => {
  it('没有光标：朝空地多的一边斜着往上射到屏幕边上，打中的地方冒火花，收场帽子噗地没了', () => {
    const pet = makePet();
    pet.placeOnFloor(400);
    pet.cue('magic');
    expect(pet.mode).toBe('magic');
    expect(pet.dir).toBe(1);
    expect(run(pet, MAGIC_FIRE - 0.05).some((e) => e.type === 'magic')).toBe(false);
    expect(pet.beamEnd).toBeNull();

    const firing = run(pet, 0.5);
    const end = pet.beamEnd!;
    expect(end).not.toBeNull();
    // 稍微往上斜：打在右边的墙上，比杖尖高
    expect(end.x).toBeCloseTo(W);
    expect(end.y).toBeLessThan(pet.wandTip().y);
    expect(firing.filter((e) => e.type === 'magic').length).toBeGreaterThan(5);

    const rest = run(pet, MAGIC_TIME);
    expect(pet.mode).not.toBe('magic');
    expect(pet.beamEnd).toBeNull();
    expect(rest.some((e) => e.type === 'poof')).toBe(true);
  });

  it('前摇：魔杖举过头顶、光点往杖尖聚；开火炸三下（杖尖、打中、收尾），后坐力往后推一截', () => {
    const pet = makePet();
    pet.placeOnFloor(400);
    pet.cue('magic');
    const x0 = pet.pos.x;
    const windup = run(pet, MAGIC_FIRE - 0.3);
    expect(windup.filter((e) => e.type === 'charge').length).toBeGreaterThan(10);
    // 抡到头顶上：杖尖比头还高
    expect(pet.wandTip().y).toBeLessThan(pet.pos.y - pet.halfH);
    expect(pet.pos.x).toBe(x0);

    const rest = run(pet, MAGIC_TIME);
    const booms = rest.filter((e) => e.type === 'boom');
    expect(booms.map((e) => e.type === 'boom' && e.big)).toEqual([false, true, true]);
    expect(rest.filter((e) => e.type === 'charge').length).toBeLessThan(10);
    // 朝右射，被推到左边
    expect(pet.pos.x).toBeLessThan(x0 - 40);
  });

  it('光标在前面：转过去瞄准光标，激光正好打在光标上', () => {
    const pet = makePet();
    pet.placeOnFloor(1000);
    const cursor = { x: 600, y: 500 };
    pet.step(STEP, cursor);
    pet.cue('magic');
    expect(pet.dir).toBe(-1);
    run(pet, MAGIC_FIRE + 0.4, cursor);
    const end = pet.beamEnd!;
    expect(Math.hypot(end.x - cursor.x, end.y - cursor.y)).toBeLessThan(15);
  });

  it('在墙上收到：先跳下来，站稳了再施法', () => {
    const pet = makePet();
    pet.launch({ x: 200, y: 400, vx: -3400, vy: -300, rot: 0, angVel: -4 });
    run(pet, 1.5);
    pet.cue('magic');
    let cast = false;
    for (let i = 0; i < 12 / STEP && !cast; i++) {
      pet.step(STEP, null);
      pet.consumeEvents();
      cast = pet.mode === 'magic';
    }
    expect(cast).toBe(true);
    expect(pet.side).toBe('floor');
  });

  it('每个形象都戴得上帽子、拿得起魔杖', () => {
    for (const skin of SKINS) {
      const pet = makePet();
      pet.setGrid(skin.grid, { pixelArt: skin.pixelArt, actions: skin.actions });
      pet.placeOnFloor(800);
      pet.cue('magic');
      run(pet, 0.2);
      const hat = computePose(pet, skin).props.length;
      run(pet, 1);
      const withWand = computePose(pet, skin).props.length;
      expect(hat, skin.id).toBeGreaterThan(100);
      expect(withWand, skin.id).toBeGreaterThan(hat);
    }
  });
});

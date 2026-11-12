import { describe, expect, it } from 'vitest';
import { DEFAULT_TUNING } from '../src/engine/params';
import { type Bounds, Pet } from '../src/engine/pet';
import { clipToScreens, screenAt, buildWorld } from '../src/engine/world';

const STEP = 1 / 120;
const box = (left: number, top: number, right: number, bottom: number): Bounds => ({ left, top, right, bottom });
const LAYOUTS: Bounds[][] = [
  [box(0, 0, 1000, 600)],
  [box(0, 0, 1000, 552)],
  [box(0, 0, 1000, 600), box(1000, 0, 2000, 600)],
  [box(0, 0, 1000, 600), box(1000, 0, 2000, 900)],
  [box(0, 0, 1000, 560), box(1000, 0, 2000, 600)],
  [box(0, -600, 1000, 0), box(200, 0, 1200, 600)],
  [box(0, -640, 1000, -40), box(0, 0, 1000, 600)],
  [box(-1000, 200, 0, 800), box(0, 0, 1000, 600)],
];

// 随机扔、拎、换屏幕排列、摆窗口、拖着脚下的窗口跑：宠物不能离开所有屏幕超过 2 秒，坐标不能变成 NaN
describe('不会走丢', () => {
for (let seed0 = 1; seed0 <= 12; seed0++) {
  it(`随机折腾 ${seed0}`, () => {
    let seed = seed0 * 7919;
    const rng = () => {
      seed = (seed * 16807) % 2147483647;
      return (seed - 1) / 2147483646;
    };
    const R = (a: number, b: number) => a + (b - a) * rng();
    let screens = LAYOUTS[Math.floor(rng() * LAYOUTS.length)];
    const pet = new Pet({ ...DEFAULT_TUNING, petScale: [2, 4, 6, 12][seed0 % 4] }, [16, 10], screens, () => rng());
    pet.setGrid([16, 10], { windowPlay: seed0 % 2 === 0 });
    pet.placeOnFloor(500);
    let wins: { id: number; x0: number; x1: number; y: number }[] = [];
    let outFor = 0;
    let worstOut = 0;
    for (let t = 0; t < 60 / STEP; t++) {
      const r = rng();
      if (r < 0.002) {
        pet.launch({ x: pet.pos.x, y: pet.pos.y, vx: R(-6000, 6000), vy: R(-6000, 6000), rot: R(-3, 3), angVel: R(-30, 30) });
      } else if (r < 0.0025) {
        screens = LAYOUTS[Math.floor(rng() * LAYOUTS.length)];
        pet.setWorld(buildWorld(screens));
        if (!screenAt(buildWorld(screens), pet.pos.x, pet.pos.y) && pet.mode !== 'held') pet.dropFrom(500, 100);
        pet.setPlatforms(clipToScreens(wins, screens, 40));
      } else if (r < 0.004) {
        wins = Array.from({ length: Math.floor(R(0, 5)) }, (_, i) => {
          const x0 = R(-300, 1800);
          return { id: i + 1, x0, x1: x0 + R(150, 900), y: R(-100, 900) };
        });
        pet.setPlatforms(clipToScreens(wins, screens, 40));
      } else if (r < 0.006 && pet.support) {
        // drag the carrier window somewhere
        const id = pet.support.id;
        const w = wins.find((w) => w.id === id);
        if (w) {
          const dx = R(-80, 80), dy = R(-80, 80);
          w.x0 += dx; w.x1 += dx; w.y += dy;
          pet.updateCarrier(id, w.x0, w.y, dx * 60, dy * 60);
          pet.setPlatforms(clipToScreens(wins, screens, 40));
        }
      } else if (r < 0.0065) {
        pet.grab(pet.pos.x + R(-10, 10), pet.pos.y + R(-10, 10));
        pet.moveHold(R(-200, 2200), R(-700, 1000), R(-3000, 3000), R(-3000, 3000));
      } else if (r < 0.008 && pet.mode === 'held') {
        pet.release(R(-4000, 4000), R(-4000, 4000), rng() < 0.2);
      }
      pet.step(STEP, null);
      pet.consumeEvents();
      const w = buildWorld(screens);
      const finite = Number.isFinite(pet.pos.x) && Number.isFinite(pet.pos.y);
      const inside = finite && w.screens.some((s) => pet.pos.x >= s.left - 1 && pet.pos.x <= s.right + 1 && pet.pos.y >= s.top - 1 && pet.pos.y <= s.bottom + 1);
      if (pet.mode !== 'held' && !inside) outFor++;
      else outFor = 0;
      worstOut = Math.max(worstOut, outFor);
      expect(finite).toBe(true);
    }
    expect(worstOut * STEP).toBeLessThan(2);
  });
}
});

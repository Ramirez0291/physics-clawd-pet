import { describe, expect, it } from 'vitest';
import { DEFAULT_TUNING, type Tuning } from '../src/engine/params';
import { Pet, type Platform, type PetEvent } from '../src/engine/pet';
import { computePose } from '../src/engine/pose';
import { findSkin } from '../src/skin/registry';

const skin = findSkin('miss-claude');
const STEP = 1 / 120;
const source: Platform = { id: 1, x0: 200, x1: 800, y: 700 };
const target: Platform = { id: 2, x0: 750, x1: 1300, y: 500 };
function make(over: Partial<Tuning> = {}) {
  const p = new Pet({ ...DEFAULT_TUNING, activityChance: 0, platformJumpChance: 0, idleMin: 100, idleMax: 100, ...over }, skin.grid,
    { left: 0, top: 0, right: 1600, bottom: 1000 }, () => 0.5);
  p.setGrid(skin.grid, { pixelArt: skin.pixelArt, actions: skin.actions, windowPlay: skin.windowPlay });
  p.placeOnFloor(500);
  return p;
}
function run(p: Pet, seconds: number, perStep?: () => void, until?: () => boolean): PetEvent[] {
  const events: PetEvent[] = [];
  for (let i = 0; i < seconds / STEP; i++) {
    perStep?.(); p.step(STEP, null); events.push(...p.consumeEvents());
    if (until?.()) break;
  }
  return events;
}
function stand(p: Pet, extra: Platform[] = []) {
  p.setPlatforms([{ ...source }, ...extra.map((x) => ({ ...x }))]);
  p.dropFrom(500, source.y - p.halfH - 8);
  run(p, 2);
  expect(p.support?.id).toBe(1);
  p.updateCarrier(1, source.x0, source.y, 0, 0);
  p.consumeEvents();
}

describe('真正绑定窗口的动作', () => {
  it('地板上不能凭空坐标题栏；窄窗口也不能坐', () => {
    const p = make();
    expect(p.perform('perch')).toBe(false);
    expect(p.perform('peek')).toBe(false);
    stand(p);
    p.setPlatforms([{ ...source, x0: 480, x1: 530 }]);
    expect(p.perform('perch')).toBe(false);
  });

  it('坐在标题栏晃腿，窗口关闭时立刻失去支撑并惊慌下落', () => {
    const p = make(); stand(p);
    expect(p.perform('perch')).toBe(true);
    run(p, 0.2);
    expect(p.grounded).toBe(true);
    expect(computePose(p, skin).motion).toBe('perch');
    expect(skin.motions!.perch!.anchorY).toBeLessThan(1);
    expect(p.pos.y + p.halfH).toBeCloseTo(source.y);
    p.carrierGone(1);
    expect(p.mode).toBe('air');
    expect(computePose(p, skin).motion).toBe('windowDrop');
    expect(p.consumeEvents().some((e) => e.type === 'dropped')).toBe(true);
  });

  it('探头会先真实走到边缘，再停住向下看，不会瞬移', () => {
    const p = make({ walkSpeed: 200 }); stand(p);
    const x = p.pos.x;
    expect(p.perform('peek')).toBe(true);
    expect(p.pos.x).toBe(x);
    expect(computePose(p, skin).motion).toBe('walk');
    run(p, 0.25);
    expect(p.pos.x).toBeGreaterThan(x);
    run(p, 4, undefined, () => !p.peekApproaching);
    expect(p.mode).toBe('peek');
    expect(p.support?.id).toBe(1);
    expect(computePose(p, skin).motion).toBe('peek');
    expect(p.pos.x).toBeLessThan(source.x1);
    expect(source.x1 - p.pos.x).toBeCloseTo(p.halfW * 0.8);
  });

  it('拖动窗口时保持平衡；温和急停先踉跄，再恢复原来的坐姿', () => {
    const p = make(); stand(p); p.perform('perch');
    let left = source.x0;
    run(p, 0.5, () => { left += 200 * STEP; p.updateCarrier(1, left, source.y, 200, 0); });
    expect(p.support?.id).toBe(1);
    expect(computePose(p, skin).motion).toBe('balance');
    p.updateCarrier(1, left, source.y, 0, 0);
    run(p, 0.05);
    expect(p.grounded).toBe(true);
    expect(computePose(p, skin).motion).toBe('stumble');
    run(p, 1.2);
    expect(computePose(p, skin).motion).toBe('perch');
  });

  it('猛烈急停仍按真实惯性甩飞，不能为了动画把人粘在窗口上', () => {
    const p = make(); stand(p);
    let left = source.x0, speed = 0;
    run(p, 0.4, () => { speed = Math.min(1200, speed + 5000 * STEP); left += speed * STEP; p.updateCarrier(1, left, source.y, speed, 0); });
    const events = run(p, 0.2, () => p.updateCarrier(1, left, source.y, 0, 0), () => p.mode === 'air');
    expect(events.some((e) => e.type === 'fling')).toBe(true);
    expect(p.mode).toBe('air');
    expect(p.vel.x).toBeGreaterThan(1000);
    expect(computePose(p, skin).motion).not.toBe('stumble');
  });

  it('跳窗先屈膝蓄力，之后走真实弹道并落到另一个窗口', () => {
    const p = make(); stand(p, [target]);
    expect(p.canWindowHop).toBe(true);
    expect(p.perform('hop')).toBe(true);
    expect(p.mode).toBe('hop');
    expect(computePose(p, skin).motion).toBe('hop');
    run(p, 0.2);
    expect(p.mode).toBe('hop');
    const events = run(p, 4, undefined, () => p.support?.id === 2 && p.grounded);
    expect(events.filter((e) => e.type === 'leap')).toHaveLength(1);
    expect(p.support?.id).toBe(2);
    expect(p.pos.y + p.halfH).toBeCloseTo(target.y);
    expect(computePose(p, skin).motion).toBe('windowLand');
  });

  it.each([700, 800])('能跳到高度为 %s 的平级或较低窗口', (y) => {
    const p = make(); stand(p, [{ ...target, y }]);
    expect(p.perform('hop')).toBe(true);
    run(p, 4, undefined, () => p.support?.id === 2 && p.grounded);
    expect(p.support?.id).toBe(2);
    expect(Number.isFinite(p.pos.x + p.pos.y)).toBe(true);
  });

  it('蓄力时目标关闭，取消跳跃；不能起跳去不存在的窗口', () => {
    const p = make(); stand(p, [target]); p.perform('hop');
    p.setPlatforms([{ ...source }]);
    const events = run(p, 0.6);
    expect(p.mode).toBe('idle');
    expect(p.support?.id).toBe(1);
    expect(events.some((e) => e.type === 'leap')).toBe(false);
  });

  it('目标在蓄力时移动，使用最新位置重新计算落点', () => {
    const p = make(); stand(p, [target]); p.perform('hop');
    p.setPlatforms([{ ...source }, { ...target, x0: 450, x1: 1000 }]);
    run(p, 4, undefined, () => p.support?.id === 2 && p.grounded);
    expect(p.support?.id).toBe(2);
    expect(p.pos.x).toBeGreaterThanOrEqual(450);
    expect(p.pos.x).toBeLessThanOrEqual(1000);
  });

  it('不会跳到正在输入的区域，蓄力途中出现输入框也会取消', () => {
    const p = make(); stand(p, [target]);
    const zone = { left: 950, top: 380, right: 1100, bottom: 490 };
    p.setInputZone(zone);
    expect(p.canWindowHop).toBe(false);
    expect(p.perform('hop')).toBe(false);
    p.setInputZone(null); p.perform('hop'); p.setInputZone(zone);
    expect(run(p, 0.6).some((e) => e.type === 'leap')).toBe(false);
    expect(p.mode).toBe('idle');
  });

  it('探头接近边缘途中窗口移动时先扶稳，停止后再继续靠近', () => {
    const p = make({ walkSpeed: 100 }); stand(p); p.perform('peek');
    let left = source.x0;
    run(p, 0.3, () => { left += 200 * STEP; p.updateCarrier(1, left, source.y, 200, 0); });
    expect(p.peekApproaching).toBe(true);
    expect(computePose(p, skin).motion).toBe('balance');
    p.updateCarrier(1, left, source.y, 0, 0);
    run(p, 7, undefined, () => !p.peekApproaching);
    expect(p.mode).toBe('peek');
    expect(p.support?.id).toBe(1);
    expect(computePose(p, skin).motion).toBe('peek');
  });

  it('蓄力时被抓起或换皮肤，取消已计划的跳跃', () => {
    const p = make(); stand(p, [target]); p.perform('hop');
    p.grab(p.pos.x, p.pos.y);
    expect(run(p, 1).some((e) => e.type === 'leap')).toBe(false);
    expect(p.mode).toBe('held');
    const q = make(); stand(q, [target]); q.perform('hop');
    const clawd = findSkin('clawd');
    q.setGrid(clawd.grid, { actions: clawd.actions, pixelArt: clawd.pixelArt });
    expect(run(q, 1).some((e) => e.type === 'leap')).toBe(false);
    expect(q.windowPlay).toBe(false);
  });
});

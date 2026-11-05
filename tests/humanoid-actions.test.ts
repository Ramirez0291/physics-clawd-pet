import { describe, expect, it } from 'vitest';
import { DEFAULT_TUNING } from '../src/engine/params';
import { Pet, type Activity, type Mode } from '../src/engine/pet';
import { bodyTransform, computePose } from '../src/engine/pose';
import { findSkin } from '../src/skin/registry';
import { loadSkin, type SkinDef } from '../src/skin/types';

const human = findSkin('miss-claude');
function make() {
  const p = new Pet({ ...DEFAULT_TUNING, activityChance: 0, idleMin: 100, idleMax: 100 }, human.grid,
    { left: 0, top: 0, right: 1600, bottom: 900 }, () => 0.5);
  p.setGrid(human.grid, { pixelArt: human.pixelArt, actions: human.actions });
  p.placeOnFloor(800);
  return p;
}

describe('拟人动作类别', () => {
  it('两个人形皮肤有独立类别，Clawd 和 Dots 保持宠物行为', () => {
    for (const id of ['miss-claude', 'deepseek']) expect(findSkin(id).category).toBe('humanoid');
    for (const id of ['clawd', 'dots']) expect(findSkin(id).category ?? 'creature').toBe('creature');
  });

  it.each(['read', 'write', 'think'] as Activity[])('%s 能开始、保持地面接触、结束回到待机，也能被抓取打断', (act) => {
    const p = make();
    expect(p.perform(act)).toBe(true);
    expect(p.grounded).toBe(true);
    expect(computePose(p, human).motion).toBe(act);
    p.modeDuration = 0.1;
    for (let i = 0; i < 20; i++) p.step(1 / 120, null);
    expect(p.mode).toBe('idle');
    expect(p.pos.y + p.halfH).toBeCloseTo(900);
    p.perform(act);
    p.grab(p.pos.x, p.pos.y);
    expect(p.mode).toBe('held');
  });

  it('坐姿活动不能在墙上开始，换成宠物皮肤时会退出阅读', () => {
    const p = make();
    p.side = 'left';
    expect(p.perform('read')).toBe(false);
    expect(p.perform('write')).toBe(false);
    p.side = 'floor';
    p.perform('read');
    const clawd = findSkin('clawd');
    p.setGrid(clawd.grid, { pixelArt: clawd.pixelArt, actions: clawd.actions });
    expect(p.mode).toBe('idle');
    expect(p.perform('read')).toBe(false);
  });

  it('摸摸动作，手臂保持收拢而不是快速挥舞', () => {
    const p = make();
    p.perform('petted');
    p.modeTime = 0.25;
    const first = computePose(p, human);
    p.modeTime = 0.75; p.t += 0.5;
    const second = computePose(p, human);
    expect(first.motion).toBe('love');
    for (const [i, part] of human.parts.entries()) if (part.role === 'arm') {
      expect(first.parts[i].rot).toBeCloseTo(second.parts[i].rot);
      expect(Math.abs(first.parts[i].rot)).toBeLessThan(1);
    }
    expect(first.torso.sy).toBe(1);
  });

  it.each(['held', 'air', 'roll', 'land', 'hero', 'splat', 'cling', 'stretch'] as Mode[])('%s 使用人物姿势并保持有限坐标', (mode) => {
    const p = make(); p.mode = mode; p.modeTime = 0.1; p.modeDuration = 2;
    const pose = computePose(p, human);
    expect(pose.motion).toBe(mode);
    expect(Object.values(pose.torso).every(Number.isFinite)).toBe(true);
    expect(pose.torso.sy).toBeGreaterThanOrEqual(0.9);
  });

  it('保留真实自转和投掷，同时限制人形贴图的拉伸强度', () => {
    const p = make(); p.mode = 'air'; p.vel = { x: 8000, y: 0 }; p.rot = 1.2;
    const pet = bodyTransform(p, 1, 'creature');
    const person = bodyTransform(p, 1, 'humanoid');
    const magnitude = (m: typeof pet) => Math.hypot(m.a, m.b, m.c, m.d);
    expect(magnitude(person)).toBeLessThan(magnitude(pet));
    expect(Math.abs(person.b) + Math.abs(person.c)).toBeGreaterThan(0.5);
  });

  it('裁片、动作速率和类别在载入时接受验证', () => {
    const def: SkinDef = { id: 'bad', name: 'bad', grid: [1, 1], palette: { a: '#ffffff' }, parts: [{ id: 'body', role: 'body', rect: [0, 0, 1, 1], color: 'a' }] };
    expect(() => loadSkin({ ...def, category: 'person' as never })).toThrow(/类别/);
    expect(() => loadSkin({ ...def, motions: { read: { src: 'a.png', height: 1, fps: 0, frames: [] } } })).toThrow(/动作/);
    expect(() => loadSkin({ ...def, motions: { read: { src: 'a.png', height: 1, frames: [{ crop: [0, 0, -1, 5] }] } } })).toThrow(/裁片/);
  });
});

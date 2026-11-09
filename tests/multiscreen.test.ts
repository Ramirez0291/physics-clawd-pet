import { describe, expect, it } from 'vitest';
import { DEFAULT_TUNING, type Tuning } from '../src/engine/params';
import { type Bounds, Pet } from '../src/engine/pet';
import { buildWorld, clipToScreens, screenAt } from '../src/engine/world';

const STEP = 1 / 120;

const box = (left: number, top: number, right: number, bottom: number): Bounds => ({ left, top, right, bottom });

/** 两块一样高的屏幕并排 */
const SIDE_BY_SIDE = [box(0, 0, 1000, 600), box(1000, 0, 2000, 600)];
/** 右边那块更高（顶对齐，Windows 接上新显示器时的默认排列）：左边的地面是个高台 */
const LEDGE = [box(0, 0, 1000, 600), box(1000, 0, 2000, 900)];
/** 只有左边那块有任务栏：两边地面差 40px */
const TASKBAR = [box(0, 0, 1000, 560), box(1000, 0, 2000, 600)];
/** 上下摞着，错开一点 */
const STACKED = [box(0, -600, 1000, 0), box(200, 0, 1200, 600)];
/** 上下摞着，但中间隔着上面那块的任务栏：过不去 */
const GAP = [box(0, -640, 1000, -40), box(0, 0, 1000, 600)];

function makePet(screens: Bounds[], over: Partial<Tuning> = {}, seed = 7) {
  const rng = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
  return new Pet({ ...DEFAULT_TUNING, ...over }, [16, 10], screens, rng);
}

function run(pet: Pet, seconds: number, until?: (p: Pet) => boolean) {
  for (let i = 0; i < seconds / STEP; i++) {
    pet.step(STEP, null);
    pet.consumeEvents();
    if (until?.(pet)) return true;
  }
  return false;
}

/** 让它沿当前的面一直往 dir 走 */
function walk(pet: Pet, dir: 1 | -1) {
  pet.mode = 'walk';
  pet.modeTime = 0;
  pet.modeDuration = 100;
  pet.dir = dir;
}

const feet = (p: Pet) => p.pos.y + p.halfH;

describe('拼世界', () => {
  it('一块屏幕：四条边，四个都是墙角', () => {
    const w = buildWorld([box(0, 0, 1600, 900)]);
    expect(w.segs).toHaveLength(4);
    for (const s of w.segs) {
      expect(s.lo?.convex).toBe(false);
      expect(s.hi?.convex).toBe(false);
    }
  });

  it('并排的两块屏幕：中间没有墙，地面和天花板连成一整条', () => {
    const w = buildWorld(SIDE_BY_SIDE);
    expect(w.segs).toHaveLength(4);
    const floor = w.segs.find((s) => s.side === 'floor')!;
    expect([floor.a, floor.b, floor.c]).toEqual([0, 2000, 600]);
  });

  it('一高一矮：矮的那块的地面到头是边沿，高的那块左墙只剩下面一截', () => {
    const w = buildWorld(LEDGE);
    const high = w.segs.find((s) => s.side === 'floor' && s.c === 600)!;
    const wall = w.segs.find((s) => s.side === 'left' && s.c === 1000)!;
    expect([wall.a, wall.b]).toEqual([600, 900]);
    expect(high.hi).toEqual({ seg: wall, convex: true });
    expect(wall.lo).toEqual({ seg: high, convex: true });
    expect(wall.hi?.convex).toBe(false);
  });

  it('中间隔着任务栏的两块屏幕互不相通', () => {
    const w = buildWorld(GAP);
    expect(w.segs).toHaveLength(8);
    expect(w.segs.every((s) => !s.lo?.convex && !s.hi?.convex)).toBe(true);
  });
});

describe('跨屏幕', () => {
  it('沿着地面直接走到另一块屏幕', () => {
    const pet = makePet(SIDE_BY_SIDE);
    pet.placeOnFloor(900);
    walk(pet, 1);
    expect(run(pet, 3, (p) => p.pos.x > 1100)).toBe(true);
    expect(pet.mode).toBe('walk');
    expect(pet.side).toBe('floor');
    expect(pet.screen.left).toBe(1000);
  });

  it('扔过去：穿过屏幕交界，落在另一块屏幕上', () => {
    const pet = makePet(SIDE_BY_SIDE);
    pet.launch({ x: 700, y: 300, vx: 1600, vy: -200, rot: 0, angVel: 0 });
    run(pet, 5, (p) => p.grounded && p.mode !== 'roll');
    expect(pet.side).toBe('floor');
    expect(pet.pos.x).toBeGreaterThan(1000);
    expect(feet(pet)).toBeCloseTo(600);
  });

  it('矮屏幕的地面走到头：跳下去，落到旁边那块屏幕的地面上', () => {
    const pet = makePet(LEDGE, { stepOffChance: 1 });
    pet.placeOnFloor(900);
    walk(pet, 1);
    run(pet, 2, (p) => p.mode === 'air');
    expect(pet.mode).toBe('air');
    run(pet, 3, (p) => p.grounded);
    expect(feet(pet)).toBeCloseTo(900);
    expect(pet.pos.x).toBeGreaterThan(1000);
  });

  it('不跳的时候在边沿掉头', () => {
    const pet = makePet(LEDGE, { stepOffChance: 0 });
    pet.placeOnFloor(900);
    walk(pet, 1);
    run(pet, 2, (p) => p.dir === -1);
    expect(pet.dir).toBe(-1);
    expect(pet.mode).toBe('walk');
    expect(feet(pet)).toBeCloseTo(600);
  });

  it('从高屏幕那边爬墙，翻上矮屏幕的地面', () => {
    const pet = makePet(LEDGE, { climbChance: 1, walkSpeed: 400, surfaceStayMin: 100, surfaceStayMax: 100 });
    pet.placeOnFloor(1300, 800);
    walk(pet, -1);
    run(pet, 3, (p) => p.side === 'left');
    expect(pet.side).toBe('left');
    run(pet, 5, (p) => p.side === 'floor');
    expect(pet.side).toBe('floor');
    expect(feet(pet)).toBeCloseTo(600);
    expect(pet.pos.x).toBeLessThan(1000);
    expect(pet.dir).toBe(-1);
  });

  it('只差一截任务栏的台阶：直接迈上去，不爬墙', () => {
    const pet = makePet(TASKBAR, { climbChance: 0 });
    pet.placeOnFloor(1300, 300);
    walk(pet, -1);
    let climbed = false;
    run(pet, 4, (p) => {
      climbed ||= p.side !== 'floor';
      return p.pos.x < 900;
    });
    expect(climbed).toBe(false);
    expect(pet.side).toBe('floor');
    expect(feet(pet)).toBeCloseTo(560);
  });

  it('台阶往下：直接走下去', () => {
    const pet = makePet(TASKBAR, { stepOffChance: 0 });
    pet.placeOnFloor(800);
    walk(pet, 1);
    run(pet, 4, (p) => p.grounded && p.pos.x > 1000 && feet(p) > 590);
    expect(feet(pet)).toBeCloseTo(600);
    expect(pet.pos.x).toBeGreaterThan(1000);
  });

  it('上下摞着的屏幕：从上面那块掉下来，穿过交界落到下面那块的地面', () => {
    const pet = makePet(STACKED);
    pet.dropFrom(600, -300);
    run(pet, 3, (p) => p.grounded);
    expect(feet(pet)).toBeCloseTo(600);
  });

  it('上面那块屏幕底下没有屏幕的地方是地面', () => {
    const pet = makePet(STACKED);
    pet.dropFrom(100, -300);
    run(pet, 3, (p) => p.grounded);
    expect(feet(pet)).toBeCloseTo(0);
  });

  it('隔着任务栏就落在任务栏上', () => {
    const pet = makePet(GAP);
    pet.dropFrom(500, -300);
    run(pet, 3, (p) => p.grounded);
    expect(feet(pet)).toBeCloseTo(-40);
  });

  it('随便怎么扔，宠物中心都不会跑到屏幕外面去', () => {
    const layouts = [LEDGE, TASKBAR, STACKED, [...LEDGE, box(2000, 300, 2600, 700)]];
    let seed = 99;
    const r = () => {
      seed = (seed * 16807) % 2147483647;
      return (seed - 1) / 2147483646;
    };
    for (const [i, screens] of layouts.entries()) {
      const pet = makePet(screens, {}, 11 + i);
      const w = buildWorld(screens);
      for (let k = 0; k < 40; k++) {
        const s = screens[Math.floor(r() * screens.length)];
        pet.launch({
          x: s.left + 60 + r() * (s.right - s.left - 120),
          y: s.top + 60 + r() * (s.bottom - s.top - 120),
          vx: (r() - 0.5) * 7000,
          vy: (r() - 0.5) * 7000,
          rot: 0,
          angVel: (r() - 0.5) * 20,
        });
        for (let n = 0; n < 2.5 / STEP; n++) {
          pet.step(STEP, null);
          pet.consumeEvents();
          const { x, y } = pet.pos;
          expect(Number.isFinite(x) && Number.isFinite(y)).toBe(true);
          const inside = w.screens.some((q) => x >= q.left - 1 && x <= q.right + 1 && y >= q.top - 1 && y <= q.bottom + 1);
          if (!inside) throw new Error(`layout ${i} throw ${k}: (${x.toFixed(1)}, ${y.toFixed(1)}) mode=${pet.mode}`);
        }
      }
    }
  });

  it('放着不管溜达很久，不会卡住也不会出界', () => {
    const screens = [...LEDGE, box(2000, 300, 2600, 700)];
    const pet = makePet(screens, { climbChance: 0.8, stepOffChance: 0.6 }, 3);
    pet.placeOnFloor(500);
    const w = buildWorld(screens);
    const visited = new Set<number>();
    for (let n = 0; n < 240 / STEP; n++) {
      pet.step(STEP, null);
      pet.consumeEvents();
      const s = screenAt(w, pet.pos.x, pet.pos.y);
      expect(s).not.toBeNull();
      visited.add(s!.left);
    }
    expect(visited.size).toBeGreaterThan(1);
  });
});

describe('屏幕变化', () => {
  it('任务栏在脚下展开时，宠物留在原处并站回任务栏上方', () => {
    const pet = makePet([box(0, 0, 1000, 600)]);
    pet.placeOnFloor(750);
    pet.setScreens([box(0, 0, 1000, 552)]);
    expect(pet.pos.x).toBeCloseTo(750);
    expect(feet(pet)).toBeCloseTo(552);
  });

  it('拎到屏幕底边把任务栏顶出来，松手后落回任务栏上方', () => {
    // 小号宠物：半高比任务栏矮，松手时中心已经在新地面下面
    const pet = makePet([box(0, 0, 1000, 600)], { petScale: 2 });
    pet.placeOnFloor(500);
    pet.grab(pet.pos.x, pet.pos.y);
    pet.moveHold(500, 599, 0, 0);
    run(pet, 0.3);
    pet.setScreens([box(0, 0, 1000, 552)]);
    pet.release(0, 800, false);
    run(pet, 2);
    expect(pet.grounded).toBe(true);
    expect(feet(pet)).toBeCloseTo(552);
  });

  it('preserves a held pet across Retina/1x viewport changes and release', () => {
    const mac = box(0, 33, 1728, 1056);
    const lg = box(-868, -1440, 2572, 0);
    const pet = makePet([mac, lg]);
    pet.placeOnFloor(800);
    pet.grab(pet.pos.x, pet.pos.y);
    pet.moveHold(800, -500, 0, 0);
    run(pet, 0.1);
    const before = { ...pet.pos };
    pet.remap(1, 868, 1440);
    pet.setScreens([box(868, 1473, 2596, 2496), box(0, 0, 3440, 1440)]);
    pet.setPixelRatio(1);
    expect(pet.mode).toBe('held');
    expect(pet.pos.x).toBeCloseTo(before.x + 868);
    expect(pet.pos.y).toBeCloseTo(before.y + 1440);
    pet.release(0, 0, false);
    run(pet, 3, (p) => p.grounded);
    expect(pet.screen).toEqual(box(0, 0, 3440, 1440));
    expect(feet(pet)).toBeCloseTo(1440);
  });

  it('所在的那块屏幕没了：回到剩下的屏幕里', () => {
    const pet = makePet(SIDE_BY_SIDE);
    pet.placeOnFloor(1500);
    pet.setScreens([SIDE_BY_SIDE[0]]);
    run(pet, 3, (p) => p.grounded && p.mode !== 'land');
    expect(pet.pos.x).toBeLessThanOrEqual(1000);
    expect(feet(pet)).toBeCloseTo(600);
  });

  it('覆盖层坐标变了（挪位置、换缩放）：还站在原来那块地面上', () => {
    const pet = makePet([box(0, 0, 1600, 900)]);
    pet.placeOnFloor(800);
    pet.remap(0.5, -200, 100);
    pet.setScreens([box(-200, 100, 600, 550)]);
    expect(pet.side).toBe('floor');
    expect(pet.pos.x).toBeCloseTo(200);
    expect(feet(pet)).toBeCloseTo(550);
  });
});

describe('窗口顶边裁到屏幕里', () => {
  const p = (x0: number, x1: number, y: number) => ({ id: 1, x0, x1, y });

  it('横跨两块并排屏幕的窗口还是一整段', () => {
    expect(clipToScreens([p(800, 1300, 300)], SIDE_BY_SIDE, 40)).toEqual([p(800, 1300, 300)]);
  });

  it('伸到屏幕外面（屏幕之间的空当）的部分去掉', () => {
    // 右边那块屏幕从 y=0 到 900，左边那块只到 600：y=700 只在右边那块里
    expect(clipToScreens([p(800, 1300, 700)], LEDGE, 40)).toEqual([p(1000, 1300, 700)]);
  });

  it('顶边贴着屏幕顶的窗口（最大化）没地方站', () => {
    expect(clipToScreens([p(100, 900, 0)], SIDE_BY_SIDE, 40)).toEqual([]);
  });
});

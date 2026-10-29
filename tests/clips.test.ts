import { describe, expect, it } from 'vitest';
import { DEFAULT_TUNING } from '../src/engine/params';
import { Pet } from '../src/engine/pet';
import { cellPx, clipFrame, shrink } from '../src/render/clips';

// node 里没有 ImageData
class FakeImageData {
  constructor(
    public data: Uint8ClampedArray,
    public width: number,
    public height: number,
  ) {}
}
Object.assign(globalThis, { ImageData: (globalThis as { ImageData?: unknown }).ImageData ?? FakeImageData });

const STEP = 1 / 120;

/** W×H 的整帧：art 是一格一字符（'#' 不透明、'.' 透明），每格放大成 px×px */
function upscale(art: string[], px: number) {
  const w = art[0].length * px;
  const h = art.length * px;
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (art[Math.floor(y / px)][Math.floor(x / px)] !== '#') continue;
      rgba.set([227, 126, 82, 255], (y * w + x) * 4);
    }
  }
  return { rgba, w, h };
}

describe('播片解码', () => {
  const a = upscale(['....', '.##.', '.##.', '#..#'], 12);
  const b = upscale(['....', '....', '.##.', '....'], 12);

  it('认出放大倍数，还原成一格一像素', () => {
    expect(cellPx(a.rgba, a.w, a.h)).toBe(12);
    const clip = shrink([{ rgba: a.rgba, ms: 140 }, { rgba: b.rgba, ms: 280 }], a.w, a.h, 12);
    expect([clip.w, clip.h]).toEqual([4, 4]);
    expect(clip.frames[0].box).toEqual({ x0: 0, y0: 1, x1: 4, y1: 4 });
    expect(clip.frames[1].box).toEqual({ x0: 1, y0: 2, x1: 3, y1: 3 });
  });

  it('脚底取所有帧里最低的那行，时长逐帧累计', () => {
    const clip = shrink([{ rgba: b.rgba, ms: 140 }, { rgba: a.rgba, ms: 280 }], a.w, a.h, 12);
    expect(clip.floor).toBe(4);
    expect(clip.duration).toBeCloseTo(0.42);
    expect(clip.frames.indexOf(clipFrame(clip, 0.1))).toBe(0);
    expect(clip.frames.indexOf(clipFrame(clip, 0.2))).toBe(1);
    expect(clip.frames.indexOf(clipFrame(clip, 9))).toBe(1);
  });
});

describe('播片动作', () => {
  const makePet = () =>
    new Pet({ ...DEFAULT_TUNING }, [16, 10], { left: 0, top: 0, right: 1600, bottom: 900 }, () => 0.5);

  it('站在地上能播，播完冒烟回到发呆', () => {
    const pet = makePet();
    pet.placeOnFloor(800);
    expect(pet.playClip('ghost', 1)).toBe(true);
    expect(pet.mode).toBe('clip');
    expect(pet.consumeEvents().filter((e) => e.type === 'poof')).toHaveLength(1);
    let poofs = 0;
    for (let i = 0; i < 1.2 / STEP; i++) {
      pet.step(STEP, null);
      poofs += pet.consumeEvents().filter((e) => e.type === 'poof').length;
    }
    expect(pet.mode).not.toBe('clip');
    expect(poofs).toBe(1);
  });

  it('播的时候被拎起来：也冒烟换回来', () => {
    const pet = makePet();
    pet.placeOnFloor(800);
    pet.playClip('ghost', 5);
    pet.consumeEvents();
    pet.grab(pet.pos.x, pet.pos.y);
    expect(pet.mode).toBe('held');
    expect(pet.consumeEvents().some((e) => e.type === 'poof')).toBe(true);
  });

  it('飞在天上不播', () => {
    const pet = makePet();
    pet.dropFrom(800, 100);
    expect(pet.playClip('ghost', 1)).toBe(false);
  });
});

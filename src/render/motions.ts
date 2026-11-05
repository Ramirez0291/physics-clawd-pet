import type { PartImage, SkinMotion } from '../skin/types';
import { imagePiece } from './sprites';
import type { Pet, Side } from '../engine/pet';

/** dir 是世界沿面的增量；右墙和天花板旋转后，本地 +X 与世界增量相反。 */
export function motionMirrored(motion: SkinMotion, side: Side, dir: 1 | -1): boolean {
  const localDir = (side === 'right' || side === 'ceiling' ? -dir : dir);
  return !!motion.directional && localDir !== (motion.facing ?? 1);
}

export function motionFrameIndex(motion: SkinMotion, pet: Pick<Pet, 'side' | 'mode' | 'modeTime' | 'tuning'>, locomotion = pet.mode === 'walk', speedScale = 1): number {
  const speed = pet.side === 'floor' ? pet.tuning.walkSpeed : pet.tuning.climbSpeed;
  const rate = (motion.fps ?? 2) * (locomotion ? speed * speedScale / 40 : 1);
  const frame = Math.max(0, Math.floor(pet.modeTime * rate));
  return motion.loop === false ? Math.min(frame, motion.frames.length - 1) : frame % motion.frames.length;
}

export interface MotionFrame {
  image: HTMLCanvasElement;
  box: { x: number; y: number; w: number; h: number };
}
const regions = new WeakMap<SkinMotion, PartImage[]>();
const ready = new WeakMap<SkinMotion, MotionFrame[]>();

/** 统一检测脚底、绘画尺度；不能把坐姿/趴姿各自拉伸成站姿的高度。 */
export function motionFrames(motion: SkinMotion): MotionFrame[] | null {
  const old = ready.get(motion);
  if (old) return old;
  let defs = regions.get(motion);
  if (!defs) {
    defs = motion.frames.map((f) => ({ ...f, src: motion.src }));
    regions.set(motion, defs);
  }
  const images = defs.map(imagePiece);
  if (images.some((i) => !i)) return null;
  const frames = images.map((image) => {
    const c = image!;
    const { data } = c.getContext('2d')!.getImageData(0, 0, c.width, c.height);
    let x0 = c.width, y0 = c.height, x1 = -1, y1 = -1;
    for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
      if (data[(y * c.width + x) * 4 + 3] < 96) continue;
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    }
    if (x1 < x0) throw new Error('动作裁片为空');
    return { image: c, box: { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 } };
  });
  ready.set(motion, frames);
  return frames;
}

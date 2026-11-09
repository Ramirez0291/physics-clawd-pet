// 拟人姿态与宠物团子的演出分开。物理状态、碰撞和抛物线仍由 Pet 负责。
import { clamp } from './math';
import type { Pet } from './pet';
import type { Pose, Prop } from './pose';
import { parseHex, type MotionName, type Skin } from '../skin/types';

export function adaptHumanoidPose(pet: Pet, skin: Skin, pose: Pose): Pose {
  const t = pet.modeTime;
  const phase = t * Math.PI * 2 * Math.max(0.7, pet.tuning.walkSpeed / 30);
  const arm = (fn: (side: number) => number) => skin.parts.forEach((part, i) => {
    if (part.role !== 'arm') return;
    Object.assign(pose.parts[i], { dx: 0, dy: 0, rot: fn(part.side) });
  });
  let motion: MotionName | undefined;
  // 身体维持人的比例，用屈膝和专门姿势表现冲击，不把脸压成饼。
  pose.torso.sx = clamp(pose.torso.sx, 0.94, 1.06);
  pose.torso.sy = clamp(pose.torso.sy, 0.9, 1.08);
  switch (pet.mode) {
    case 'laptop': motion = 'laptop'; break;
    case 'walk':
      motion = 'walk';
      pose.torso.dy = -Math.abs(Math.sin(phase)) * 0.14;
      arm((side) => side * Math.sin(phase) * 0.16);
      skin.parts.forEach((part, i) => {
        if (part.role !== 'leg') return;
        const step = Math.sin(phase + part.order * Math.PI);
        Object.assign(pose.parts[i], { dx: step * 0.16, dy: -Math.max(0, step) * 0.35, rot: step * 0.16 });
      });
      break;
    case 'petted':
      motion = 'love';
      pose.torso = { dx: Math.sin(t * 2.4) * 0.08, dy: 0, sx: 1, sy: 1, rot: 0 };
      arm((side) => -side * 0.7);
      skin.parts.forEach((part, i) => { if (part.role === 'leg') Object.assign(pose.parts[i], { dx: 0, dy: 0, rot: 0 }); });
      if (skin.motions?.love) pose.props = []; // momo原画自带腮红；其他拟人皮肤继续使用定位后的腮红。
      pose.face = 'happy';
      break;
    case 'read':
    case 'write':
      motion = pet.mode;
      pose.torso.dy = (skin.grid[1] - skin.bodyBox.y - skin.bodyBox.h) * 0.4;
      arm((side) => -side * (0.55 + (pet.mode === 'write' && side > 0 ? Math.sin(t * 7) * 0.04 : 0)));
      pose.face = 'focus';
      pose.props = (skin.motions?.[motion]?.frames.length ?? 0) > 1 ? [] : deskProps(pet, skin, !!skin.motions?.[motion]);
      break;
    case 'think':
      motion = 'think';
      arm((side) => side < 0 ? -1.4 : 0);
      pose.face = 'focus';
      break;
    case 'perch': motion = 'perch'; break;
    case 'peek': motion = pet.peekApproaching ? 'walk' : 'peek'; break;
    case 'hop': motion = 'hop'; break;
    case 'held':
      motion = 'held';
      arm((side) => -side * 0.45);
      break;
    case 'air':
      motion = 'air';
      arm((side) => -side * (0.6 + Math.sin(t * 6 + side) * 0.08));
      break;
    case 'roll': motion = 'roll'; break;
    case 'hero': motion = 'hero'; break;
    case 'splat': motion = 'splat'; break;
    case 'cling': motion = 'cling'; break;
    case 'land':
      if (t / Math.max(0.01, pet.modeDuration) < 0.7) motion = 'land';
      break;
    case 'stretch': motion = 'stretch'; break;
    case 'zap': motion = 'air'; break;
    case 'knock': arm((side) => -side * 0.15); break;
    case 'sweep': arm((side) => -side * 0.35 + pet.dir * 0.15); break;
  }
  // 响应真实窗口运动，优先于安静的小动作；提醒、摸摸、被抓取仍由用户控制。
  if (pet.windowPlay) {
    if (pet.mode === 'air') {
      if (pet.windowDropUntil > pet.t) { motion = 'windowDrop'; pose.motionTime = 1.2 - (pet.windowDropUntil - pet.t); }
      else if (pet.windowLeapUntil > pet.t) { motion = 'windowLeap'; pose.motionTime = 1 - (pet.windowLeapUntil - pet.t); }
    }
    const quiet = ['idle', 'walk', 'perch', 'peek', 'read', 'write', 'think'].includes(pet.mode);
    if (pet.support && pet.grounded && quiet) {
      if (pet.windowStumbleUntil > pet.t) { motion = 'stumble'; pose.motionTime = 1 - (pet.windowStumbleUntil - pet.t); }
      else if (Math.hypot(pet.carrier.vx, pet.carrier.vy) > 65 || Math.abs(pet.lean) > 0.08) { motion = 'balance'; pose.motionTime = pet.t; }
    }
    if (pet.support && ['idle', 'land', 'hero'].includes(pet.mode) && pet.windowLandingUntil > pet.t) {
      motion = 'windowLand'; pose.motionTime = 1.1 - (pet.windowLandingUntil - pet.t);
    }
  }
  if (motion && skin.motions?.[motion]) {
    pose.motion = motion;
    if (motion !== 'read' && motion !== 'write' && pet.mode !== 'zap') pose.props = [];
  }
  return pose;
}

function deskProps(pet: Pet, skin: Skin, hasArt: boolean): Prop[] {
  const out: Prop[] = [];
  const [w, h] = skin.grid;
  const add = (x: number, y: number, width: number, height: number, color: string) => out.push({ x, y, w: width, h: height, rgba: parseHex(color) });
  // 其他拟人皮肤没有设定图动作时，仍可使用尺寸按角色比例布置的书本和笔记。
  const cx = w / 2, y = h - (hasArt ? h * (pet.mode === 'read' ? 0.24 : 0.08) : h * 0.21);
  if (!hasArt) {
    add(cx - 2.8, y, 5.6, 2.8, '#43322b');
    add(cx - 2.5, y + 0.2, 5, 2.2, '#fff0d6');
    add(cx - 0.08, y + 0.2, 0.16, 2.2, '#cba776');
  }
  if (pet.mode === 'read') {
    // 页角轻翻；单幅设定图也有连续的阅读节奏。
    const flip = Math.max(0, Math.sin(pet.modeTime * 1.8));
    if (flip > 0.6) add(cx + 0.1, y - 0.12, (flip - 0.6) * 2.1, 0.16, '#ffe6b9');
  } else {
    const x = cx - 1.1 + (pet.modeTime * 0.7 % 1.8);
    add(x, y + 0.4, 0.12, 0.65, '#6d4530');
    add(x - 0.2, y + 0.95, 0.32, 0.1, '#4d3a34');
  }
  return out;
}

// 原画贴图与道具合成：跟像素渲染器共用同一套姿势计算，按实际分辨率绘制裁片部件和程序化道具。

import type { Affine } from '../engine/math';
import type { Pose } from '../engine/pose';
import type { Skin, SkinPart } from '../skin/types';
import { imagePiece } from './sprites';

/** 摆好姿势后的一个部件或道具：中心、半宽高（网格坐标，原点在网格左上角）、旋转（弧度） */
export interface Item {
  cx: number;
  cy: number;
  hw: number;
  hh: number;
  rot: number;
  part: SkinPart | null;
  /** 道具的颜色（ImageData 打包格式） */
  rgba: number;
  /** 柔边椭圆的道具（腮红） */
  soft: boolean;
}

/** 部件在前，道具在后（画在最上面）。跟像素渲染器同一套姿势计算。 */
export function layoutItems(skin: Skin, pose: Pose): Item[] {
  const ta = skin.torsoAnchor;
  const t = pose.torso;
  const out: Item[] = [];
  const add = (
    x: number,
    y: number,
    w: number,
    h: number,
    pp: { dx: number; dy: number; sx: number; sy: number },
    torso: boolean,
    rot: number,
    part: SkinPart | null,
    rgba: number,
    soft = false,
  ) => {
    let cx = x + w / 2 + pp.dx;
    let cy = y + h / 2 + pp.dy;
    // 贴图和像素部件共用肩关节、发根：旋转时围绕关节移动部件中心。
    if (part?.pivot && rot) {
      const px = part.pivot[0] + pp.dx;
      const py = part.pivot[1] + pp.dy;
      const dx = cx - px;
      const dy = cy - py;
      cx = px + Math.cos(rot) * dx - Math.sin(rot) * dy;
      cy = py + Math.sin(rot) * dx + Math.cos(rot) * dy;
    }
    let hw = (w / 2) * pp.sx;
    let hh = (h / 2) * pp.sy;
    if (torso) {
      cx = ta.x + (cx - ta.x) * t.sx + t.dx;
      cy = ta.y + (cy - ta.y) * t.sy + t.dy;
      hw *= t.sx;
      hh *= t.sy;
    }
    out.push({ cx, cy, hw, hh, rot, part, rgba, soft });
  };
  skin.parts.forEach((part, i) => {
    const [x, y, w, h] = part.rect;
    add(x, y, w, h, pose.parts[i], part.role !== 'leg' && !part.anchored, pose.parts[i].rot, part, part.rgba);
  });
  const none = { dx: 0, dy: 0, sx: 1, sy: 1 };
  for (const p of pose.props) add(p.x, p.y, p.w, p.h, none, !!p.torso, 0, null, p.rgba, !!p.soft);
  return out;
}

type RGB = [number, number, number];

const css = (c: RGB, alpha = 1) =>
  `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${alpha})`;
const unpack = (rgba: number) => css([rgba & 255, (rgba >>> 8) & 255, (rgba >>> 16) & 255], (rgba >>> 24) / 255);

/**
 * 把摆好姿势的部件画进精灵画布。m：网格坐标（原点在网格中心）→ 设备像素；
 * (ox, oy)：精灵画布左上角在屏幕上的设备像素坐标。
 */
export function drawItems(
  g: CanvasRenderingContext2D,
  items: Item[],
  skin: Skin,
  m: Affine,
  ox: number,
  oy: number,
) {
  const [gw, gh] = skin.grid;
  g.imageSmoothingEnabled = true;
  for (const it of items) {
    if (it.hw <= 0 || it.hh <= 0) continue;
    g.setTransform(m.a, m.b, m.c, m.d, m.e - ox, m.f - oy);
    g.translate(it.cx - gw / 2, it.cy - gh / 2);
    if (it.rot) g.rotate(it.rot);
    const part = it.part;
    g.globalAlpha = part ? (it.rgba >>> 24) / 255 : 1;
    if (!part) {
      if (it.soft) {
        // 腮红：柔边椭圆
        const c: RGB = [it.rgba & 255, (it.rgba >>> 8) & 255, (it.rgba >>> 16) & 255];
        g.scale(1, it.hh / it.hw);
        const grad = g.createRadialGradient(0, 0, 0, 0, 0, it.hw * 1.15);
        grad.addColorStop(0, css(c, 0.75));
        grad.addColorStop(0.6, css(c, 0.5));
        grad.addColorStop(1, css(c, 0));
        g.fillStyle = grad;
        g.beginPath();
        g.arc(0, 0, it.hw * 1.15, 0, Math.PI * 2);
        g.fill();
        continue;
      }
      // 其他道具（电脑、金币）本来就是像素画，照原样画成小方块
      g.fillStyle = unpack(it.rgba);
      g.fillRect(-it.hw, -it.hh, it.hw * 2, it.hh * 2);
      continue;
    }
    if (part.image) {
      const image = imagePiece(part.image);
      if (image) {
        g.imageSmoothingEnabled = false;
        g.drawImage(image, -it.hw, -it.hh, it.hw * 2, it.hh * 2);
        g.imageSmoothingEnabled = true;
      }
      continue;
    }
    g.fillStyle = unpack(it.rgba);
    g.fillRect(-it.hw, -it.hh, it.hw * 2, it.hh * 2);
  }
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalAlpha = 1;
}

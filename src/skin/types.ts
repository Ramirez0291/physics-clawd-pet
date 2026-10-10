// 皮肤包格式。引擎只认识 body / eye / arm / leg 四种部件角色，
// 任何按这个格式画出来的角色都能直接用上全部物理和程序化动作。
// 皮肤可以选画风（像素 / 平滑），也可以挑自己会做哪些小动作。

import { ACTIVITIES, type Activity, DEFAULT_ACTIVITIES } from '../engine/pet';

export type PartRole = 'body' | 'eye' | 'arm' | 'leg';
export const PART_ROLES: readonly PartRole[] = ['body', 'eye', 'arm', 'leg'];

/** 平滑画风下部件的形状；像素画风一律按矩形画 */
export type PartShape = 'rect' | 'ellipse' | 'cloud';
export const PART_SHAPES: readonly PartShape[] = ['rect', 'ellipse', 'cloud'];

export interface SkinPartDef {
  id: string;
  role: PartRole;
  /** [x, y, w, h]，单位是皮肤网格格子。有毛的部件这是连毛在内的外轮廓。 */
  rect: [number, number, number, number];
  /** palette 里的颜色名 */
  color: string;
  /** 仅平滑画风：形状，默认 rect */
  shape?: PartShape;
  /** 仅平滑画风：绕部件中心旋转的角度（度，顺时针） */
  rot?: number;
  /** 仅平滑画风：画成毛茸茸的（毛的样子见 SkinDef.fur） */
  fur?: boolean;
}

export interface FurDef {
  /** 毛长（格） */
  length: number;
  /** 受光面和背光面的毛色；不写就用部件颜色调亮/调暗 */
  light?: string;
  shade?: string;
}

export interface SkinDef {
  id: string;
  name: string;
  description?: string;
  /** [宽, 高]，单位格子。物理碰撞盒就是这个大小。 */
  grid: [number, number];
  /** pixel：低分辨率网格里旋转再最近邻放大（默认）；smooth：按实际分辨率画平滑的形状 */
  render?: 'pixel' | 'smooth';
  palette: Record<string, string>;
  fur?: FurDef;
  /** 会做哪些小动作，默认电脑、炒股、吃TOKEN；也可以加上专属动作 */
  actions?: Activity[];
  /** 按绘制顺序排列，后面的盖在前面上面 */
  parts: SkinPartDef[];
}

export interface SkinPart extends SkinPartDef {
  /** 相对网格中心：-1 左 / 0 中 / 1 右 */
  side: -1 | 0 | 1;
  /** 同角色部件按 x 排序后的序号（腿的相位分组用） */
  order: number;
  /** ImageData 用的 RGBA（小端序打包成 uint32） */
  rgba: number;
  /** '#rrggbb' */
  hex: string;
}

export interface Skin extends Omit<SkinDef, 'parts' | 'render' | 'actions'> {
  parts: SkinPart[];
  /** 像素画风：大小会被量化到整数设备像素 */
  pixelArt: boolean;
  actions: Activity[];
  /** 躯干缩放锚点（身体底边中点），网格坐标 */
  torsoAnchor: { x: number; y: number };
  /** 所有 body 部件合起来的包围盒（帽子之类也算身体），网格坐标 */
  bodyBox: { x: number; y: number; w: number; h: number };
  /** 眼睛部件的包围盒，没有眼睛为 null。腮红、吃金币的嘴都按它定位 */
  eyeBox: { x: number; y: number; w: number; h: number } | null;
}

function boxOf(parts: SkinPartDef[]) {
  if (!parts.length) return null;
  const x0 = Math.min(...parts.map((p) => p.rect[0]));
  const y0 = Math.min(...parts.map((p) => p.rect[1]));
  const x1 = Math.max(...parts.map((p) => p.rect[0] + p.rect[2]));
  const y1 = Math.max(...parts.map((p) => p.rect[1] + p.rect[3]));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** '#rrggbb' / '#rrggbbaa' → ImageData 用的 uint32（小端序 RGBA） */
export function parseHex(hex: string): number {
  const m = /^#?([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(hex.trim());
  if (!m) throw new Error(`颜色格式不对: ${hex}`);
  const v = parseInt(m[1], 16);
  const a = m[2] ? parseInt(m[2], 16) : 255;
  const r = (v >> 16) & 255;
  const g = (v >> 8) & 255;
  const b = v & 255;
  return ((a << 24) | (b << 16) | (g << 8) | r) >>> 0;
}

export function loadSkin(def: SkinDef): Skin {
  const [gw, gh] = def.grid;
  if (!(gw > 0 && gh > 0)) throw new Error('grid 必须是正数');
  if (!def.parts.length) throw new Error('皮肤没有任何部件');
  const render = def.render ?? 'pixel';
  if (render !== 'pixel' && render !== 'smooth') throw new Error(`未知画风: ${render}`);
  const actions = def.actions ?? [...DEFAULT_ACTIVITIES];
  for (const a of actions) if (!ACTIVITIES.includes(a)) throw new Error(`未知小动作: ${a}`);

  const byRole = new Map<PartRole, SkinPartDef[]>();
  for (const p of def.parts) {
    if (!PART_ROLES.includes(p.role)) throw new Error(`未知部件角色: ${p.role}`);
    if (!(p.color in def.palette)) throw new Error(`部件 ${p.id} 用了不存在的颜色 ${p.color}`);
    if (p.shape && !PART_SHAPES.includes(p.shape)) throw new Error(`部件 ${p.id} 的形状未知: ${p.shape}`);
    byRole.set(p.role, [...(byRole.get(p.role) ?? []), p]);
  }
  const cx = gw / 2;
  const parts: SkinPart[] = def.parts.map((p) => {
    const center = p.rect[0] + p.rect[2] / 2;
    const side: -1 | 0 | 1 = Math.abs(center - cx) < 0.25 ? 0 : center < cx ? -1 : 1;
    const peers = [...byRole.get(p.role)!].sort((a, b) => a.rect[0] - b.rect[0]);
    const hex = def.palette[p.color];
    return { ...p, side, order: peers.indexOf(p), rgba: parseHex(hex), hex };
  });

  const bodyBox = boxOf(def.parts.filter((p) => p.role === 'body')) ?? { x: 0, y: 0, w: gw, h: gh };
  const eyeBox = boxOf(def.parts.filter((p) => p.role === 'eye'));
  const torsoAnchor = { x: bodyBox.x + bodyBox.w / 2, y: bodyBox.y + bodyBox.h };

  const { render: _render, actions: _actions, ...rest } = def;
  return { ...rest, parts, pixelArt: render === 'pixel', actions, torsoAnchor, bodyBox, eyeBox };
}

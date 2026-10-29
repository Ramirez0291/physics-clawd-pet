// 皮肤包格式。引擎只认识 body / eye / arm / leg 四种部件角色，
// 任何按这个格式画出来的角色都能直接用上全部物理和程序化动作。
// 皮肤可以选画风（像素 / 平滑），也可以挑自己会做哪些小动作。
// 像素画风的部件可以是一块纯色，也可以是一张像素图（拟人角色用），
// 再给手臂一个肩关节（pivot），程序化动作就会把"抬手"换算成绕肩旋转。

import { ACTIVITIES, type Activity, DEFAULT_ACTIVITIES } from '../engine/pet';

export type PartRole = 'body' | 'eye' | 'arm' | 'leg';
export const PART_ROLES: readonly PartRole[] = ['body', 'eye', 'arm', 'leg'];

/**
 * 表情：程序化动作按状态挑一个，眼睛、嘴巴的部件可以给每种表情画一张像素图（faces）。
 * smile 是平时的样子，就是部件本来的 pixels。没画的表情退回平时的样子。
 */
export type Expression = 'smile' | 'happy' | 'surprised' | 'wince' | 'cry' | 'smug' | 'focus' | 'eat' | 'yawn';
export const EXPRESSIONS: readonly Expression[] = ['smile', 'happy', 'surprised', 'wince', 'cry', 'smug', 'focus', 'eat', 'yawn'];

/** 平滑画风下部件的形状；像素画风一律按矩形画 */
export type PartShape = 'rect' | 'ellipse' | 'cloud' | 'pear' | 'onigiri' | 'frog' | 'bow' | 'arch' | 'eyelid';
export const PART_SHAPES: readonly PartShape[] = ['rect', 'ellipse', 'cloud', 'pear', 'onigiri', 'frog', 'bow', 'arch', 'eyelid'];

export interface SkinPartDef {
  id: string;
  role: PartRole;
  /** [x, y, w, h]，单位是皮肤网格格子。有毛的部件这是连毛在内的外轮廓。 */
  rect: [number, number, number, number];
  /** palette 里的颜色名；有像素图时可以不写 */
  color?: string;
  /**
   * 仅像素画风：部件的像素图，一行一个字符串，字符按皮肤的 legend 换成颜色，'.' 是透明。
   * 每个字符是一个精灵像素（1/3 格），所以行数 = rect 高 × 3，每行长度 = rect 宽 × 3。
   */
  pixels?: string[];
  /** 仅眼睛：闭眼（眯眼、眨眼）时换用的像素图，大小和 pixels 一样 */
  closed?: string[];
  /** 各种表情时换用的像素图（眼睛、嘴巴），大小和 pixels 一样；用了表情图就不再眨眼、眯眼 */
  faces?: Partial<Record<Expression, string[]>>;
  /**
   * 关节位置 [x, y]（格子坐标）。手臂有关节时，动作里"把手抬高/往外伸"会换算成绕关节旋转；
   * 配合 sway，别的部件（尾巴、耳朵、呆毛）会绕关节晃。
   */
  pivot?: [number, number];
  /** 绕 pivot 自己晃：幅度（度）、每秒晃几下（默认 0.5）、相位（0～1） */
  sway?: SwayDef;
  /** 不跟着躯干动（坐下、呼吸、压扁时留在原地），比如拖在地上的尾巴 */
  anchored?: boolean;
  /** 仅平滑画风：形状，默认 rect */
  shape?: PartShape;
  /** 仅平滑画风：绕部件中心旋转的角度（度，顺时针） */
  rot?: number;
  /** 仅平滑画风：true 使用皮肤毛发设置，也可为配饰单独指定毛发 */
  fur?: boolean | FurDef;
  /** 仅平滑画风：空心描边的宽度（格），比如眼镜框 */
  outline?: number;
  /** 眼睛跟随光标的位移倍率，默认 1；大眼球可减小，避免瞳孔跑出眼白 */
  gaze?: number;
}

export interface SwayDef {
  amp: number;
  speed?: number;
  phase?: number;
}

export interface FurDef {
  /** 毛长（格） */
  length: number;
  /** 受光面和背光面的毛色；不写就用部件颜色调亮/调暗 */
  light?: string;
  shade?: string;
  /** 毛发密度倍率，渲染时限制在 0.4～2，贴图生成后缓存 */
  density?: number;
  /** 毛发弯曲程度，0（直毛）～1 */
  curl?: number;
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
  /** 像素图的字符 → palette 里的颜色名 */
  legend?: Record<string, string>;
  fur?: FurDef;
  /** 会做哪些小动作，默认电脑、炒股、吃TOKEN；也可以加上专属动作 */
  actions?: Activity[];
  /** 电脑怎么用：side 摆在身边、屏幕朝外（默认）；lap 坐下来放在腿上，两只手一起敲 */
  laptop?: 'side' | 'lap';
  /** 按绘制顺序排列，后面的盖在前面上面 */
  parts: SkinPartDef[];
}

export interface SkinPart extends SkinPartDef {
  /** 相对网格中心：-1 左 / 0 中 / 1 右 */
  side: -1 | 0 | 1;
  /** 同角色部件按 x 排序后的序号（腿的相位分组用） */
  order: number;
  /** ImageData 用的 RGBA（小端序打包成 uint32）；像素图部件是用得最多的那个颜色 */
  rgba: number;
  /** '#rrggbb' */
  hex: string;
  /** 像素图解析成的颜色（行优先，0 = 透明） */
  bitmap?: { w: number; h: number; data: Uint32Array; closed?: Uint32Array; faces?: Partial<Record<Expression, Uint32Array>> };
}

export interface Skin extends Omit<SkinDef, 'parts' | 'render' | 'actions'> {
  parts: SkinPart[];
  /** 像素画风：大小会被量化到整数设备像素 */
  pixelArt: boolean;
  actions: Activity[];
  /** 躯干缩放锚点（身体底边中点），网格坐标 */
  torsoAnchor: { x: number; y: number };
  /** body 部件合起来的包围盒（帽子之类也算身体，会晃的装饰不算），网格坐标 */
  bodyBox: { x: number; y: number; w: number; h: number };
  /** 眼睛部件的包围盒，没有眼睛为 null。腮红、吃金币的嘴都按它定位 */
  eyeBox: { x: number; y: number; w: number; h: number } | null;
  /** 播片：名字 → GIF 地址。内置皮肤由 registry 从 skins/<目录>/clips/*.gif 收集 */
  clips?: Record<string, string>;
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

/** 一个格子分成几个精灵像素（和默认的像素细分一致） */
export const SUB = 3;

/** 像素图 → 颜色数组；尺寸必须正好是 rect × 3，保证一个字符就是一个精灵像素 */
function parseBitmap(def: SkinDef, p: SkinPartDef) {
  const w = Math.round(p.rect[2] * SUB);
  const h = Math.round(p.rect[3] * SUB);
  const decode = (rows: string[], what: string) => {
    if (rows.length !== h || rows.some((r) => r.length !== w)) {
      throw new Error(`部件 ${p.id} 的${what}应该是 ${w}×${h}（rect 的 3 倍）`);
    }
    const data = new Uint32Array(w * h);
    rows.forEach((row, y) =>
      [...row].forEach((ch, x) => {
        if (ch === '.' || ch === ' ') return;
        const name = def.legend?.[ch];
        if (!name || !(name in def.palette)) throw new Error(`部件 ${p.id} 的像素图用了没定义的字符 "${ch}"`);
        data[y * w + x] = parseHex(def.palette[name]);
      }),
    );
    return data;
  };
  const faces: Partial<Record<Expression, Uint32Array>> = {};
  for (const [name, rows] of Object.entries(p.faces ?? {})) {
    if (!EXPRESSIONS.includes(name as Expression)) throw new Error(`部件 ${p.id} 的表情未知: ${name}`);
    faces[name as Expression] = decode(rows!, `表情图 ${name} `);
  }
  return {
    w,
    h,
    data: decode(p.pixels!, '像素图'),
    ...(p.closed ? { closed: decode(p.closed, '闭眼图') } : {}),
    ...(p.faces ? { faces } : {}),
  };
}

/** 像素图里用得最多的颜色（给只认单色的地方用，比如毛团颜色） */
function dominantHex(def: SkinDef, rows: string[]): string {
  const count = new Map<string, number>();
  for (const ch of rows.join('')) if (ch !== '.' && ch !== ' ') count.set(ch, (count.get(ch) ?? 0) + 1);
  const top = [...count].sort((a, b) => b[1] - a[1])[0]?.[0];
  return def.palette[def.legend?.[top ?? ''] ?? ''] ?? '#000000';
}

export function loadSkin(def: SkinDef): Skin {
  const [gw, gh] = def.grid;
  if (!(gw > 0 && gh > 0)) throw new Error('grid 必须是正数');
  if (!def.parts.length) throw new Error('皮肤没有任何部件');
  const render = def.render ?? 'pixel';
  if (render !== 'pixel' && render !== 'smooth') throw new Error(`未知画风: ${render}`);
  const actions = def.actions ?? [...DEFAULT_ACTIVITIES];
  for (const a of actions) if (!ACTIVITIES.includes(a)) throw new Error(`未知小动作: ${a}`);
  if (def.laptop !== undefined && def.laptop !== 'side' && def.laptop !== 'lap') throw new Error(`未知电脑用法: ${def.laptop}`);

  const byRole = new Map<PartRole, SkinPartDef[]>();
  for (const p of def.parts) {
    if (!PART_ROLES.includes(p.role)) throw new Error(`未知部件角色: ${p.role}`);
    if (p.color === undefined ? !p.pixels : !(p.color in def.palette)) throw new Error(`部件 ${p.id} 用了不存在的颜色 ${p.color}`);
    if (p.pixels && render !== 'pixel') throw new Error(`部件 ${p.id}：像素图只能用在像素画风`);
    if (p.closed && !p.pixels) throw new Error(`部件 ${p.id}：closed 要配合 pixels 用`);
    if (p.faces && !p.pixels) throw new Error(`部件 ${p.id}：faces 要配合 pixels 用`);
    if (p.pivot && !(p.pivot.length === 2 && p.pivot.every(Number.isFinite))) throw new Error(`部件 ${p.id} 的关节位置不对`);
    if (p.sway && (!p.pivot || !Number.isFinite(p.sway.amp))) throw new Error(`部件 ${p.id}：sway 需要 pivot 和幅度`);
    if (p.shape && !PART_SHAPES.includes(p.shape)) throw new Error(`部件 ${p.id} 的形状未知: ${p.shape}`);
    if (p.outline !== undefined && (!Number.isFinite(p.outline) || p.outline <= 0)) throw new Error(`部件 ${p.id} 的描边必须是正数`);
    if (p.gaze !== undefined && (!Number.isFinite(p.gaze) || p.gaze < 0)) throw new Error(`部件 ${p.id} 的视线倍率必须是非负数`);
    byRole.set(p.role, [...(byRole.get(p.role) ?? []), p]);
  }
  const cx = gw / 2;
  const parts: SkinPart[] = def.parts.map((p) => {
    const center = p.rect[0] + p.rect[2] / 2;
    const side: -1 | 0 | 1 = Math.abs(center - cx) < 0.25 ? 0 : center < cx ? -1 : 1;
    const peers = [...byRole.get(p.role)!].sort((a, b) => a.rect[0] - b.rect[0]);
    const bitmap = p.pixels ? parseBitmap(def, p) : undefined;
    const hex = p.color !== undefined ? def.palette[p.color] : dominantHex(def, p.pixels!);
    return { ...p, side, order: peers.indexOf(p), rgba: parseHex(hex), hex, ...(bitmap ? { bitmap } : {}) };
  });

  // 会晃的装饰（尾巴、耳朵、呆毛）不算身体轮廓：不然躯干的缩放锚点、举牌子的高度都会被它带偏
  const torsoParts = def.parts.filter((p) => p.role === 'body' && !p.sway);
  const bodyBox = boxOf(torsoParts.length ? torsoParts : def.parts.filter((p) => p.role === 'body')) ?? { x: 0, y: 0, w: gw, h: gh };
  const eyeBox = boxOf(def.parts.filter((p) => p.role === 'eye'));
  const torsoAnchor = { x: bodyBox.x + bodyBox.w / 2, y: bodyBox.y + bodyBox.h };

  const { render: _render, actions: _actions, ...rest } = def;
  return { ...rest, parts, pixelArt: render === 'pixel', actions, torsoAnchor, bodyBox, eyeBox };
}

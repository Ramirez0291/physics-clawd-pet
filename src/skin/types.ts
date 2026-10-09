// 皮肤包格式。引擎只认识 body / eye / arm / leg 四种部件角色，
// 任何按这个格式画出来的角色都能直接用上全部物理和程序化动作。

export type PartRole = 'body' | 'eye' | 'arm' | 'leg';
export const PART_ROLES: readonly PartRole[] = ['body', 'eye', 'arm', 'leg'];

export interface SkinPartDef {
  id: string;
  role: PartRole;
  /** [x, y, w, h]，单位是皮肤网格格子 */
  rect: [number, number, number, number];
  /** palette 里的颜色名 */
  color: string;
}

export interface SkinDef {
  id: string;
  name: string;
  description?: string;
  /** [宽, 高]，单位格子。物理碰撞盒就是这个大小。 */
  grid: [number, number];
  palette: Record<string, string>;
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
}

export interface Skin extends Omit<SkinDef, 'parts'> {
  parts: SkinPart[];
  /** 躯干缩放锚点（身体底边中点），网格坐标 */
  torsoAnchor: { x: number; y: number };
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

  const byRole = new Map<PartRole, SkinPartDef[]>();
  for (const p of def.parts) {
    if (!PART_ROLES.includes(p.role)) throw new Error(`未知部件角色: ${p.role}`);
    if (!(p.color in def.palette)) throw new Error(`部件 ${p.id} 用了不存在的颜色 ${p.color}`);
    byRole.set(p.role, [...(byRole.get(p.role) ?? []), p]);
  }
  const cx = gw / 2;
  const parts: SkinPart[] = def.parts.map((p) => {
    const center = p.rect[0] + p.rect[2] / 2;
    const side: -1 | 0 | 1 = Math.abs(center - cx) < 0.25 ? 0 : center < cx ? -1 : 1;
    const peers = [...byRole.get(p.role)!].sort((a, b) => a.rect[0] - b.rect[0]);
    return { ...p, side, order: peers.indexOf(p), rgba: parseHex(def.palette[p.color]) };
  });

  const body = def.parts.find((p) => p.role === 'body');
  const torsoAnchor = body
    ? { x: body.rect[0] + body.rect[2] / 2, y: body.rect[1] + body.rect[3] }
    : { x: cx, y: gh };

  return { ...def, parts, torsoAnchor };
}

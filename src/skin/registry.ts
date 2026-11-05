// 内置皮肤：skins/*/skin.json 会被自动收进来，加一个目录就多一个形象。
// 同目录 clips/ 下的 GIF 是这个形象的播片，文件名（不带扩展名）就是播片的名字。

import { type Skin, type SkinDef, loadSkin } from './types';

export const DEFAULT_SKIN = 'clawd';

const defs = import.meta.glob<SkinDef>('../../skins/*/skin.json', { eager: true, import: 'default' });
const clipUrls = import.meta.glob<string>('../../skins/*/clips/*.gif', { eager: true, query: '?url', import: 'default' });
const imageUrls = import.meta.glob<string>('../../skins/*/*.png', { eager: true, query: '?url', import: 'default' });

function withImages(path: string, def: SkinDef): SkinDef {
  const dir = path.slice(0, path.lastIndexOf('/') + 1);
  const motions = Object.fromEntries(Object.entries(def.motions ?? {}).map(([name, motion]) => {
    const src = imageUrls[dir + motion.src];
    if (!src) throw new Error(`皮肤 ${def.id} 缺少动作原画 ${motion.src}`);
    return [name, { ...motion, src }];
  }));
  return { ...def, motions, parts: def.parts.map((p) => {
    if (!p.image) return p;
    const src = imageUrls[dir + p.image.src];
    if (!src) throw new Error(`皮肤 ${def.id} 缺少原画 ${p.image.src}`);
    return { ...p, image: { ...p.image, src } };
  }) };
}

/** skins/<目录>/clips/<名字>.gif → { 名字: 地址 } */
function clipsIn(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [path, url] of Object.entries(clipUrls)) {
    const m = /\/skins\/([^/]+)\/clips\/([^/]+)\.gif$/.exec(path);
    if (m && m[1] === dir) out[m[2]] = url;
  }
  return out;
}

/** 默认皮肤排第一，其余按名字排 */
export const SKINS: Skin[] = Object.entries(defs)
  .map(([path, def]) => ({ ...loadSkin(withImages(path, def)), clips: clipsIn(path.split('/').at(-2)!) }))
  .sort((a, b) => Number(b.id === DEFAULT_SKIN) - Number(a.id === DEFAULT_SKIN) || a.name.localeCompare(b.name));

/** 找不到（比如存的皮肤被删了）就退回默认皮肤 */
export function findSkin(id: unknown): Skin {
  return SKINS.find((s) => s.id === id) ?? SKINS.find((s) => s.id === DEFAULT_SKIN) ?? SKINS[0];
}

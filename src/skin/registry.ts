// 内置皮肤：skins/*/skin.json 会被自动收进来，加一个目录就多一个形象。
// 同目录 clips/ 下的 GIF 是这个形象的播片，文件名（不带扩展名）就是播片的名字。

import { type Skin, type SkinDef, loadSkin } from './types';

export const DEFAULT_SKIN = 'clawd';

const defs = import.meta.glob<SkinDef>('../../skins/*/skin.json', { eager: true, import: 'default' });
const clipUrls = import.meta.glob<string>('../../skins/*/clips/*.gif', { eager: true, query: '?url', import: 'default' });

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
  .map(([path, def]) => ({ ...loadSkin(def), clips: clipsIn(path.split('/').at(-2)!) }))
  .sort((a, b) => Number(b.id === DEFAULT_SKIN) - Number(a.id === DEFAULT_SKIN) || a.name.localeCompare(b.name));

/** 找不到（比如存的皮肤被删了）就退回默认皮肤 */
export function findSkin(id: unknown): Skin {
  return SKINS.find((s) => s.id === id) ?? SKINS.find((s) => s.id === DEFAULT_SKIN) ?? SKINS[0];
}

// 内置皮肤：skins/*/skin.json 会被自动收进来，加一个目录就多一个形象。

import { type Skin, type SkinDef, loadSkin } from './types';

export const DEFAULT_SKIN = 'clawd';

const defs = import.meta.glob<SkinDef>('../../skins/*/skin.json', { eager: true, import: 'default' });

/** 默认皮肤排第一，其余按名字排 */
export const SKINS: Skin[] = Object.values(defs)
  .map(loadSkin)
  .sort((a, b) => Number(b.id === DEFAULT_SKIN) - Number(a.id === DEFAULT_SKIN) || a.name.localeCompare(b.name));

/** 找不到（比如存的皮肤被删了）就退回默认皮肤 */
export function findSkin(id: unknown): Skin {
  return SKINS.find((s) => s.id === id) ?? SKINS.find((s) => s.id === DEFAULT_SKIN) ?? SKINS[0];
}

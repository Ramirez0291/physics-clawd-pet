// 所有"手感"参数集中在这里。调试面板根据 PARAM_DEFS 自动生成控件。
// 长度单位：逻辑像素 (CSS px)；时间单位：秒；速度：px/s。

export const DEFAULT_TUNING = {
  // 时间
  timeScale: 1,

  // 重力与空气
  gravity: 2600,
  fallGravityMul: 1.35,
  apexSpeed: 220,
  apexGravityMul: 0.45,
  airDrag: 0.12,
  maxSpeed: 6500,

  // 投掷
  throwWindowMs: 80,
  throwMul: 0.95,
  maxThrowSpeed: 5200,
  throwSpin: 0.0035,
  angularDrag: 0.5,
  airRighting: 7,
  rightingDistance: 240,

  // 抓取（钟摆）
  holdPendulumLength: 80,
  holdDamping: 3,
  holdAccelInfluence: 1,
  holdStretch: 0.08,
  dizzySpin: 14,

  // 落地
  bounceSpeed: 650,
  floorRestitution: 0.38,
  floorFriction: 0.7,
  rollSpeed: 850,
  rollBias: 0.55,
  rollFriction: 1300,
  rollEndSpeed: 170,
  rollPopHop: 700,
  heroSpeed: 1900,
  splatSpeed: 3300,
  softLandHold: 0.2,
  heroHold: 0.75,
  splatHold: 1.3,

  // 墙与天花板
  wallClingSpeed: 1500,
  ceilingClingSpeed: 1250,
  wallRestitution: 0.45,
  clingHold: 0.45,
  climbSpeed: 110,
  wallJumpSpeed: 950,
  surfaceStayMin: 3,
  surfaceStayMax: 9,

  // 顿帧
  hitstopHero: 0.09,
  hitstopSplat: 0.14,
  hitstopCling: 0.07,

  // 形变
  stretchPerSpeed: 0.00012,
  maxStretch: 0.45,
  squashStiffness: 520,
  squashDamping: 15,
  impactSquash: 0.00022,
  maxSquash: 0.6,
  snapSmoothing: 16,

  // 行为
  walkSpeed: 70,
  idleMin: 1.5,
  idleMax: 5,
  walkMin: 1.5,
  walkMax: 4,
  climbChance: 0.5,
  ceilingChance: 0.4,

  // 外观
  petScale: 6,
  artRes: 3,
  trail: 1,
  trailSpeed: 1400,
  particles: 1,
  hitPadding: 8,
  idleFps: 30,

  // 调试显示
  showHitbox: 0,
  showVelocity: 0,
};

export type Tuning = typeof DEFAULT_TUNING;
export type TuningKey = keyof Tuning;

export interface ParamDef {
  key: TuningKey;
  label: string;
  group: string;
  min: number;
  max: number;
  step: number;
  kind?: 'range' | 'bool';
  hint?: string;
}

const r = (
  group: string,
  key: TuningKey,
  label: string,
  min: number,
  max: number,
  step: number,
  hint?: string,
): ParamDef => ({ group, key, label, min, max, step, hint });
const b = (group: string, key: TuningKey, label: string, hint?: string): ParamDef => ({
  group,
  key,
  label,
  min: 0,
  max: 1,
  step: 1,
  kind: 'bool',
  hint,
});

export const PARAM_DEFS: ParamDef[] = [
  r('时间', 'timeScale', '时间流速', 0.05, 2, 0.05, '慢动作调手感用'),

  r('重力与空气', 'gravity', '重力', 200, 8000, 50),
  r('重力与空气', 'fallGravityMul', '下落重力倍率', 1, 3, 0.05, '下落比上升更快，更干脆'),
  r('重力与空气', 'apexSpeed', '顶点判定速度', 0, 800, 10, '|vy| 低于此值视为在最高点'),
  r('重力与空气', 'apexGravityMul', '顶点重力倍率', 0.05, 1, 0.05, '越小滞空越久'),
  r('重力与空气', 'airDrag', '空气阻力', 0, 3, 0.01),
  r('重力与空气', 'maxSpeed', '最大速度', 1000, 15000, 100),

  r('投掷', 'throwWindowMs', '甩出采样窗口(ms)', 16, 250, 4, '松手前多久的鼠标轨迹用来算速度'),
  r('投掷', 'throwMul', '甩出力度倍率', 0.2, 3, 0.05),
  r('投掷', 'maxThrowSpeed', '甩出速度上限', 500, 12000, 100),
  r('投掷', 'throwSpin', '水平速度→自转', 0, 0.02, 0.0005),
  r('投掷', 'angularDrag', '自转阻尼', 0, 5, 0.05),
  r('投掷', 'airRighting', '空中摆正速度', 0, 30, 0.5, '接近地面时自动转正'),
  r('投掷', 'rightingDistance', '摆正触发距离', 0, 800, 10),

  r('抓取', 'holdPendulumLength', '钟摆长度', 10, 400, 5, '越长摆得越慢越大'),
  r('抓取', 'holdDamping', '钟摆阻尼', 0, 20, 0.1),
  r('抓取', 'holdAccelInfluence', '鼠标加速度影响', 0, 3, 0.05),
  r('抓取', 'holdStretch', '被拎起拉长', 0, 0.4, 0.01),
  r('抓取', 'dizzySpin', '甩晕阈值(rad/s)', 2, 40, 0.5, '摆动角速度超过它会积累眩晕'),

  r('落地', 'bounceSpeed', '弹跳最低速度', 0, 3000, 10),
  r('落地', 'floorRestitution', '地面弹性', 0, 0.95, 0.01),
  r('落地', 'floorFriction', '弹跳水平保留', 0, 1, 0.01),
  r('落地', 'rollSpeed', '翻滚最低水平速度', 100, 4000, 10, '成龙式翻滚'),
  r('落地', 'rollBias', '翻滚优先度', 0, 2, 0.05, '|vx| ≥ 冲击速度×此值时优先翻滚'),
  r('落地', 'rollFriction', '翻滚摩擦', 100, 6000, 50),
  r('落地', 'rollEndSpeed', '翻滚结束速度', 20, 800, 10),
  r('落地', 'rollPopHop', '翻滚收尾弹起', 0, 2000, 10),
  r('落地', 'heroSpeed', '超级英雄落地速度', 500, 6000, 50),
  r('落地', 'splatSpeed', '脸着地速度', 1000, 10000, 50),
  r('落地', 'softLandHold', '普通落地硬直', 0, 1, 0.01),
  r('落地', 'heroHold', '英雄落地停留', 0, 3, 0.05),
  r('落地', 'splatHold', '脸着地停留', 0, 4, 0.05),

  r('墙与天花板', 'wallClingSpeed', '贴墙最低速度', 100, 6000, 50, '蜘蛛侠'),
  r('墙与天花板', 'ceilingClingSpeed', '贴天花板最低速度', 100, 6000, 50),
  r('墙与天花板', 'wallRestitution', '墙面弹性', 0, 0.95, 0.01),
  r('墙与天花板', 'clingHold', '贴住后停顿', 0, 2, 0.05),
  r('墙与天花板', 'climbSpeed', '爬行速度', 10, 600, 5),
  r('墙与天花板', 'wallJumpSpeed', '蹬墙跳速度', 100, 3000, 25),
  r('墙与天花板', 'surfaceStayMin', '墙上最短停留', 0, 30, 0.5),
  r('墙与天花板', 'surfaceStayMax', '墙上最长停留', 0, 60, 0.5),

  r('顿帧', 'hitstopHero', '英雄落地顿帧', 0, 0.4, 0.005),
  r('顿帧', 'hitstopSplat', '脸着地顿帧', 0, 0.4, 0.005),
  r('顿帧', 'hitstopCling', '贴墙顿帧', 0, 0.4, 0.005),

  r('形变', 'stretchPerSpeed', '速度→拉伸', 0, 0.0006, 0.00001),
  r('形变', 'maxStretch', '最大拉伸', 0, 1, 0.01),
  r('形变', 'squashStiffness', '果冻弹簧刚度', 50, 2000, 10),
  r('形变', 'squashDamping', '果冻弹簧阻尼', 0, 60, 0.5),
  r('形变', 'impactSquash', '冲击→压扁', 0, 0.001, 0.00001),
  r('形变', 'maxSquash', '最大压扁', 0, 0.9, 0.01),
  r('形变', 'snapSmoothing', '转角过渡速度', 1, 60, 1),

  r('行为', 'walkSpeed', '走路速度', 0, 400, 5),
  r('行为', 'idleMin', '发呆最短', 0, 20, 0.5),
  r('行为', 'idleMax', '发呆最长', 0, 30, 0.5),
  r('行为', 'walkMin', '走路最短', 0, 20, 0.5),
  r('行为', 'walkMax', '走路最长', 0, 30, 0.5),
  r('行为', 'climbChance', '走到墙角爬墙概率', 0, 1, 0.05),
  r('行为', 'ceilingChance', '爬到顶上天花板概率', 0, 1, 0.05),

  r('外观', 'petScale', '大小(px/格)', 2, 16, 0.5),
  r('外观', 'artRes', '像素细分', 1, 4, 1, '旋转时的像素精度，1 最粗犷'),
  b('外观', 'trail', '残影'),
  r('外观', 'trailSpeed', '残影触发速度', 200, 6000, 50),
  b('外观', 'particles', '粒子（烟尘/星星）'),
  r('外观', 'hitPadding', '可点击范围外扩', 0, 40, 1),
  r('外观', 'idleFps', '平静时帧率', 5, 120, 1, '只在发呆/走路时降帧省电；一动起来就满帧'),

  b('调试显示', 'showHitbox', '显示碰撞盒/状态'),
  b('调试显示', 'showVelocity', '显示速度向量'),
];

export function mergeTuning(base: Tuning, patch: Partial<Record<string, unknown>> | null | undefined): Tuning {
  const out = { ...base };
  if (!patch) return out;
  for (const key of Object.keys(base) as TuningKey[]) {
    const v = patch[key];
    if (typeof v === 'number' && Number.isFinite(v)) out[key] = v;
  }
  return out;
}

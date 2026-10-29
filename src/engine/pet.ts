import {
  type Vec2,
  TAU,
  approach,
  clamp,
  len,
  nearestEquivalent,
  rand,
  wrapAngle,
} from './math';
import { type Tuning, cellSize } from './params';
import {
  type Bounds,
  type Seg,
  type Side,
  type World,
  buildWorld,
  ceilingAbove,
  floorBelow,
  keepInside,
  nearestScreen,
  nearestSeg,
  screenAt,
  segDistance,
} from './world';

export type { Bounds, Side } from './world';

/** 一段可以站的窗口顶边（覆盖层 CSS 像素）。单向平台：只能从上面落上去。 */
export interface Platform {
  /** 窗口句柄 */
  id: number;
  x0: number;
  x1: number;
  y: number;
}

export type Mode =
  | 'idle' // 站着
  | 'walk' // 沿当前面走/爬
  | 'held' // 被鼠标拎着
  | 'air' // 飞行中
  | 'land' // 普通落地硬直
  | 'roll' // 翻滚
  | 'hero' // 超级英雄落地
  | 'splat' // 脸着地
  | 'cling' // 蜘蛛侠式贴墙/天花板的瞬间
  | 'petted' // 被摸头
  | 'laptop' // 掏出笔记本敲代码
  | 'stocks' // 掏出笔记本炒股
  | 'coin' // 掏出 token 金币吃掉
  | 'shake' // 抖毛（毛茸茸的皮肤专属）
  | 'chime' // 整点报时：举着铃铛摇，几点摇几下
  | 'stretch' // 提醒休息：伸个大懒腰
  | 'sign' // 日程/待办：跑到屏幕中间举牌子
  | 'zap' // Claude Code 出错：被电得直哆嗦，然后摔倒
  | 'knock' // Claude Code 等你批准：跑到终端窗口上跺脚
  | 'sweep' // Claude Code 压缩上下文：拿扫帚扫地
  | 'magic' // 万圣节彩蛋：戴上魔法帽，掏出魔杖放激光
  | 'clip'; // 播片：一段画好的 GIF 顶替程序化的样子（见 render/clips.ts）

/** 发呆时会随机做的小动作。皮肤在 skin.json 的 actions 里挑自己会做哪些。 */
export type Activity = 'laptop' | 'stocks' | 'coin' | 'shake';
export const ACTIVITIES: readonly Activity[] = ['laptop', 'stocks', 'coin', 'shake'];
/** 皮肤没写 actions 时会做的 */
export const DEFAULT_ACTIVITIES: readonly Activity[] = ['laptop', 'stocks', 'coin'];
/** 随机挑小动作时的权重 */
const ACTIVITY_WEIGHT: Record<Activity, number> = { laptop: 0.4, stocks: 0.3, coin: 0.3, shake: 0.3 };

/** 玩电脑类的小动作（电脑摆在 dir 那一侧的地上） */
export const LAPTOP_MODES: ReadonlySet<Mode> = new Set(['laptop', 'stocks']);
/** 抖毛：时长，以及抖掉毛团的时刻（秒） */
export const SHAKE_TIME = 1.6;
const SHAKE_PUFFS = [0.35, 0.6, 0.85, 1.1];
/** 吃TOKEN的时间轴（秒）：掏出 → 举起欣赏 → 三口吃掉 → 回味 */
export const COIN_TIME = 3.3;
export const COIN_BITES = [1.35, 1.8, 2.25];
/** 股价历史长度（= 屏幕上的 K 线列数） */
export const STOCK_LEN = 20;

/** 提醒动作（小助手、Claude Code 联动触发的，任何皮肤都会） */
export type Cue = 'chime' | 'stretch' | 'sign' | 'celebrate' | 'zap' | 'knock' | 'magic';
export const CUES: readonly Cue[] = ['chime', 'stretch', 'sign', 'celebrate', 'zap', 'knock', 'magic'];
/** Claude Code 正在干什么：宠物据此决定发呆时做什么（思考 = 原地发呆冒省略号，干活 = 敲电脑，压缩 = 扫地） */
export type AgentMood = 'idle' | 'thinking' | 'working' | 'compacting';
/** 举的牌子上画什么：日历 / 待办清单 */
export type SignKind = 'event' | 'todo';
/** 报时：举起铃铛的时间，以及每一下的间隔（秒） */
export const CHIME_LEAD = 0.5;
export const CHIME_GAP = 0.45;
/** 伸懒腰：总时长，以及松劲的时刻 */
export const STRETCH_TIME = 3.2;
export const STRETCH_RELEASE = 2.3;
/** 举牌子举多久 */
export const SIGN_TIME = 6;
/** 跑去屏幕中间最多跑这么久，到不了就原地举 */
const SEEK_TIMEOUT = 8;
/** 被电：哆嗦多久，期间每隔多久冒一个火花 */
export const ZAP_TIME = 1.1;
const ZAP_SPARK = 0.07;
/** 跺脚：总时长和每一脚的时刻 */
export const KNOCK_TIME = 2.4;
export const KNOCK_BEATS = [0.35, 0.7, 1.05, 1.5, 1.85];
/** 扫地：一扫的时长 */
export const SWEEP_STROKE = 0.55;
/**
 * 魔法的时间轴（秒）：帽子掉到头上（到 HAT）→ 掏出魔杖（到 DRAW）→ 前摇：魔杖举过头顶来回抡、
 * 杖尖聚能，最后 THRUST 秒往前一戳（到 FIRE）→ 放激光（到 FIRE_END）→ 得意一下，
 * 收起魔杖（最后 STOW 秒），帽子"噗"地消失
 */
export const MAGIC_HAT = 0.4;
export const MAGIC_DRAW = 0.8;
export const MAGIC_THRUST = 0.15;
export const MAGIC_FIRE = 1.95;
export const MAGIC_FIRE_END = 3.35;
export const MAGIC_STOW = 0.35;
export const MAGIC_TIME = 4.2;
/** 激光从杖尖射到目标要多久；射到的那一下炸一次 */
export const MAGIC_GROW = 0.1;
/** 激光打中的地方每隔多久冒一把火花；前摇时每隔多久往杖尖聚一把光点 */
const MAGIC_SPARK = 0.05;
const MAGIC_CHARGE = 0.035;
/** 魔杖能指的角度范围（弧度，0 = 水平朝前，负的往上） */
const AIM_UP = -1.1;
const AIM_DOWN = 0.3;
/** 没有可瞄的光标时：稍微往上斜着射 */
const AIM_DEFAULT = -0.15;
/** 前摇：魔杖在头顶上来回抡（中心略往后仰），每秒抡几个来回 */
const SWIRL_CENTER = -1.9;
const SWIRL_AMP = 0.7;
const SWIRL_RATE = 2.2;

/** 前摇时握魔杖的手抬高几格：抬起来抡，往前一戳时放下来 */
export function wandLift(tm: number): number {
  const up = clamp((tm - MAGIC_DRAW) / 0.25, 0, 1);
  const down = clamp((tm - (MAGIC_FIRE - MAGIC_THRUST)) / MAGIC_THRUST, 0, 1);
  return 2.5 * up * (1 - down);
}

/**
 * 魔杖：握在 dir 那侧的手里（手在身体外侧、半身高，前摇时抬高 lift 格），杖身长 14 道具像素，指向 aim。
 * 返回道具像素坐标（1/3 格，相对网格左上角）：握手处 h 和杖尖 t。姿势和激光都按这个算。
 */
export function wandGeom(grid: readonly [number, number], dir: 1 | -1, aim: number, lift = 0) {
  const hx = (grid[0] / 2 + dir * (grid[0] / 2 + 0.2)) * 3;
  const hy = (grid[1] * 0.45 - lift) * 3;
  const L = 14;
  return { hx, hy, tx: hx + dir * Math.cos(aim) * L, ty: hy + Math.sin(aim) * L };
}

/** 跟着 Claude Code 干活的小动作，时长先设成"一直"，Claude 收工时再收尾 */
const UNTIL_DONE = 1e6;

export type ImpactTier = 'soft' | 'bounce' | 'roll' | 'hero' | 'splat' | 'wall' | 'cling';

export type PetEvent =
  | { type: 'impact'; tier: ImpactTier; x: number; y: number; nx: number; ny: number; speed: number }
  | { type: 'rolling'; x: number; y: number; vx: number }
  | { type: 'grab' }
  | { type: 'throw'; vx: number; vy: number }
  | { type: 'poke' }
  | { type: 'popup' }
  | { type: 'leap' }
  | { type: 'fling'; x: number; y: number; vx: number; vy: number }
  | { type: 'dropped' }
  | { type: 'heart'; x: number; y: number; nx: number; ny: number }
  | { type: 'chomp'; x: number; y: number; nx: number; ny: number }
  | { type: 'fluff'; x: number; y: number; nx: number; ny: number }
  | { type: 'ding'; x: number; y: number; nx: number; ny: number }
  | { type: 'confetti'; x: number; y: number; nx: number; ny: number }
  | { type: 'spark'; x: number; y: number }
  | { type: 'smoke'; x: number; y: number }
  | { type: 'sweep'; x: number; y: number; dir: number }
  | { type: 'poof'; x: number; y: number }
  | { type: 'magic'; x: number; y: number }
  | { type: 'charge'; x: number; y: number }
  | { type: 'boom'; x: number; y: number; big: boolean };

/** 一次投掷的初始条件，用于"重放上次投掷"做 A/B 对比 */
export interface LaunchState {
  x: number;
  y: number;
  vx: number;
  vy: number;
  rot: number;
  angVel: number;
}

/** 各个面上"站正"时的旋转角（y 轴向下，正角度=顺时针） */
export const UPRIGHT: Record<Side, number> = {
  floor: 0,
  ceiling: Math.PI,
  left: Math.PI / 2,
  right: -Math.PI / 2,
};

/** 各个面指向屏幕内部的法线 */
export const NORMAL: Record<Side, Vec2> = {
  floor: { x: 0, y: -1 },
  ceiling: { x: 0, y: 1 },
  left: { x: 1, y: 0 },
  right: { x: -1, y: 0 },
};

const GROUNDED: ReadonlySet<Mode> = new Set([
  'idle',
  'walk',
  'land',
  'hero',
  'splat',
  'cling',
  'roll',
  'petted',
  'laptop',
  'stocks',
  'coin',
  'shake',
  'chime',
  'stretch',
  'sign',
  'zap',
  'knock',
  'sweep',
  'clip',
  'magic',
]);
/** 这些状态下光标在头顶来回蹭就算摸摸 */
const RUBBABLE: ReadonlySet<Mode> = new Set(['idle', 'walk', 'land', 'petted', 'laptop', 'stocks', 'coin', 'shake']);
/** 这些状态下挡住输入框会主动让开 */
const AVOIDING: ReadonlySet<Mode> = new Set([
  'idle',
  'walk',
  'laptop',
  'stocks',
  'coin',
  'shake',
  'chime',
  'stretch',
  'sign',
  'sweep',
]);
/** 这些状态可以马上被提醒动作打断；其他状态（飞着、被拎着、落地硬直）等站稳了再做 */
const CUEABLE: ReadonlySet<Mode> = new Set([
  'idle',
  'walk',
  'petted',
  'laptop',
  'stocks',
  'coin',
  'shake',
  'chime',
  'stretch',
  'sign',
  'knock',
  'sweep',
]);

interface Hold {
  /** 抓取点相对身体中心的偏移（宠物本地坐标、未旋转，单位 px） */
  gx: number;
  gy: number;
  /** 钟摆平衡时宠物的旋转角：抓腿会倒挂，抓手臂会侧挂 */
  restRot: number;
  phi: number;
  omega: number;
  pivot: Vec2;
  targetVel: Vec2;
  vel: Vec2;
  acc: Vec2;
  wasOn: Side | null;
}

export class Pet {
  mode: Mode = 'air';
  side: Side = 'floor';
  modeTime = 0;
  modeDuration = 0;
  /** 模拟时间（顿帧时冻结） */
  t = 0;

  pos: Vec2 = { x: 0, y: 0 };
  vel: Vec2 = { x: 0, y: 0 };
  rot = 0;
  angVel = 0;
  dir: 1 | -1 = 1;

  /** 果冻弹簧：>0 沿法线压扁，<0 拉长 */
  squash = 0;
  squashVel = 0;
  /** 压扁方向（世界坐标角度） */
  squashAngle = -Math.PI / 2;

  hitstop = 0;
  /** 瞬移（转角、贴墙吸附）后，用视觉偏移平滑过渡 */
  visOffset: Vec2 = { x: 0, y: 0 };
  visRot = 0;

  surfaceTime = 0;
  surfaceStay = 0;
  dizzy = 0;
  taDa = 0;
  private pendingTaDa = false;
  emote: { kind: '!'; t: number } | null = null;

  cursor: Vec2 | null = null;
  lastImpact: { tier: ImpactTier; speed: number } | null = null;
  lastLaunch: LaunchState | null = null;
  events: PetEvent[] = [];

  /** 屏幕拼成的世界（一块或几块屏幕） */
  world: World;
  /** 正贴着哪段屏幕边框（站在窗口顶上、飞着、被拎着时为 null） */
  seg: Seg | null = null;
  /** 所有可站的窗口顶边 */
  platforms: Platform[] = [];
  /** 正站在哪段窗口顶边上（null = 屏幕边框） */
  support: Platform | null = null;
  /** 被追踪窗口（通常就是脚下那个）的最新位置和速度 */
  carrier = { id: NaN, left: NaN, top: NaN, vx: 0, vy: 0 };
  /** 站在移动窗口上时宠物自己的速度：靠"抓地力"追赶窗口速度，追不上就被甩飞 */
  carryVel: Vec2 = { x: 0, y: 0 };
  /** 惯性后仰（弧度，绕脚底） */
  lean = 0;

  /** 正在输入的输入框（覆盖层 CSS 像素），null = 没有 */
  inputZone: Bounds | null = null;
  /** 正在给输入框让路：走得快，到空地才停 */
  fleeing = false;
  private fleeTime = 0;
  private fleeAgainAt = 0;

  /** 炒股：最近的股价（0..1），最后一个是现在 */
  stock: number[] = [];
  /** 心情：>0 刚涨了，<0 刚跌了 */
  stockMood = 0;
  private stockTick = 0;
  /** 吃TOKEN：已经咬了几口；报时：已经摇了几下 */
  bites = 0;
  /** 报时：一共要摇几下 */
  chimes = 0;
  signKind: SignKind = 'event';
  /** 等着做的提醒动作（被拎着、在天上飞的时候先记下，站稳了再做） */
  pendingCue: { kind: Cue; count: number; sign: SignKind; target: number | null } | null = null;
  /** 正跑去屏幕中间举牌子 */
  seeking = false;
  /** 头顶有提醒气泡等人回应：待在原地，不自己溜达、玩电脑、跳窗口 */
  attentive = false;
  /** Claude Code 正在干什么（见 setAgentMood） */
  agentMood: AgentMood = 'idle';
  /** 正在播的片（mode 为 'clip' 时有效） */
  clip: string | null = null;
  /** 魔法：魔杖指的角度（见 wandGeom），以及激光打到哪儿（没在放激光为 null） */
  aim = 0;
  beamEnd: Vec2 | null = null;
  /** 魔法进行到哪一步了（0 开始 → 1 帽子落下 → 2 开火 → 3 激光打中 → 4 收尾那一炸），以及冒了几把火花/光点 */
  private magicStage = 0;
  private magicSparks = 0;
  private magicCharges = 0;
  private seekTime = 0;
  /** 摸摸：光标在头顶的移动记录 */
  private rub = { x: NaN, y: NaN, dir: 0, flips: [] as number[], lastAt: -Infinity, heart: 0 };

  private hold: Hold | null = null;
  private rollDust = 0;
  /** 设备像素比：决定实际画出来的格子大小 */
  private pixelRatio = 1;
  /** 像素画风的皮肤：格子大小要对齐整数设备像素 */
  private pixelArt = true;
  /** 当前皮肤会做的小动作 */
  actions: ReadonlySet<Activity> = new Set(DEFAULT_ACTIVITIES);

  constructor(
    public tuning: Tuning,
    public grid: [number, number],
    /** 一块屏幕，或者几块屏幕的工作区 */
    screens: Bounds | Bounds[],
    private rng: () => number = Math.random,
  ) {
    this.world = buildWorld(Array.isArray(screens) ? screens : [screens]);
  }

  // ---------- 尺寸 ----------

  /** 一个皮肤格子的边长（CSS 像素），与渲染器画出来的一致 */
  get cell() {
    return cellSize(this.tuning, this.pixelRatio, this.pixelArt);
  }
  get halfW() {
    return (this.grid[0] * this.cell) / 2;
  }
  get halfH() {
    return (this.grid[1] * this.cell) / 2;
  }
  get rollRadius() {
    return this.halfH * 0.9;
  }
  get grounded() {
    return GROUNDED.has(this.mode);
  }
  get holdPivot(): Vec2 | null {
    return this.hold ? this.hold.pivot : null;
  }
  get holdVel(): Vec2 | null {
    return this.hold ? this.hold.vel : null;
  }

  get screens(): readonly Bounds[] {
    return this.world.screens;
  }

  /** 宠物现在在哪块屏幕上（中心不在任何屏幕里时取最近的那块） */
  get screen(): Bounds {
    const { x, y } = this.pos;
    return screenAt(this.world, x, y) ?? nearestScreen(this.world, x, y);
  }

  // ---------- 外部控制 ----------

  /** 只有一块屏幕 */
  setBounds(b: Bounds) {
    this.setScreens([b]);
  }

  /** 屏幕（工作区）变了：插拔显示器、改排列、某块屏幕被全屏程序占了 */
  setScreens(list: Bounds[]) {
    if (list.length) this.setWorld(buildWorld(list));
  }

  /** 迷你 Clawd 和主宠物共用同一个世界 */
  setWorld(w: World) {
    if (w === this.world || !w.screens.length) return;
    this.world = w;
    this.seg = null;
    this.resnap();
  }

  /**
   * 覆盖层挪了位置或者换了缩放，同一个屏幕上的点 CSS 坐标变了：old → old·k + (dx, dy)。
   * 之后马上会用新坐标的屏幕列表调 setScreens。
   */
  remap(k: number, dx: number, dy: number) {
    const mx = (x: number) => x * k + dx;
    const my = (y: number) => y * k + dy;
    const mp = (p: Platform): Platform => ({ ...p, x0: mx(p.x0), x1: mx(p.x1), y: my(p.y) });
    this.pos = { x: mx(this.pos.x), y: my(this.pos.y) };
    this.vel = { x: this.vel.x * k, y: this.vel.y * k };
    this.carryVel = { x: this.carryVel.x * k, y: this.carryVel.y * k };
    if (this.hold) this.hold.pivot = { x: mx(this.hold.pivot.x), y: my(this.hold.pivot.y) };
    this.platforms = this.platforms.map(mp);
    if (this.support) this.support = mp(this.support);
    const z = this.inputZone;
    if (z) this.inputZone = { left: mx(z.left), top: my(z.top), right: mx(z.right), bottom: my(z.bottom) };
    this.resetCarrier();
    this.rub.x = NaN;
    this.seg = null;
  }

  setTuning(t: Tuning) {
    const before = this.cell;
    this.tuning = t;
    if (this.cell !== before) this.resnap();
  }

  /** 换皮肤：碰撞盒跟着网格大小变 */
  setGrid(grid: [number, number], opts: { pixelArt?: boolean; actions?: readonly Activity[] } = {}) {
    this.grid = grid;
    this.pixelArt = opts.pixelArt ?? true;
    this.actions = new Set(opts.actions ?? DEFAULT_ACTIVITIES);
    // 正在做新皮肤不会的小动作：收手
    if ((ACTIVITIES as readonly Mode[]).includes(this.mode) && !this.actions.has(this.mode as Activity)) {
      this.setMode('idle', rand(this.tuning.idleMin, this.tuning.idleMax, this.rng));
    }
    this.resnap();
  }

  setPixelRatio(dpr: number) {
    const before = this.cell;
    this.pixelRatio = dpr;
    if (this.cell !== before) this.resnap();
  }

  /** 窗口顶边列表刷新（约 10Hz）。脚下那段没了（窗口关了/被挡住）就掉下去。 */
  setPlatforms(list: Platform[]) {
    this.platforms = list;
    const s = this.support;
    if (!s) return;
    const x = this.pos.x;
    const match = list.find((p) => p.id === s.id && x >= p.x0 - 2 && x <= p.x1 + 2 && Math.abs(p.y - s.y) < 60);
    if (!match) {
      this.loseSupport();
      return;
    }
    this.support = { ...match };
    if (this.side === 'floor' && this.grounded) {
      this.pos.y = match.y - (this.mode === 'roll' ? this.rollRadius : this.halfH);
    }
  }

  /**
   * 被追踪窗口的最新位置（左上角）和速度。每帧调用；位置没变就什么也不做。
   * 宠物站在上面时跟着平移；窗口顶边列表里属于它的几段也一起平移，
   * 这样在下一次列表刷新之前，被抛起的宠物也能落回正在移动的窗口上。
   */
  updateCarrier(id: number, left: number, top: number, vx: number, vy: number) {
    const c = this.carrier;
    const same = c.id === id && Number.isFinite(c.left);
    const dx = same ? left - c.left : 0;
    const dy = same ? top - c.top : 0;
    c.id = id;
    c.left = left;
    c.top = top;
    c.vx = vx;
    c.vy = vy;
    if (!dx && !dy) return;
    for (const p of this.platforms) {
      if (p.id !== id) continue;
      p.x0 += dx;
      p.x1 += dx;
      p.y += dy;
    }
    const s = this.support;
    if (s && s.id === id) {
      s.x0 += dx;
      s.x1 += dx;
      s.y += dy;
      if (this.grounded) {
        this.pos.x += dx;
        this.pos.y += dy;
      }
    }
  }

  /**
   * 开始追踪一个窗口之前调用：丢掉上一次追踪留下的位置。
   * 否则同一个窗口在没被追踪时挪过位置，下一次第一个采样会被当成一次瞬移。
   */
  resetCarrier() {
    this.carrier = { id: NaN, left: NaN, top: NaN, vx: 0, vy: 0 };
  }

  /** 被追踪的窗口消失了（关闭、最小化、切到别的虚拟桌面） */
  carrierGone(id: number) {
    this.platforms = this.platforms.filter((p) => p.id !== id);
    if (this.carrier.id === id) this.resetCarrier();
    if (this.support?.id === id) this.loseSupport();
  }

  /** 当前有键盘焦点的输入框（null = 没有）。宠物会尽量不挡住它。 */
  setInputZone(z: Bounds | null) {
    this.inputZone = z;
    this.fleeAgainAt = 0;
  }

  /** 调试用：马上做某个小动作。站在面上才行，返回是否成功。 */
  perform(m: 'petted' | Activity): boolean {
    if (!RUBBABLE.has(this.mode)) return false;
    if (m === 'petted') {
      this.startPetted();
      this.rub.lastAt = this.t + 2;
      return true;
    }
    return this.startActivity(m);
  }

  /**
   * 提醒动作。count：报时摇几下；sign：牌子上画什么；target：跺脚要跑去的窗口（窗口句柄）。
   * 正在忙别的小动作会被打断；飞着、被拎着时先记下，站稳了再做。
   */
  cue(kind: Cue, opts: { count?: number; sign?: SignKind; target?: number | null } = {}) {
    this.pendingCue = {
      kind,
      count: Math.max(1, Math.min(12, opts.count ?? 3)),
      sign: opts.sign ?? 'event',
      target: opts.target ?? null,
    };
    this.seekTime = 0;
    if (CUEABLE.has(this.mode) && !this.fleeing) this.startCue();
  }

  /**
   * 播一段片（duration 秒），播完回到发呆。只在地上站着、没在忙提醒动作时播，返回是否播了。
   * 开头结尾各冒一团烟，盖住"换成另一套画"的那一下。
   */
  playClip(id: string, duration: number): boolean {
    if (this.side !== 'floor' || !CUEABLE.has(this.mode) || this.fleeing || this.pendingCue) return false;
    this.clip = id;
    this.setMode('clip', duration);
    this.poofBody();
    return true;
  }

  private poofBody() {
    this.events.push({ type: 'poof', x: this.pos.x, y: this.pos.y });
  }

  /**
   * Claude Code 的状态变了。发呆的时候按它来：干活就敲电脑、压缩就扫地、思考就原地等着。
   * 收工时把"一直做下去"的电脑/扫帚收起来。
   */
  setAgentMood(m: AgentMood) {
    if (m === this.agentMood) return;
    this.agentMood = m;
    if (this.modeDuration >= UNTIL_DONE) {
      if (this.mode === 'laptop' && m !== 'working') this.modeDuration = this.modeTime + 0.45;
      if (this.mode === 'sweep' && m !== 'compacting') this.setMode('idle', 0.3);
    }
    // 发呆、散步中：马上换成新状态该做的事
    if (m !== 'idle') {
      if (this.mode === 'idle') this.modeTime = Math.max(this.modeTime, this.modeDuration);
      else if (this.mode === 'walk' && !this.fleeing && !this.seeking) this.setMode('idle', 0);
    }
  }

  /** 发呆到点了、Claude Code 又在忙：跟着它做事 */
  private followMood() {
    if (this.side === 'floor' && this.agentMood === 'working' && this.startActivity('laptop')) {
      this.modeDuration = UNTIL_DONE;
      return;
    }
    if (this.side === 'floor' && this.agentMood === 'compacting') {
      this.bites = 0;
      this.dir = this.laptopSide();
      this.setMode('sweep', UNTIL_DONE);
      return;
    }
    // 在思考，或者在墙上做不了：原地等，过会儿再看
    this.modeDuration = this.modeTime + 0.5;
  }

  /** 尝试开始等着的提醒动作（举牌子、跺脚要先跑到地方）。返回 true 表示这一步已经处理了 */
  private startCue(): boolean {
    const c = this.pendingCue;
    if (!c) return false;
    switch (c.kind) {
      case 'chime':
      case 'stretch': {
        this.pendingCue = null;
        this.bites = 0;
        this.chimes = c.count;
        const duration = c.kind === 'chime' ? CHIME_LEAD + c.count * CHIME_GAP + 0.6 : STRETCH_TIME;
        this.setMode(c.kind, duration);
        return true;
      }
      case 'celebrate':
        this.pendingCue = null;
        this.celebrate();
        return true;
      case 'zap':
        this.pendingCue = null;
        this.bites = 0;
        this.setMode('zap', ZAP_TIME);
        this.emote = { kind: '!', t: 0 };
        return true;
      case 'magic':
        // 要站在地上施法：在墙上/天花板上先跳下来
        if (this.side !== 'floor') {
          this.leaveSurface();
          return true;
        }
        this.pendingCue = null;
        this.magicStage = 0;
        this.magicSparks = 0;
        this.magicCharges = 0;
        // 朝着光标那边；没有光标就朝空地多的那边
        this.dir = this.cursor ? (this.cursor.x >= this.pos.x ? 1 : -1) : this.laptopSide();
        this.aim = 1.2;
        this.beamEnd = null;
        this.setMode('magic', MAGIC_TIME);
        return true;
    }

    // 举牌子、跺脚：先跑到地方
    const timedOut = this.seekTime > SEEK_TIMEOUT;
    if (timedOut && this.side !== 'floor') {
      // 怎么都下不来（比如一直在躲输入框）：算了
      this.pendingCue = null;
      return false;
    }
    const target = c.kind === 'knock' ? this.knockTarget(c.target) : null;
    // 已经站在要敲的窗口上了 / 没有要去的窗口：原地跺
    if (c.kind === 'knock' && (!target || this.support?.id === target.id || timedOut)) {
      if (this.side !== 'floor' && !timedOut) {
        this.leaveSurface();
        return true;
      }
      return this.beginCueHere(c);
    }
    if (this.side !== 'floor') {
      // 在墙上/天花板上：先跳下来
      this.leaveSurface();
      return true;
    }
    const hw = this.halfW;
    let goal: number;
    if (target) {
      goal = clamp(this.pos.x, target.x0 + hw, target.x1 - hw);
    } else {
      const scr = this.screen;
      const center = (scr.left + scr.right) / 2;
      const [lo, hi] = this.sRange();
      goal = this.support ? center : clamp(center, lo, hi);
    }
    if (Math.abs(this.pos.x - goal) <= hw * 0.5 || timedOut) {
      if (target) {
        // 到窗口底下了：够得着就跳上去，够不着就在这儿跺
        const rise = this.pos.y + this.halfH - target.y;
        if (rise >= 40 && rise <= this.tuning.platformJumpMax * 1.3 && this.hasHeadroom(target)) {
          this.leapTo(target, goal);
          return true;
        }
      }
      return this.beginCueHere(c);
    }
    if (this.mode !== 'walk' || !this.seeking) {
      this.setMode('walk', 30);
      this.seeking = true;
    }
    this.dir = goal > this.pos.x ? 1 : -1;
    return false;
  }

  /** 要跺脚的那个窗口露在外面的顶边（有好几段就挑离宠物最近的），没有就 null */
  private knockTarget(id: number | null): Platform | null {
    if (id === null) return null;
    let best: Platform | null = null;
    for (const p of this.platforms) {
      if (p.id !== id || p.x1 - p.x0 < this.halfW * 2) continue;
      const d = Math.abs(clamp(this.pos.x, p.x0, p.x1) - this.pos.x);
      if (!best || d < Math.abs(clamp(this.pos.x, best.x0, best.x1) - this.pos.x)) best = p;
    }
    return best;
  }

  /** 到地方了：举牌子 / 跺脚 */
  private beginCueHere(c: NonNullable<Pet['pendingCue']>): boolean {
    this.pendingCue = null;
    this.seeking = false;
    this.bites = 0;
    if (c.kind === 'sign') {
      this.signKind = c.sign;
      this.setMode('sign', SIGN_TIME);
    } else {
      this.setMode('knock', KNOCK_TIME);
    }
    this.emote = { kind: '!', t: 0 };
    this.squashAngle = -Math.PI / 2;
    this.squash = Math.min(this.squash, -0.15);
    return true;
  }

  /** 庆祝：原地起跳翻一个后空翻，撒一把彩纸，落地摆 pose */
  private celebrate() {
    const T = this.tuning;
    const n = NORMAL[this.side];
    this.events.push({
      type: 'confetti',
      x: this.pos.x + n.x * this.halfH,
      y: this.pos.y + n.y * this.halfH,
      nx: n.x,
      ny: n.y,
    });
    if (this.side !== 'floor') {
      // 墙上翻不了跟头：举手欢呼一下
      this.taDa = 1;
      return;
    }
    const g = T.gravity;
    const h = this.halfH * 4.4;
    const vy = -Math.sqrt(2 * g * h);
    const air = this.airtime(vy, h);
    this.setMode('air');
    this.vel = { x: 0, y: vy };
    // 往后翻：朝向的反方向转一圈，落地前转完
    this.angVel = (-this.dir * TAU) / (air * 0.85);
    this.pendingTaDa = true;
    this.events.push({ type: 'leap' });
  }

  /** 以 vy 起跳、比起跳点高出 h 的顶点再落回原高度，大概要飞多久（算上顶点附近重力变小） */
  private airtime(vy: number, h: number): number {
    const T = this.tuning;
    const g = T.gravity;
    const tUp = -vy / g;
    const tApex = ((2 * T.apexSpeed) / g) * (1 / Math.max(0.05, T.apexGravityMul) - 1);
    const tDown = Math.sqrt((2 * h) / (g * T.fallGravityMul));
    return tUp + tApex + tDown;
  }

  private loseSupport() {
    this.setMode('air');
    this.vel = { x: 0, y: 0 };
    this.angVel = 0;
    this.emote = { kind: '!', t: 0 };
    this.events.push({ type: 'dropped' });
  }

  /** 尺寸或屏幕变化后，把宠物放回合法位置 */
  private resnap() {
    if (this.mode === 'held') return;
    const onScreenEdge = this.grounded && !(this.side === 'floor' && this.support);
    if (onScreenEdge && !(this.seg && this.world.segs.includes(this.seg))) {
      this.seg = this.findSeg(this.side);
      if (!this.seg) {
        // 脚下那段边框没了（显示器拔掉了、那块屏幕被全屏程序占了）：掉下去
        this.setMode('air');
        this.vel = { x: 0, y: 0 };
      }
    }
    if (this.grounded && this.mode !== 'roll') {
      this.attach(this.side, this.seg, undefined, { smooth: false });
    } else {
      this.pos = keepInside(this.world, this.pos, this.halfW, this.halfH);
    }
  }

  /** 贴着 side 这种面、离宠物最近的那段边框；离得太远就算没有 */
  private findSeg(side: Side): Seg | null {
    const n = NORMAL[side];
    // 宠物贴着面的那一点
    const px = this.pos.x - n.x * this.halfH;
    const py = this.pos.y - n.y * this.halfH;
    let best: Seg | null = null;
    let bestD = Infinity;
    for (const s of this.world.segs) {
      if (s.side !== side) continue;
      const d = segDistance(s, px, py);
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
    return bestD <= Math.max(this.halfW, this.halfH) * 2 ? best : null;
  }

  /** 放到 x 处的地面上：(x, y) 正下方那段地面，不给 y 就是 x 处最上面那段 */
  placeOnFloor(x: number, y = -Infinity) {
    this.hold = null;
    this.support = null;
    const seg = floorBelow(this.world, x, y) ?? this.world.segs.find((s) => s.side === 'floor') ?? null;
    if (!seg) return;
    this.side = 'floor';
    this.pos = { x, y: seg.c - this.halfH };
    this.attach('floor', seg, x, { smooth: false });
    this.setMode('idle', 1);
  }

  dropFrom(x: number, y: number) {
    this.launch({ x, y, vx: 0, vy: 0, rot: 0, angVel: 0 });
  }

  launch(s: LaunchState) {
    this.hold = null;
    this.hitstop = 0;
    this.pos = { x: s.x, y: s.y };
    this.vel = { x: s.vx, y: s.vy };
    this.rot = s.rot;
    this.angVel = s.angVel;
    this.visOffset = { x: 0, y: 0 };
    this.visRot = 0;
    this.squash = 0;
    this.squashVel = 0;
    this.setMode('air');
    this.lastLaunch = { ...s };
  }

  grab(x: number, y: number) {
    const wasOn = this.grounded ? this.side : null;
    const rot = this.rot + this.visRot;
    const cx = this.pos.x + this.visOffset.x;
    const cy = this.pos.y + this.visOffset.y;
    const dx = x - cx;
    const dy = y - cy;
    const c = Math.cos(-rot);
    const s = Math.sin(-rot);
    const gx = c * dx - s * dy;
    const gy = s * dx + c * dy;
    // 平衡角：让身体中心挂在抓取点正下方。抓在中心附近时就保持直立。
    const restRot = Math.hypot(gx, gy) < this.halfH * 0.35 ? 0 : -Math.PI / 2 - Math.atan2(gy, gx);
    let phi = wrapAngle(restRot - rot);
    // 正好在倒立平衡点上会一直立着不动，轻轻推一下
    if (Math.PI - Math.abs(phi) < 0.05) phi -= 0.05 * Math.sign(phi || 1);

    this.hold = {
      gx,
      gy,
      restRot,
      phi,
      omega: this.mode === 'air' ? -this.angVel : 0,
      pivot: { x, y },
      targetVel: { x: 0, y: 0 },
      vel: { x: 0, y: 0 },
      acc: { x: 0, y: 0 },
      wasOn,
    };
    this.pos = { x: cx, y: cy };
    this.rot = rot;
    this.visOffset = { x: 0, y: 0 };
    this.visRot = 0;
    this.vel = { x: 0, y: 0 };
    this.hitstop = 0;
    this.squash *= 0.5;
    this.setMode('held');
    this.emote = { kind: '!', t: 0 };
    this.events.push({ type: 'grab' });
  }

  /** 拖拽中：vx/vy 是鼠标的平滑速度，用来算钟摆受到的加速度 */
  moveHold(x: number, y: number, vx: number, vy: number) {
    if (!this.hold) return;
    this.hold.pivot = { x, y };
    this.hold.targetVel = { x: vx, y: vy };
  }

  /** 松手。isClick=true 表示只是点了一下（戳一戳）。 */
  release(vx: number, vy: number, isClick: boolean) {
    const h = this.hold;
    if (!h) return;
    this.hold = null;
    const T = this.tuning;

    if (isClick) {
      this.setMode('air');
      this.vel = h.wasOn === 'floor' ? { x: 0, y: -650 } : { x: 0, y: 0 };
      this.angVel = 0;
      this.clampInside();
      this.events.push({ type: 'poke' });
      return;
    }

    let tvx = vx * T.throwMul;
    let tvy = vy * T.throwMul;
    const sp = len(tvx, tvy);
    if (sp > T.maxThrowSpeed) {
      tvx *= T.maxThrowSpeed / sp;
      tvy *= T.maxThrowSpeed / sp;
    }
    // 摆动中的身体本身也有切向速度
    const w = -h.omega;
    const rx = this.pos.x - h.pivot.x;
    const ry = this.pos.y - h.pivot.y;
    tvx += -w * ry;
    tvy += w * rx;

    this.clampInside();
    const launch: LaunchState = {
      x: this.pos.x,
      y: this.pos.y,
      vx: tvx,
      vy: tvy,
      rot: this.rot,
      angVel: w + tvx * T.throwSpin,
    };
    this.launch(launch);
    this.events.push({ type: 'throw', vx: tvx, vy: tvy });
  }

  consumeEvents(): PetEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }

  // ---------- 模拟 ----------

  step(dt: number, cursor: Vec2 | null) {
    this.cursor = cursor;
    if (this.hitstop > 0) {
      this.hitstop -= dt;
      return;
    }
    const T = this.tuning;
    this.t += dt;
    this.modeTime += dt;

    if (this.emote) {
      this.emote.t += dt;
      if (this.emote.t > 0.8) this.emote = null;
    }
    if (this.taDa > 0) this.taDa -= dt;
    if (this.mode !== 'held' && this.dizzy > 0) this.dizzy = Math.max(0, this.dizzy - dt);

    // 果冻弹簧（半隐式欧拉）
    this.squashVel += (-T.squashStiffness * this.squash - T.squashDamping * this.squashVel) * dt;
    this.squash += this.squashVel * dt;

    const k = approach(T.snapSmoothing, dt);
    this.visOffset.x -= this.visOffset.x * k;
    this.visOffset.y -= this.visOffset.y * k;
    this.visRot -= this.visRot * k;

    const carried =
      this.support !== null && this.grounded && this.mode !== 'roll' && this.carrier.id === this.support.id;
    if (carried) {
      if (this.stepCarry(dt)) return;
    } else {
      this.lean -= this.lean * approach(10, dt);
    }

    this.senseRub();
    if (this.fleeing) {
      this.fleeTime += dt;
      // 怎么走都让不开（比如输入框特别大）：先放弃，过一会儿再试
      if (this.fleeTime > 10) {
        this.fleeing = false;
        this.fleeAgainAt = this.t + 5;
      }
    } else if (AVOIDING.has(this.mode) && this.t >= this.fleeAgainAt && this.blocksInput(this.pos.x, this.pos.y)) {
      this.flee();
    }

    switch (this.mode) {
      case 'held':
        this.stepHeld(dt);
        break;
      case 'air':
        this.stepAir(dt);
        break;
      case 'roll':
        this.stepRoll(dt);
        break;
      case 'idle':
      case 'walk':
        this.stepSurface(dt);
        break;
      case 'petted':
        this.stepPetted(dt);
        break;
      case 'laptop':
      case 'stocks':
      case 'coin':
      case 'shake':
        this.stepActivity(dt);
        break;
      case 'chime':
      case 'stretch':
      case 'sign':
      case 'zap':
      case 'knock':
        this.stepCue();
        break;
      case 'sweep':
        this.stepSweep();
        break;
      case 'magic':
        this.stepMagic(dt);
        break;
      case 'clip':
        if (this.modeTime >= this.modeDuration) this.setMode('idle', rand(this.tuning.idleMin, this.tuning.idleMax, this.rng));
        break;
      default:
        this.stepRecover();
    }
  }

  private setMode(m: Mode, duration = 0) {
    // 播完或者被打断（拎起来、被提醒动作叫走）：再冒一团烟换回来
    if (this.mode === 'clip' && m !== 'clip') this.poofBody();
    // 魔法收场（或者被拎走）：帽子"噗"地没了
    if (this.mode === 'magic' && m !== 'magic') {
      this.beamEnd = null;
      this.events.push({ type: 'poof', x: this.pos.x, y: this.pos.y - this.halfH });
    }
    this.mode = m;
    this.modeTime = 0;
    this.modeDuration = duration;
    if (m === 'air' || m === 'held') {
      this.support = null;
      this.seg = null;
    }
    if (m !== 'walk') {
      this.fleeing = false;
      this.seeking = false;
    }
  }

  /**
   * 站在移动的窗口上。宠物有自己的速度 carryVel：
   * - 竖直：重力往下拉，窗口顶着不让穿过去；窗口往下掉得比重力还快、或者往上提完急停，宠物就离开窗口；
   * - 水平：用有限的"抓地力"追赶窗口速度（起步时抓得牢，急停时抓不住），差太多就被甩飞。
   * 返回 true 表示被甩飞了。
   */
  private stepCarry(dt: number): boolean {
    const T = this.tuning;
    const c = this.carrier;
    const vp = this.carryVel;

    vp.y += T.gravity * dt;
    if (vp.y > c.vy) vp.y = c.vy;

    const sameDir = Math.sign(c.vx) === Math.sign(vp.x || c.vx);
    const speedingUp = sameDir && Math.abs(c.vx) > Math.abs(vp.x);
    const grip = (speedingUp ? T.gripStart : T.gripStop) * dt;
    vp.x += clamp(c.vx - vp.x, -grip, grip);

    const slip = Math.abs(c.vx - vp.x);
    const lift = c.vy - vp.y;
    if (slip > T.flingSlip || lift > T.flingLift) {
      const vx = vp.x * T.flingBoost;
      let vy = vp.y * T.flingBoost;
      if (slip > T.flingSlip) vy = Math.min(vy, -T.flingHop);
      const feet = { x: this.pos.x, y: this.pos.y + this.halfH };
      this.lean = 0;
      this.launch({ x: this.pos.x, y: this.pos.y, vx, vy, rot: this.rot, angVel: vx * T.throwSpin * 1.5 });
      this.emote = { kind: '!', t: 0 };
      this.events.push({ type: 'fling', x: feet.x, y: feet.y, vx, vy });
      return true;
    }

    // 相对窗口打滑
    this.pos.x += (vp.x - c.vx) * dt;
    // 窗口往右加速时脚被带走、身体往左仰（逆时针，负角度）
    this.lean = clamp(-(c.vx - vp.x) * T.carryLean, -0.6, 0.6);
    return false;
  }

  private stepHeld(dt: number) {
    const h = this.hold;
    if (!h) {
      this.setMode('air');
      return;
    }
    const T = this.tuning;
    // 鼠标速度 → 平滑 → 求加速度
    const a = approach(30, dt);
    const nvx = h.vel.x + (h.targetVel.x - h.vel.x) * a;
    const nvy = h.vel.y + (h.targetVel.y - h.vel.y) * a;
    const b = approach(20, dt);
    h.acc.x += ((nvx - h.vel.x) / dt - h.acc.x) * b;
    h.acc.y += ((nvy - h.vel.y) / dt - h.acc.y) * b;
    h.vel.x = nvx;
    h.vel.y = nvy;

    // 支点在加速的钟摆：φ'' = -((g - ay)·sinφ + ax·cosφ) / L
    const L = Math.max(1, T.holdPendulumLength);
    const ax = h.acc.x * T.holdAccelInfluence;
    const ay = h.acc.y * T.holdAccelInfluence;
    const phiAcc = -((T.gravity - ay) * Math.sin(h.phi) + ax * Math.cos(h.phi)) / L - T.holdDamping * h.omega;
    h.omega += phiAcc * dt;
    h.phi += h.omega * dt;
    if (Math.abs(h.omega) > T.dizzySpin) this.dizzy = Math.min(5, this.dizzy + dt * 1.5);

    this.rot = h.restRot - h.phi;
    const c = Math.cos(this.rot);
    const s = Math.sin(this.rot);
    this.pos.x = h.pivot.x - (c * h.gx - s * h.gy);
    this.pos.y = h.pivot.y - (s * h.gx + c * h.gy);
  }

  private stepAir(dt: number) {
    const T = this.tuning;
    let g = T.gravity;
    if (this.vel.y > 0) g *= T.fallGravityMul;
    if (Math.abs(this.vel.y) < T.apexSpeed) g *= T.apexGravityMul;
    this.vel.y += g * dt;

    const drag = Math.max(0, 1 - T.airDrag * dt);
    this.vel.x *= drag;
    this.vel.y *= drag;
    const sp = len(this.vel.x, this.vel.y);
    if (sp > T.maxSpeed) {
      this.vel.x *= T.maxSpeed / sp;
      this.vel.y *= T.maxSpeed / sp;
    }
    const prevX = this.pos.x;
    const prevY = this.pos.y;
    this.pos.x += this.vel.x * dt;
    this.pos.y += this.vel.y * dt;

    this.rot += this.angVel * dt;
    this.angVel *= Math.max(0, 1 - T.angularDrag * dt);

    // 快落地时像猫一样自动转正
    const toFloor = this.groundBelow() - (this.pos.y + this.halfH);
    if (this.vel.y > 0 && toFloor < T.rightingDistance) {
      const target = nearestEquivalent(this.rot, 0);
      const a = approach(T.airRighting, dt);
      this.rot += (target - this.rot) * a;
      this.angVel *= 1 - a;
    }

    this.collideAir(prevX, prevY);
    // 斜着穿过两块屏幕的拐角时可能落进屏幕之间的空当：拉回最近的那块屏幕
    if (this.mode === 'air' && !screenAt(this.world, this.pos.x, this.pos.y)) {
      this.pos = keepInside(this.world, this.pos, 0, 0);
    }
  }

  /** 正下方最近的落脚处（窗口顶边或屏幕底） */
  private groundBelow(): number {
    const feet = this.pos.y + this.halfH;
    let y = floorBelow(this.world, this.pos.x, this.pos.y)?.c ?? Infinity;
    for (const p of this.platforms) {
      if (p.y >= feet && p.y < y && this.pos.x >= p.x0 && this.pos.x <= p.x1) y = p.y;
    }
    return y;
  }

  /** 平台头顶要有足够空间站下宠物 */
  private hasHeadroom(p: Platform): boolean {
    const ceiling = ceilingAbove(this.world, clamp(this.pos.x, p.x0, p.x1), p.y);
    return !ceiling || p.y - ceiling.c >= this.halfH * 2;
  }

  /** prevX/prevY：这一步之前的位置。只和这一步之前还在里侧的边框比，一步飞太远也穿不过去 */
  private collideAir(prevX: number, prevY: number) {
    const w = this.world;
    // 旋转后的包围盒半宽/半高
    const c = Math.abs(Math.cos(this.rot));
    const s = Math.abs(Math.sin(this.rot));
    const ex = c * this.halfW + s * this.halfH;
    const ey = s * this.halfW + c * this.halfH;

    // 单向平台：只有下落、并且上一步还在顶边上方时才算落上去
    if (this.vel.y > 0 && this.platforms.length) {
      const before = prevY + ey;
      const after = this.pos.y + ey;
      let best: Platform | null = null;
      for (const p of this.platforms) {
        if (before > p.y + 0.5 || after < p.y) continue;
        if (this.pos.x < p.x0 || this.pos.x > p.x1 || !this.hasHeadroom(p)) continue;
        if (!best || p.y < best.y) best = p;
      }
      if (best) {
        this.pos.y = best.y - ey;
        this.hitFloor(best);
        return;
      }
    }

    // 屏幕边框：两块屏幕挨着的地方没有边框，直接穿过去
    const floor = nearestSeg(w, 'floor', this.pos.x, this.pos.y, prevY);
    if (floor && this.pos.y + ey >= floor.c && this.vel.y > 0) {
      this.pos.y = floor.c - ey;
      this.hitFloor(null, floor);
      return;
    }
    const ceiling = nearestSeg(w, 'ceiling', this.pos.x, this.pos.y, prevY);
    if (ceiling && this.pos.y - ey <= ceiling.c && this.vel.y < 0) {
      this.pos.y = ceiling.c + ey;
      this.hitCeiling(ceiling);
      if (this.mode !== 'air') return;
    }
    const left = nearestSeg(w, 'left', this.pos.x, this.pos.y, prevX);
    const right = nearestSeg(w, 'right', this.pos.x, this.pos.y, prevX);
    if (left && this.pos.x - ex <= left.c && this.vel.x < 0) {
      this.pos.x = left.c + ex;
      this.hitWall('left', left);
    } else if (right && this.pos.x + ex >= right.c && this.vel.x > 0) {
      this.pos.x = right.c - ex;
      this.hitWall('right', right);
    }
  }

  /** 落到屏幕底边（seg）或某个窗口顶边（p）上 */
  private hitFloor(p: Platform | null, seg: Seg | null = null) {
    const T = this.tuning;
    const impact = this.vel.y;
    const vx = this.vel.x;
    const floorY = p ? p.y : seg ? seg.c : this.floorY;
    const contact = { x: this.pos.x, y: floorY };
    const stand = (opts?: { keepRot?: boolean }) => {
      this.side = 'floor';
      this.support = p ? { ...p } : null;
      this.attach('floor', p ? null : seg, undefined, opts);
      const c = this.carrier;
      this.carryVel = p && c.id === p.id ? { x: c.vx, y: c.vy } : { x: 0, y: 0 };
    };

    if (impact >= T.splatSpeed) {
      stand();
      this.setMode('splat', T.splatHold);
      this.hitstop = T.hitstopSplat;
      this.dizzy = Math.max(this.dizzy, T.splatHold + 1.2);
      this.kickSquash(impact, 'floor');
      this.impact('splat', contact, NORMAL.floor, impact);
      return;
    }
    if (Math.abs(vx) >= T.rollSpeed && Math.abs(vx) >= impact * T.rollBias) {
      const rot = this.rot;
      stand({ keepRot: true });
      this.rot = rot;
      this.pos.y = floorY - this.rollRadius;
      this.vel.x = vx;
      this.setMode('roll');
      this.kickSquash(impact * 0.6, 'floor');
      this.impact('roll', contact, NORMAL.floor, Math.hypot(vx, impact));
      return;
    }
    if (impact >= T.heroSpeed) {
      stand();
      this.setMode('hero', T.heroHold);
      this.hitstop = T.hitstopHero;
      this.kickSquash(impact, 'floor');
      this.impact('hero', contact, NORMAL.floor, impact);
      return;
    }
    if (impact >= T.bounceSpeed) {
      const out = impact * T.floorRestitution;
      if (out > 120) {
        this.vel.y = -out;
        this.vel.x *= T.floorFriction;
        this.angVel *= 0.5;
        this.kickSquash(impact, 'floor');
        this.impact('bounce', contact, NORMAL.floor, impact);
        return;
      }
    }
    stand();
    this.setMode('land', T.softLandHold);
    this.kickSquash(impact, 'floor');
    this.impact('soft', contact, NORMAL.floor, impact);
    if (this.pendingTaDa) {
      this.pendingTaDa = false;
      this.taDa = 0.7;
    }
  }

  private hitCeiling(seg: Seg) {
    const T = this.tuning;
    const speed = -this.vel.y;
    const contact = { x: this.pos.x, y: seg.c };
    if (speed >= T.ceilingClingSpeed) {
      this.cling('ceiling', seg, speed, contact);
      return;
    }
    this.vel.y = speed * T.wallRestitution;
    this.kickSquash(speed, 'ceiling');
    this.impact('wall', contact, NORMAL.ceiling, speed);
  }

  private hitWall(side: 'left' | 'right', seg: Seg) {
    const T = this.tuning;
    const speed = Math.abs(this.vel.x);
    const contact = { x: seg.c, y: this.pos.y };
    if (speed >= T.wallClingSpeed) {
      this.cling(side, seg, speed, contact);
      return;
    }
    this.vel.x = -this.vel.x * T.wallRestitution;
    this.angVel = -this.angVel * 0.5;
    this.kickSquash(speed, side);
    this.impact('wall', contact, NORMAL[side], speed);
  }

  private cling(side: Side, seg: Seg, speed: number, contact: Vec2) {
    const T = this.tuning;
    this.attach(side, seg);
    this.setMode('cling', T.clingHold);
    this.hitstop = T.hitstopCling;
    this.kickSquash(speed, side);
    this.surfaceTime = 0;
    this.surfaceStay = rand(T.surfaceStayMin, Math.max(T.surfaceStayMin, T.surfaceStayMax), this.rng);
    this.dir = this.rng() < 0.5 ? 1 : -1;
    this.impact('cling', contact, NORMAL[side], speed);
  }

  private stepRoll(dt: number) {
    const T = this.tuning;
    const sign = this.vel.x >= 0 ? 1 : -1;
    const speed = Math.abs(this.vel.x) - T.rollFriction * dt;
    if (speed <= T.rollEndSpeed) {
      this.popUp();
      return;
    }
    this.vel.x = sign * speed;
    this.pos.x += this.vel.x * dt;
    this.rot += (this.vel.x / this.rollRadius) * dt;

    // 滚出窗口边缘、滚出屏幕的边沿（下面是另一块屏幕）：带着速度掉下去，继续转
    const sup = this.support;
    const seg = sup ? null : this.seg;
    const offLedge =
      seg !== null && ((this.pos.x < seg.a && !!seg.lo?.convex) || (this.pos.x > seg.b && !!seg.hi?.convex));
    if ((sup && (this.pos.x < sup.x0 || this.pos.x > sup.x1)) || offLedge) {
      const vx = this.vel.x;
      this.setMode('air');
      this.vel = { x: vx, y: 0 };
      this.angVel = vx / this.rollRadius;
      return;
    }

    const r = this.rollRadius;
    // 两头的墙：在屏幕边框上滚就是这段地面两头的墙角，在窗口上滚就找左右最近的墙
    let left: number;
    let right: number;
    if (seg) {
      left = seg.lo?.convex ? -Infinity : seg.a;
      right = seg.hi?.convex ? Infinity : seg.b;
    } else {
      left = nearestSeg(this.world, 'left', this.pos.x, this.pos.y)?.c ?? -Infinity;
      right = nearestSeg(this.world, 'right', this.pos.x, this.pos.y)?.c ?? Infinity;
    }
    const bottom = this.floorY;
    if (this.pos.x - r <= left && this.vel.x < 0) {
      this.pos.x = left + r;
      this.vel.x = -this.vel.x * T.wallRestitution;
      this.kickSquash(speed, 'left');
      this.impact('wall', { x: left, y: this.pos.y }, NORMAL.left, speed);
    } else if (this.pos.x + r >= right && this.vel.x > 0) {
      this.pos.x = right - r;
      this.vel.x = -this.vel.x * T.wallRestitution;
      this.kickSquash(speed, 'right');
      this.impact('wall', { x: right, y: this.pos.y }, NORMAL.right, speed);
    }

    this.rollDust -= dt;
    if (this.rollDust <= 0) {
      this.rollDust = 0.05;
      this.events.push({ type: 'rolling', x: this.pos.x, y: bottom, vx: this.vel.x });
    }
  }

  /** 翻滚收尾：弹起来，在空中把这一圈翻完，落地摆个 pose */
  private popUp() {
    const T = this.tuning;
    const dirSign = this.vel.x >= 0 ? 1 : -1;
    this.setMode('air');
    this.vel = { x: this.vel.x * 0.5, y: -T.rollPopHop };
    let target = nearestEquivalent(this.rot, 0);
    if ((target - this.rot) * dirSign < 0.6) target += TAU * dirSign;
    const airtime = (2 * T.rollPopHop) / Math.max(1, T.gravity);
    this.angVel = (target - this.rot) / Math.max(0.15, airtime * 0.8);
    this.pendingTaDa = true;
    this.events.push({ type: 'popup' });
  }

  private stepRecover() {
    if (this.modeTime < this.modeDuration) return;
    if (this.mode === 'splat') {
      this.setMode('air');
      this.vel = { x: 0, y: -420 };
      return;
    }
    const T = this.tuning;
    if (this.mode === 'cling' && this.side !== 'floor') {
      this.setMode('walk', rand(T.walkMin, T.walkMax, this.rng));
      return;
    }
    this.setMode('idle', rand(T.idleMin, T.idleMax, this.rng));
  }

  private stepSurface(dt: number) {
    const T = this.tuning;
    this.surfaceTime += dt;
    if (this.pendingCue && !this.fleeing) {
      this.seekTime += dt;
      if (this.startCue()) return;
    }
    if (this.side !== 'floor' && this.surfaceTime >= this.surfaceStay) {
      // 正下方就是输入框：先别跳，在墙上多待一会儿
      const below = floorBelow(this.world, this.pos.x, this.pos.y)?.c ?? this.screen.bottom;
      if (this.fleeing || this.blocksInput(this.pos.x, below - this.halfH)) {
        this.surfaceStay = this.surfaceTime + 2;
      } else {
        this.leaveSurface();
        return;
      }
    }

    if (this.mode === 'walk') {
      const hurry = this.fleeing || this.seeking;
      const speed = (this.side === 'floor' ? T.walkSpeed : T.climbSpeed) * (hurry ? T.fleeSpeedMul : 1);
      const [lo, hi] = this.sRange();
      const s = this.sOf(this.side) + this.dir * speed * dt;
      const next = this.surfacePos(this.side, clamp(s, lo, hi));
      const sup = this.support;
      if (this.fleeing && !this.blocksInput(this.pos.x, this.pos.y)) {
        // 让开了：停下来喘口气
        this.setMode('idle', rand(T.idleMin, T.idleMax, this.rng));
        return;
      }
      if (!this.fleeing && this.blocksInput(next.x, next.y) && !this.blocksInput(this.pos.x, this.pos.y)) {
        // 前面是输入框：当成墙，掉头
        this.dir = -this.dir as 1 | -1;
      } else if (sup && (s <= sup.x0 || s >= sup.x1)) {
        // 走到窗口边缘：跳下去或者掉头（在让路、赶去举牌子就一定跳）
        if (hurry || this.rng() < T.stepOffChance) {
          this.setMode('air');
          this.vel = { x: this.dir * T.walkSpeed * 2, y: -260 };
          this.events.push({ type: 'leap' });
          return;
        }
        this.dir = (s <= sup.x0 ? 1 : -1) as 1 | -1;
      } else if (s <= lo || s >= hi) {
        if (sup) this.dir = (s <= lo ? 1 : -1) as 1 | -1;
        else this.atCorner(s <= lo ? 'lo' : 'hi');
        // 从边沿跳下去了（atCorner 会改 mode，TS 看不出来）
        if ((this.mode as Mode) === 'air') return;
      } else {
        this.pos = this.surfacePos(this.side, s);
      }
    }

    if (this.modeTime >= this.modeDuration) {
      if (this.fleeing || this.seeking) {
        // 让路的路程很长，时间到了也接着走
        this.modeDuration += 1;
      } else if (this.mode === 'idle' && this.attentive) {
        this.modeDuration += 1;
      } else if (this.mode === 'idle' && this.agentMood !== 'idle' && this.dizzy <= 0) {
        this.followMood();
      } else if (this.mode === 'idle' && this.dizzy <= 0) {
        if (this.side === 'floor' && this.rng() < T.platformJumpChance && this.jumpToPlatform()) return;
        if (this.rng() < T.activityChance && this.startActivity()) return;
        this.setMode('walk', rand(T.walkMin, T.walkMax, this.rng));
        this.dir = this.rng() < 0.5 ? 1 : -1;
      } else {
        this.setMode('idle', rand(T.idleMin, T.idleMax, this.rng));
      }
    }
  }

  /** 跳上附近一个更高的窗口顶边。没有合适的返回 false。 */
  private jumpToPlatform(): boolean {
    const T = this.tuning;
    const feet = this.pos.y + this.halfH;
    const hw = this.halfW;
    const reachable = this.platforms.filter((p) => {
      const rise = feet - p.y;
      if (rise < 40 || rise > T.platformJumpMax || p.id === this.support?.id) return false;
      if (!this.hasHeadroom(p) || p.x1 - p.x0 < hw * 2) return false;
      const tx = clamp(this.pos.x, p.x0 + hw, p.x1 - hw);
      return Math.abs(tx - this.pos.x) < 700 && !this.blocksInput(tx, p.y - this.halfH);
    });
    if (!reachable.length) return false;
    const p = reachable[Math.floor(this.rng() * reachable.length)];
    this.leapTo(p, clamp(this.pos.x, p.x0 + hw, p.x1 - hw));
    return true;
  }

  /** 跳上窗口顶边 p，落在 x = tx 处。弹道多跳 60px 再落下 */
  private leapTo(p: Platform, tx: number) {
    const g = this.tuning.gravity;
    const feet = this.pos.y + this.halfH;
    const extra = 60;
    const vy = -Math.sqrt(2 * g * (feet - p.y + extra));
    // 顶点附近重力变小会多滞空一会儿；从顶点落到平台只落 extra 那么高
    const T = this.tuning;
    const tUp = -vy / g;
    const tApex = ((2 * T.apexSpeed) / g) * (1 / Math.max(0.05, T.apexGravityMul) - 1);
    const tDown = Math.sqrt((2 * extra) / (g * T.fallGravityMul));
    this.setMode('air');
    this.vel = { x: (tx - this.pos.x) / (tUp + tApex + tDown), y: vy };
    this.angVel = 0;
    this.events.push({ type: 'leap' });
  }

  /**
   * 沿屏幕边框走到了这段的一头。
   * - 墙角（凹角）：爬上墙 / 爬上天花板 / 从墙上下到地面，或者掉头；
   * - 边沿（凸角，多块屏幕拼出来的台阶）：地面到头了就跳下去或者掉头，矮台阶直接走下去；
   *   在墙上、天花板上就翻过去，贴到下一段上。
   */
  private atCorner(end: 'lo' | 'hi') {
    const T = this.tuning;
    const seg = this.seg;
    const link = end === 'lo' ? seg?.lo : seg?.hi;
    const turn = () => {
      this.dir = (end === 'lo' ? 1 : -1) as 1 | -1;
    };
    if (!seg || !link) return turn();
    const next = link.seg;
    const hw = this.halfW;
    const fromFloor = this.side === 'floor';

    if (fromFloor && link.convex) {
      // 下面那截墙有多高 = 要往下跳多高；不到一个身高的台阶直接走下去
      const drop = next.b - next.a;
      if (drop <= this.halfH * 2) {
        this.setMode('air');
        this.vel = { x: this.dir * T.walkSpeed, y: 0 };
        return;
      }
      if (this.fleeing || this.seeking || this.rng() < T.stepOffChance) {
        this.setMode('air');
        this.vel = { x: this.dir * T.walkSpeed * 2, y: -260 };
        this.events.push({ type: 'leap' });
        return;
      }
      return turn();
    }

    if (fromFloor && next.b - next.a <= this.halfH * 2) {
      // 矮台阶（比如只有一块屏幕有任务栏，两边地面差一截）：不用爬墙，直接迈上去
      const top = Math.abs(next.a - seg.c) > Math.abs(next.b - seg.c) ? next.lo : next.hi;
      if (top?.convex && top.seg.side === 'floor') {
        this.attach('floor', top.seg, next.c);
        this.squashAngle = -Math.PI / 2;
        this.squash = Math.min(this.squash, -0.12);
        return;
      }
    }

    const chance = next.side === 'ceiling' ? T.ceilingChance : fromFloor ? T.climbChance : 1;
    // 让路让到了墙角：爬上去
    if (!this.fleeing && this.rng() >= chance) return turn();
    // 拐角在下一段的哪头：从那头往里走，身子整个贴上去
    const atLo = Math.abs(seg.c - next.a) <= Math.abs(seg.c - next.b);
    this.attach(next.side, next, atLo ? next.a + hw : next.b - hw);
    this.dir = atLo ? 1 : -1;
    if (fromFloor) {
      this.surfaceTime = 0;
      this.surfaceStay = rand(T.surfaceStayMin, Math.max(T.surfaceStayMin, T.surfaceStayMax), this.rng);
    }
  }

  /** 在墙上/天花板待够了：蹬墙跳或者直接掉下来 */
  private leaveSurface() {
    const T = this.tuning;
    const n = NORMAL[this.side];
    const fromCeiling = this.side === 'ceiling';
    this.setMode('air');
    this.surfaceTime = 0;
    if (fromCeiling) {
      this.vel = { x: 0, y: 60 };
      this.angVel = (this.rng() < 0.5 ? 1 : -1) * 6;
      return;
    }
    if (this.rng() < 0.7) {
      this.vel = { x: n.x * T.wallJumpSpeed, y: -T.wallJumpSpeed * 0.55 };
      // 后空翻：转回正位再多翻一圈
      this.angVel = (-n.x * (Math.PI / 2 + TAU)) / 0.7;
      this.events.push({ type: 'leap' });
    } else {
      this.vel = { x: n.x * 120, y: 0 };
      this.angVel = -n.x * 3;
    }
  }

  // ---------- 摸摸 ----------

  /**
   * 光标在头顶上来回蹭：沿宠物自己的左右方向，1.5 秒内折返够 rubFlips 次就算在摸它。
   * 光标位置是原生侧 15Hz 推过来的，只在它真的动了的时候才算。
   */
  private senseRub() {
    const r = this.rub;
    const c = this.cursor;
    const reset = () => {
      r.x = NaN;
      r.dir = 0;
    };
    if (!c || !RUBBABLE.has(this.mode)) return reset();
    const rot = this.rot + this.visRot;
    const cs = Math.cos(-rot);
    const sn = Math.sin(-rot);
    const dx = c.x - this.pos.x;
    const dy = c.y - this.pos.y;
    const lx = cs * dx - sn * dy;
    const ly = sn * dx + cs * dy;
    const onHead = Math.abs(lx) < this.halfW * 0.85 && ly > -this.halfH - 28 && ly < -this.halfH * 0.1;
    if (!onHead) return reset();
    if (Number.isNaN(r.x)) {
      r.x = c.x;
      r.y = c.y;
      return;
    }
    // 光标在宠物左右方向上移动了多少
    const along = cs * (c.x - r.x) - sn * (c.y - r.y);
    if (Math.abs(along) < 4) return;
    r.x = c.x;
    r.y = c.y;
    if (this.mode === 'petted') r.lastAt = Math.max(r.lastAt, this.t);
    const dir = Math.sign(along);
    if (r.dir !== 0 && dir !== r.dir) r.flips.push(this.t);
    r.dir = dir;
    while (r.flips.length && this.t - r.flips[0] > 1.5) r.flips.shift();
    if (this.mode !== 'petted' && r.flips.length >= this.tuning.rubFlips) this.startPetted();
  }

  private startPetted() {
    this.setMode('petted');
    this.rub.lastAt = this.t;
    this.rub.heart = 0;
    this.rub.flips = [];
  }

  private stepPetted(dt: number) {
    const r = this.rub;
    r.heart -= dt;
    if (r.heart <= 0) {
      r.heart = 0.4;
      const n = NORMAL[this.side];
      this.events.push({
        type: 'heart',
        x: this.pos.x + n.x * this.halfH,
        y: this.pos.y + n.y * this.halfH,
        nx: n.x,
        ny: n.y,
      });
    }
    // 手停下来一秒就结束，心满意足地发会儿呆
    if (this.t - r.lastAt > 1) {
      this.setMode('idle', rand(this.tuning.idleMin, this.tuning.idleMax, this.rng));
      this.surfaceTime = 0;
    }
  }

  // ---------- 小动作：电脑、炒股、吃TOKEN、抖毛 ----------

  /** 开始一个小动作。不指定就按权重随机挑；只挑当前皮肤会做的，电脑只能在地上（或窗口顶上）玩。 */
  private startActivity(want?: Activity): boolean {
    const T = this.tuning;
    const onFloor = this.side === 'floor';
    const can = (a: Activity) => this.actions.has(a) && (onFloor || !LAPTOP_MODES.has(a));
    let m = want;
    if (m && !can(m)) return false;
    if (!m) {
      const options = ACTIVITIES.filter(can);
      let r = this.rng() * options.reduce((s, a) => s + ACTIVITY_WEIGHT[a], 0);
      m = options.find((a) => (r -= ACTIVITY_WEIGHT[a]) < 0) ?? options[options.length - 1];
      if (!m) return false;
    }
    if (LAPTOP_MODES.has(m)) {
      this.dir = this.laptopSide();
      // 开盘前先随机走一段，屏幕上一开始就有行情
      let v = 0.5;
      this.stock = [];
      for (let i = 0; i < STOCK_LEN; i++) {
        v = clamp(v + (this.rng() - 0.5) * 0.12, 0.1, 0.9);
        this.stock.push(v);
      }
      this.stockMood = 0;
      this.stockTick = 0.6;
    }
    this.bites = 0;
    const duration =
      m === 'coin'
        ? COIN_TIME
        : m === 'shake'
          ? SHAKE_TIME
          : rand(T.laptopMin, Math.max(T.laptopMin, T.laptopMax), this.rng);
    this.setMode(m, duration);
    return true;
  }

  /** 电脑放哪边：空地多的一边，并且别摆到输入框上 */
  private laptopSide(): 1 | -1 {
    const [lo, hi] = this.sRange();
    const reach = this.halfW * 1.4;
    const ok = (d: 1 | -1) => {
      const x = this.pos.x + d * reach;
      return x - this.halfW * 0.4 >= lo - this.halfW && x <= hi + this.halfW && !this.blocksInput(x, this.pos.y);
    };
    const roomy: 1 | -1 = hi - this.pos.x >= this.pos.x - lo ? 1 : -1;
    if (ok(roomy)) return roomy;
    return ok(-roomy as 1 | -1) ? (-roomy as 1 | -1) : roomy;
  }

  private stepActivity(dt: number) {
    const T = this.tuning;
    if (this.mode === 'stocks') this.tickStock(dt);
    if (this.mode === 'coin') {
      while (this.bites < COIN_BITES.length && this.modeTime >= COIN_BITES[this.bites]) {
        this.bites++;
        // 咬一口：身体一缩，金屑往外蹦
        const n = NORMAL[this.side];
        this.squashAngle = Math.atan2(n.y, n.x);
        this.squash = Math.max(this.squash, 0.14);
        this.squashVel = 0;
        this.events.push({ type: 'chomp', x: this.pos.x, y: this.pos.y, nx: n.x, ny: n.y });
      }
    }
    if (this.mode === 'shake') {
      // 抖几下，每下甩掉几撮毛（bites 在这里当"抖了几下"用）
      while (this.bites < SHAKE_PUFFS.length && this.modeTime >= SHAKE_PUFFS[this.bites]) {
        this.bites++;
        const n = NORMAL[this.side];
        this.events.push({ type: 'fluff', x: this.pos.x, y: this.pos.y, nx: n.x, ny: n.y });
      }
    }
    if (this.modeTime < this.modeDuration) return;
    if (this.mode === 'stocks' && this.stock[this.stock.length - 1] > this.stock[0]) this.taDa = 0.8;
    this.setMode('idle', rand(T.idleMin, T.idleMax, this.rng));
  }

  private stepCue() {
    const n = NORMAL[this.side];
    if (this.mode === 'chime') {
      while (this.bites < this.chimes && this.modeTime >= CHIME_LEAD + this.bites * CHIME_GAP) {
        this.bites++;
        // 当~：身体一缩，铃铛那边冒出音符
        this.squashAngle = Math.atan2(n.y, n.x);
        this.squash = Math.max(this.squash, 0.12);
        this.squashVel = 0;
        const t = { x: -n.y, y: n.x };
        const r = this.halfH * 1.3;
        this.events.push({
          type: 'ding',
          x: this.pos.x + n.x * r + t.x * this.dir * this.halfW * 0.6,
          y: this.pos.y + n.y * r + t.y * this.dir * this.halfW * 0.6,
          nx: n.x,
          ny: n.y,
        });
      }
    } else if (this.mode === 'stretch' && this.bites === 0 && this.modeTime >= STRETCH_RELEASE) {
      // 伸完一松劲：整个人往下一沉
      this.bites = 1;
      this.squashAngle = Math.atan2(n.y, n.x);
      this.squash = Math.max(this.squash, 0.2);
      this.squashVel = 0;
    } else if (this.mode === 'zap') {
      // 噼里啪啦：身上到处冒火花
      while (this.modeTime >= this.bites * ZAP_SPARK) {
        this.bites++;
        this.events.push({
          type: 'spark',
          x: this.pos.x + (this.rng() - 0.5) * 2.2 * this.halfW,
          y: this.pos.y + (this.rng() - 0.5) * 2.2 * this.halfH,
        });
      }
    } else if (this.mode === 'knock') {
      // 咚、咚、咚：每一脚身体一缩，脚下扬起一点灰
      while (this.bites < KNOCK_BEATS.length && this.modeTime >= KNOCK_BEATS[this.bites]) {
        this.bites++;
        this.squashAngle = Math.atan2(n.y, n.x);
        this.squash = Math.max(this.squash, 0.16);
        this.squashVel = 0;
        const fx = this.pos.x - n.x * this.halfH;
        const fy = this.pos.y - n.y * this.halfH;
        this.events.push({ type: 'impact', tier: 'soft', x: fx, y: fy, nx: n.x, ny: n.y, speed: 500 });
      }
    }
    if (this.modeTime < this.modeDuration) return;
    if (this.mode === 'sign') this.taDa = 0.6;
    if (this.mode === 'zap') {
      // 电完了：冒一股黑烟，栽倒，晕一会儿
      const T = this.tuning;
      this.events.push({ type: 'smoke', x: this.pos.x + n.x * this.halfH, y: this.pos.y + n.y * this.halfH });
      this.setMode('splat', T.splatHold);
      this.dizzy = Math.max(this.dizzy, T.splatHold + 1.5);
      this.kickSquash(900, this.side);
      return;
    }
    this.setMode('idle', rand(this.tuning.idleMin, this.tuning.idleMax, this.rng));
  }

  /**
   * 魔法：帽子落到头上身子一缩；掏出魔杖跟着光标瞄（光标在身后就朝前斜上方）；
   * 前摇时魔杖举过头顶来回抡，光点往杖尖聚，最后往前一戳；
   * 开火时杖尖炸一下、被后坐力往后推一截，激光打到的地方先炸一大下，之后不停冒火花，收尾再炸一下。
   * 光标在射程里就直接打光标。
   */
  private stepMagic(dt: number) {
    const tm = this.modeTime;
    const n = NORMAL[this.side];
    const kick = (k: number) => {
      this.squashAngle = Math.atan2(n.y, n.x);
      this.squash = Math.max(this.squash, k);
      this.squashVel = 0;
    };
    if (this.magicStage === 0 && tm >= MAGIC_HAT) {
      this.magicStage = 1;
      kick(0.12);
    }

    const tip = this.wandTip();
    let want = AIM_DEFAULT;
    let cursorDist = Infinity;
    const c = this.cursor;
    if (c && Math.hypot(c.x - this.pos.x, c.y - this.pos.y) > this.halfW * 2) {
      const dx = (c.x - tip.x) * this.dir;
      const dy = c.y - tip.y;
      const a = Math.atan2(dy, dx);
      if (dx > 0 && a >= AIM_UP && a <= AIM_DOWN) {
        want = a;
        cursorDist = Math.hypot(dx, dy);
      } else if (dx > 0) {
        want = clamp(a, AIM_UP, AIM_DOWN);
      }
    }
    if (tm < MAGIC_HAT) {
      // 还没掏出来：杖尖朝下
    } else if (tm < MAGIC_DRAW) {
      this.aim += (want - this.aim) * approach(6, dt);
    } else if (tm < MAGIC_FIRE - MAGIC_THRUST) {
      // 前摇：举过头顶来回抡，光点往杖尖聚
      const swirl = SWIRL_CENTER + SWIRL_AMP * Math.sin((tm - MAGIC_DRAW) * Math.PI * 2 * SWIRL_RATE);
      this.aim += (swirl - this.aim) * approach(18, dt);
      while (this.magicCharges < Math.floor((tm - MAGIC_DRAW) / MAGIC_CHARGE)) {
        this.magicCharges++;
        this.events.push({ type: 'charge', x: tip.x, y: tip.y });
      }
    } else {
      // 往前一戳，然后跟着目标
      this.aim += (want - this.aim) * approach(tm < MAGIC_FIRE ? 30 : 12, dt);
    }

    if (tm >= MAGIC_FIRE && tm < MAGIC_FIRE_END) {
      const f = tm - MAGIC_FIRE;
      if (this.magicStage < 2) {
        this.magicStage = 2;
        kick(0.25);
        this.events.push({ type: 'boom', x: tip.x, y: tip.y, big: false });
        this.events.push({ type: 'impact', tier: 'soft', x: this.pos.x, y: this.pos.y + this.halfH, nx: n.x, ny: n.y, speed: 900 });
      }
      const end = this.beamHit(tip, Math.min(cursorDist, this.beamLength(tip)));
      this.beamEnd = end;
      if (this.magicStage < 3 && f >= MAGIC_GROW) {
        this.magicStage = 3;
        this.events.push({ type: 'boom', x: end.x, y: end.y, big: true });
      }
      if (f >= MAGIC_GROW) {
        while (this.magicSparks < Math.floor((f - MAGIC_GROW) / MAGIC_SPARK)) {
          this.magicSparks++;
          this.events.push({ type: 'magic', x: end.x, y: end.y });
        }
      }
      // 后坐力：开火那一下往后滑一截，之后一直被顶着慢慢往后蹭，脚下扬灰
      const v = 280 * Math.max(0, 1 - f / 0.35) + 25;
      const before = this.pos.x;
      this.recoil(v * dt);
      if (v > 80 && Math.floor(f / 0.07) !== Math.floor((f - dt) / 0.07) && this.pos.x !== before) {
        this.events.push({ type: 'rolling', x: this.pos.x, y: this.pos.y + this.halfH, vx: -this.dir * v });
      }
    } else if (this.beamEnd) {
      // 收尾：打中的地方最后炸一下
      if (this.magicStage === 3) this.events.push({ type: 'boom', x: this.beamEnd.x, y: this.beamEnd.y, big: true });
      this.magicStage = 4;
      this.beamEnd = null;
    }
    if (tm >= this.modeDuration) this.setMode('idle', rand(this.tuning.idleMin, this.tuning.idleMax, this.rng));
  }

  /** 被后坐力往后推 dist 像素（沿地面，到边就停） */
  private recoil(dist: number) {
    const [lo, hi] = this.sRange();
    this.pos = this.surfacePos('floor', clamp(this.pos.x - this.dir * dist, lo, hi));
  }

  /** 杖尖的世界坐标（只在地上施法，所以不管旋转） */
  wandTip(): Vec2 {
    const w = wandGeom(this.grid, this.dir, this.aim, wandLift(this.modeTime));
    const c = this.cell;
    return { x: this.pos.x + (w.tx / 3 - this.grid[0] / 2) * c, y: this.pos.y + (w.ty / 3 - this.grid[1] / 2) * c };
  }

  private beamDir(): Vec2 {
    return { x: this.dir * Math.cos(this.aim), y: Math.sin(this.aim) };
  }

  /** 沿着魔杖指的方向，激光射到所在屏幕边上有多长 */
  private beamLength(tip: Vec2): number {
    const s = this.screen;
    const v = this.beamDir();
    let t = Infinity;
    if (v.x > 1e-6) t = Math.min(t, (s.right - tip.x) / v.x);
    if (v.x < -1e-6) t = Math.min(t, (s.left - tip.x) / v.x);
    if (v.y > 1e-6) t = Math.min(t, (s.bottom - tip.y) / v.y);
    if (v.y < -1e-6) t = Math.min(t, (s.top - tip.y) / v.y);
    return Math.max(0, Number.isFinite(t) ? t : 0);
  }

  private beamHit(tip: Vec2, length: number): Vec2 {
    const v = this.beamDir();
    return { x: tip.x + v.x * length, y: tip.y + v.y * length };
  }

  /** 扫地：扫帚一来一回，每扫一下往前面扬一把灰；Claude 压缩完了由 setAgentMood 收工 */
  private stepSweep() {
    const strokes = Math.floor(this.modeTime / SWEEP_STROKE);
    while (this.bites < strokes) {
      this.bites++;
      const feet = this.pos.y + this.halfH;
      this.events.push({ type: 'sweep', x: this.pos.x + this.dir * this.halfW * 1.4, y: feet, dir: this.dir });
      // 扫几下换个方向
      if (this.bites % 6 === 0) this.dir = -this.dir as 1 | -1;
    }
    if (this.modeTime >= this.modeDuration) this.setMode('idle', rand(this.tuning.idleMin, this.tuning.idleMax, this.rng));
  }

  /** 行情：带一点点上涨倾向的随机游走，偶尔暴涨暴跌 */
  private tickStock(dt: number) {
    this.stockMood -= this.stockMood * approach(1.5, dt);
    this.stockTick -= dt;
    if (this.stockTick > 0) return;
    this.stockTick = 0.3;
    const last = this.stock[this.stock.length - 1] ?? 0.5;
    let d = (this.rng() - 0.47) * 0.14;
    if (this.rng() < 0.1) d *= 3.5;
    const next = clamp(last + d, 0.04, 0.96);
    this.stock.push(next);
    if (this.stock.length > STOCK_LEN) this.stock.shift();
    this.stockMood = clamp(this.stockMood + (next - last) * 6, -1, 1);
    if (next - last < -0.15) {
      // 暴跌！
      this.emote = { kind: '!', t: 0 };
      this.squashAngle = -Math.PI / 2;
      this.squash = Math.max(this.squash, 0.2);
    } else if (next - last > 0.15) {
      // 暴涨：蹦一下
      this.squashAngle = -Math.PI / 2;
      this.squash = Math.min(this.squash, -0.15);
    }
  }

  // ---------- 避让输入框 ----------

  /** 宠物身体（站在当前这个面上、中心在 x,y）会不会挡住输入框 */
  blocksInput(x: number, y: number): boolean {
    const z = this.inputZone;
    if (!z || !this.tuning.avoidInput) return false;
    const m = this.tuning.inputMargin;
    const horizontal = this.side === 'floor' || this.side === 'ceiling';
    let ex0 = horizontal ? this.halfW : this.halfH;
    let ex1 = ex0;
    const ey = horizontal ? this.halfH : this.halfW;
    // 电脑摆在旁边，也算进去
    if (LAPTOP_MODES.has(this.mode)) {
      if (this.dir > 0) ex1 += this.halfW * 1.3;
      else ex0 += this.halfW * 1.3;
    }
    return x + ex1 > z.left - m && x - ex0 < z.right + m && y + ey > z.top - m && y - ey < z.bottom + m;
  }

  /** 挡住输入框了：沿当前的面往最近的空地走；整条边都被挡着就爬墙/跳上窗口/跳下窗口 */
  private flee() {
    const z = this.inputZone!;
    const m = this.tuning.inputMargin;
    const horizontal = this.side === 'floor' || this.side === 'ceiling';
    const s = this.sOf(this.side);
    const [lo, hi] = this.sRange();
    const half = this.halfW + 2;
    const zlo = (horizontal ? z.left : z.top) - m - half;
    const zhi = (horizontal ? z.right : z.bottom) + m + half;
    const canLo = zlo >= lo;
    const canHi = zhi <= hi;
    let dir: 1 | -1;
    if (canLo && canHi) dir = s - zlo <= zhi - s ? -1 : 1;
    else if (canLo) dir = -1;
    else if (canHi) dir = 1;
    else {
      if (this.side === 'floor' && this.jumpToPlatform()) return;
      // 往近的那头走：走到头会爬墙或者从窗口上跳下去
      dir = s - lo <= hi - s ? -1 : 1;
    }
    this.setMode('walk', 30);
    this.dir = dir;
    this.fleeing = true;
    this.fleeTime = 0;
    this.surfaceTime = 0;
  }

  // ---------- 面上坐标 ----------

  /** 当前脚下的地面高度：窗口顶边或屏幕底 */
  get floorY(): number {
    if (this.support) return this.support.y;
    if (this.seg?.side === 'floor') return this.seg.c;
    return floorBelow(this.world, this.pos.x, this.pos.y)?.c ?? this.screen.bottom;
  }

  /**
   * 沿当前这个面能走的范围（身体中心）。墙角那头要留出半个身子；
   * 边沿那头（窗口边缘、屏幕拼出来的台阶）身体中心可以走到边上，一半身子悬空。
   */
  private sRange(): [number, number] {
    const hw = this.halfW;
    if (this.side === 'floor' && this.support) {
      const y = this.support.y - this.halfH;
      const left = nearestSeg(this.world, 'left', this.pos.x, y);
      const right = nearestSeg(this.world, 'right', this.pos.x, y);
      const lo = Math.max(this.support.x0, left ? left.c + hw : -Infinity);
      const hi = Math.min(this.support.x1, right ? right.c - hw : Infinity);
      return [lo, Math.max(lo, hi)];
    }
    if (this.seg?.side !== this.side) this.seg = this.findSeg(this.side);
    const seg = this.seg;
    if (!seg) {
      const s = this.sOf(this.side);
      return [s, s];
    }
    const lo = seg.a + (seg.lo?.convex ? 0 : hw);
    const hi = seg.b - (seg.hi?.convex ? 0 : hw);
    return [lo, Math.max(lo, hi)];
  }

  private sOf(side: Side): number {
    return side === 'floor' || side === 'ceiling' ? this.pos.x : this.pos.y;
  }

  private surfacePos(side: Side, s: number): Vec2 {
    const hh = this.halfH;
    const scr = this.screen;
    switch (side) {
      case 'floor':
        return { x: s, y: this.floorY - hh };
      case 'ceiling':
        return { x: s, y: (this.seg?.c ?? scr.top) + hh };
      case 'left':
        return { x: (this.seg?.c ?? scr.left) + hh, y: s };
      case 'right':
        return { x: (this.seg?.c ?? scr.right) - hh, y: s };
    }
  }

  /** 贴到 side 这种面上：seg 是那段屏幕边框（站在窗口顶上时为 null，用 support） */
  private attach(side: Side, seg: Seg | null, s?: number, opts: { smooth?: boolean; keepRot?: boolean } = {}) {
    const { smooth = true, keepRot = false } = opts;
    const oldPos = { ...this.pos };
    const oldRot = this.rot;
    this.side = side;
    this.seg = seg;
    if (side !== 'floor') this.support = null;
    const [lo, hi] = this.sRange();
    this.pos = this.surfacePos(side, clamp(s ?? this.sOf(side), lo, hi));
    this.vel = { x: 0, y: 0 };
    if (!keepRot) {
      this.angVel = 0;
      this.rot = UPRIGHT[side];
    }
    if (smooth) {
      this.visOffset.x += oldPos.x - this.pos.x;
      this.visOffset.y += oldPos.y - this.pos.y;
      this.visRot += wrapAngle(oldRot - this.rot);
    } else {
      this.visOffset = { x: 0, y: 0 };
      this.visRot = 0;
    }
  }

  private clampInside() {
    const r = Math.max(this.halfW, this.halfH);
    this.pos = keepInside(this.world, this.pos, r, r);
  }

  private kickSquash(speed: number, side: Side) {
    const T = this.tuning;
    const n = NORMAL[side];
    this.squashAngle = Math.atan2(n.y, n.x);
    this.squash = Math.min(T.maxSquash, Math.max(this.squash, speed * T.impactSquash));
    this.squashVel = 0;
  }

  private impact(tier: ImpactTier, at: Vec2, n: Vec2, speed: number) {
    this.lastImpact = { tier, speed };
    this.events.push({ type: 'impact', tier, x: at.x, y: at.y, nx: n.x, ny: n.y, speed });
  }
}

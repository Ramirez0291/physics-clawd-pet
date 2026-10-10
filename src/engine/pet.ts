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

/**
 * 宠物贴着的面：屏幕边框的四条边。站在其他窗口顶上时也是 'floor'，
 * 只是 support 指向那个窗口的顶边（见 Platform）。
 */
export type Side = 'floor' | 'ceiling' | 'left' | 'right';

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
  | 'coin'; // 掏出 token 金币吃掉

/** 玩电脑类的小动作（电脑摆在 dir 那一侧的地上） */
export const LAPTOP_MODES: ReadonlySet<Mode> = new Set(['laptop', 'stocks']);
/** 吃TOKEN的时间轴（秒）：掏出 → 举起欣赏 → 三口吃掉 → 回味 */
export const COIN_TIME = 3.3;
export const COIN_BITES = [1.35, 1.8, 2.25];
/** 股价历史长度（= 屏幕上的 K 线列数） */
export const STOCK_LEN = 20;

export type ImpactTier = 'soft' | 'bounce' | 'roll' | 'hero' | 'splat' | 'wall' | 'cling';

export interface Bounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

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
  | { type: 'chomp'; x: number; y: number; nx: number; ny: number };

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
]);
/** 这些状态下光标在头顶来回蹭就算摸摸 */
const RUBBABLE: ReadonlySet<Mode> = new Set(['idle', 'walk', 'land', 'petted', 'laptop', 'stocks', 'coin']);
/** 这些状态下挡住输入框会主动让开 */
const AVOIDING: ReadonlySet<Mode> = new Set(['idle', 'walk', 'laptop', 'stocks', 'coin']);

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
  /** 吃TOKEN：已经咬了几口 */
  bites = 0;
  /** 摸摸：光标在头顶的移动记录 */
  private rub = { x: NaN, y: NaN, dir: 0, flips: [] as number[], lastAt: -Infinity, heart: 0 };

  private hold: Hold | null = null;
  private rollDust = 0;
  /** 设备像素比：决定实际画出来的格子大小 */
  private pixelRatio = 1;

  constructor(
    public tuning: Tuning,
    public grid: [number, number],
    public bounds: Bounds,
    private rng: () => number = Math.random,
  ) {}

  // ---------- 尺寸 ----------

  /** 一个皮肤格子的边长（CSS 像素），与渲染器画出来的一致 */
  get cell() {
    return cellSize(this.tuning, this.pixelRatio);
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

  // ---------- 外部控制 ----------

  setBounds(b: Bounds) {
    this.bounds = b;
    this.resnap();
  }

  setTuning(t: Tuning) {
    const before = this.cell;
    this.tuning = t;
    if (this.cell !== before) this.resnap();
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
  perform(m: 'petted' | 'laptop' | 'stocks' | 'coin'): boolean {
    if (!RUBBABLE.has(this.mode)) return false;
    if (m === 'petted') {
      this.startPetted();
      this.rub.lastAt = this.t + 2;
      return true;
    }
    return this.startActivity(m);
  }

  private loseSupport() {
    this.setMode('air');
    this.vel = { x: 0, y: 0 };
    this.angVel = 0;
    this.emote = { kind: '!', t: 0 };
    this.events.push({ type: 'dropped' });
  }

  /** 尺寸或边界变化后，把宠物放回合法位置 */
  private resnap() {
    if (this.mode === 'held') return;
    if (this.grounded && this.mode !== 'roll') {
      this.attach(this.side, undefined, { smooth: false });
    } else {
      const { left, top, right, bottom } = this.bounds;
      this.pos.x = clamp(this.pos.x, left + this.halfW, Math.max(left + this.halfW, right - this.halfW));
      this.pos.y = clamp(this.pos.y, top + this.halfH, Math.max(top + this.halfH, bottom - this.halfH));
    }
  }

  placeOnFloor(x: number) {
    this.hold = null;
    this.support = null;
    this.side = 'floor';
    this.pos = { x, y: this.bounds.bottom - this.halfH };
    this.attach('floor', x, { smooth: false });
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
        this.stepActivity(dt);
        break;
      default:
        this.stepRecover();
    }
  }

  private setMode(m: Mode, duration = 0) {
    this.mode = m;
    this.modeTime = 0;
    this.modeDuration = duration;
    if (m === 'air' || m === 'held') this.support = null;
    if (m !== 'walk') this.fleeing = false;
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

    this.collideAir(prevY);
  }

  /** 正下方最近的落脚处（窗口顶边或屏幕底） */
  private groundBelow(): number {
    const feet = this.pos.y + this.halfH;
    let y = this.bounds.bottom;
    for (const p of this.platforms) {
      if (p.y >= feet && p.y < y && this.pos.x >= p.x0 && this.pos.x <= p.x1) y = p.y;
    }
    return y;
  }

  /** 平台头顶要有足够空间站下宠物 */
  private hasHeadroom(p: Platform): boolean {
    return p.y - this.bounds.top >= this.halfH * 2;
  }

  private collideAir(prevY: number) {
    const { left, top, right, bottom } = this.bounds;
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

    if (this.pos.y + ey >= bottom && this.vel.y > 0) {
      this.pos.y = bottom - ey;
      this.hitFloor();
      return;
    }
    if (this.pos.y - ey <= top && this.vel.y < 0) {
      this.pos.y = top + ey;
      this.hitCeiling();
      if (this.mode !== 'air') return;
    }
    if (this.pos.x - ex <= left && this.vel.x < 0) {
      this.pos.x = left + ex;
      this.hitWall('left');
    } else if (this.pos.x + ex >= right && this.vel.x > 0) {
      this.pos.x = right - ex;
      this.hitWall('right');
    }
  }

  /** 落到屏幕底部（p = null）或某个窗口顶边上 */
  private hitFloor(p: Platform | null = null) {
    const T = this.tuning;
    const impact = this.vel.y;
    const vx = this.vel.x;
    const floorY = p ? p.y : this.bounds.bottom;
    const contact = { x: this.pos.x, y: floorY };
    const stand = (opts?: { keepRot?: boolean }) => {
      this.side = 'floor';
      this.support = p ? { ...p } : null;
      this.attach('floor', undefined, opts);
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

  private hitCeiling() {
    const T = this.tuning;
    const speed = -this.vel.y;
    const contact = { x: this.pos.x, y: this.bounds.top };
    if (speed >= T.ceilingClingSpeed) {
      this.cling('ceiling', speed, contact);
      return;
    }
    this.vel.y = speed * T.wallRestitution;
    this.kickSquash(speed, 'ceiling');
    this.impact('wall', contact, NORMAL.ceiling, speed);
  }

  private hitWall(side: 'left' | 'right') {
    const T = this.tuning;
    const speed = Math.abs(this.vel.x);
    const contact = { x: side === 'left' ? this.bounds.left : this.bounds.right, y: this.pos.y };
    if (speed >= T.wallClingSpeed) {
      this.cling(side, speed, contact);
      return;
    }
    this.vel.x = -this.vel.x * T.wallRestitution;
    this.angVel = -this.angVel * 0.5;
    this.kickSquash(speed, side);
    this.impact('wall', contact, NORMAL[side], speed);
  }

  private cling(side: Side, speed: number, contact: Vec2) {
    const T = this.tuning;
    this.attach(side);
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

    // 滚出窗口边缘：带着速度掉下去，继续转
    const sup = this.support;
    if (sup && (this.pos.x < sup.x0 || this.pos.x > sup.x1)) {
      const vx = this.vel.x;
      this.setMode('air');
      this.vel = { x: vx, y: 0 };
      this.angVel = vx / this.rollRadius;
      return;
    }

    const r = this.rollRadius;
    const { left, right } = this.bounds;
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
    if (this.side !== 'floor' && this.surfaceTime >= this.surfaceStay) {
      // 正下方就是输入框：先别跳，在墙上多待一会儿
      if (this.fleeing || this.blocksInput(this.pos.x, this.bounds.bottom - this.halfH)) {
        this.surfaceStay = this.surfaceTime + 2;
      } else {
        this.leaveSurface();
        return;
      }
    }

    if (this.mode === 'walk') {
      const speed = (this.side === 'floor' ? T.walkSpeed : T.climbSpeed) * (this.fleeing ? T.fleeSpeedMul : 1);
      const [lo, hi] = this.sRange(this.side);
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
        // 走到窗口边缘：跳下去或者掉头（在让路就一定跳）
        if (this.fleeing || this.rng() < T.stepOffChance) {
          this.setMode('air');
          this.vel = { x: this.dir * T.walkSpeed * 2, y: -260 };
          this.events.push({ type: 'leap' });
          return;
        }
        this.dir = (s <= sup.x0 ? 1 : -1) as 1 | -1;
      } else if (s <= lo || s >= hi) {
        if (sup) this.dir = (s <= lo ? 1 : -1) as 1 | -1;
        else this.atCorner(s <= lo ? 'lo' : 'hi');
      } else {
        this.pos = this.surfacePos(this.side, s);
      }
    }

    if (this.modeTime >= this.modeDuration) {
      if (this.fleeing) {
        // 让路的路程很长，时间到了也接着走
        this.modeDuration += 1;
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
    const tx = clamp(this.pos.x, p.x0 + hw, p.x1 - hw);

    // 弹道：多跳 60px 再落下。顶点附近重力变小会多滞空一会儿，也算进去。
    const g = T.gravity;
    const extra = 60;
    const vy = -Math.sqrt(2 * g * (feet - p.y + extra));
    const tUp = -vy / g;
    const tApex = ((2 * T.apexSpeed) / g) * (1 / Math.max(0.05, T.apexGravityMul) - 1);
    const tDown = Math.sqrt((2 * extra) / (g * T.fallGravityMul));
    this.setMode('air');
    this.vel = { x: (tx - this.pos.x) / (tUp + tApex + tDown), y: vy };
    this.angVel = 0;
    this.events.push({ type: 'leap' });
    return true;
  }

  private atCorner(end: 'lo' | 'hi') {
    const T = this.tuning;
    const { left, top, right, bottom } = this.bounds;
    const hw = this.halfW;
    type Turn = [Side, number, 1 | -1, number];
    const table: Record<Side, Record<'lo' | 'hi', Turn>> = {
      floor: {
        lo: ['left', bottom - hw, -1, T.climbChance],
        hi: ['right', bottom - hw, -1, T.climbChance],
      },
      left: {
        lo: ['ceiling', left + hw, 1, T.ceilingChance],
        hi: ['floor', left + hw, 1, 1],
      },
      right: {
        lo: ['ceiling', right - hw, -1, T.ceilingChance],
        hi: ['floor', right - hw, -1, 1],
      },
      ceiling: {
        lo: ['left', top + hw, 1, 1],
        hi: ['right', top + hw, 1, 1],
      },
    };
    const [side, s, dir, chance] = table[this.side][end];
    // 让路让到了墙角：爬上去
    if (!this.fleeing && this.rng() >= chance) {
      this.dir = (end === 'lo' ? 1 : -1) as 1 | -1;
      return;
    }
    const fromFloor = this.side === 'floor';
    this.attach(side, s);
    this.dir = dir;
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

  // ---------- 小动作：电脑、炒股、吃TOKEN ----------

  /** 开始一个小动作。不指定就随机挑；电脑只能在地上（或窗口顶上）玩。 */
  private startActivity(want?: 'laptop' | 'stocks' | 'coin'): boolean {
    const T = this.tuning;
    const onFloor = this.side === 'floor';
    let m = want;
    if (!m) {
      const r = this.rng();
      m = !onFloor || r >= 0.7 ? 'coin' : r < 0.4 ? 'laptop' : 'stocks';
    }
    if (m !== 'coin') {
      if (!onFloor) return false;
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
    this.setMode(m, m === 'coin' ? COIN_TIME : rand(T.laptopMin, Math.max(T.laptopMin, T.laptopMax), this.rng));
    return true;
  }

  /** 电脑放哪边：空地多的一边，并且别摆到输入框上 */
  private laptopSide(): 1 | -1 {
    const [lo, hi] = this.sRange('floor');
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
    if (this.modeTime < this.modeDuration) return;
    if (this.mode === 'stocks' && this.stock[this.stock.length - 1] > this.stock[0]) this.taDa = 0.8;
    this.setMode('idle', rand(T.idleMin, T.idleMax, this.rng));
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
    const [lo, hi] = this.sRange(this.side);
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
    return this.support ? this.support.y : this.bounds.bottom;
  }

  private sRange(side: Side): [number, number] {
    const { left, top, right, bottom } = this.bounds;
    const hw = this.halfW;
    let [lo, hi] = side === 'floor' || side === 'ceiling' ? [left + hw, right - hw] : [top + hw, bottom - hw];
    // 站在窗口顶上时，身体中心可以走到边缘（一半身子悬空）
    if (side === 'floor' && this.support) {
      lo = Math.max(lo, this.support.x0);
      hi = Math.min(hi, this.support.x1);
    }
    return [lo, Math.max(lo, hi)];
  }

  private sOf(side: Side): number {
    return side === 'floor' || side === 'ceiling' ? this.pos.x : this.pos.y;
  }

  private surfacePos(side: Side, s: number): Vec2 {
    const { left, top, right } = this.bounds;
    const hh = this.halfH;
    switch (side) {
      case 'floor':
        return { x: s, y: this.floorY - hh };
      case 'ceiling':
        return { x: s, y: top + hh };
      case 'left':
        return { x: left + hh, y: s };
      case 'right':
        return { x: right - hh, y: s };
    }
  }

  private attach(side: Side, s?: number, opts: { smooth?: boolean; keepRot?: boolean } = {}) {
    const { smooth = true, keepRot = false } = opts;
    const oldPos = { ...this.pos };
    const oldRot = this.rot;
    this.side = side;
    if (side !== 'floor') this.support = null;
    const [lo, hi] = this.sRange(side);
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
    const { left, top, right, bottom } = this.bounds;
    const r = Math.max(this.halfW, this.halfH);
    this.pos.x = clamp(this.pos.x, left + r, Math.max(left + r, right - r));
    this.pos.y = clamp(this.pos.y, top + r, Math.max(top + r, bottom - r));
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

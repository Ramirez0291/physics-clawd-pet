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
import type { Tuning } from './params';

/** 宠物贴着的面。墙面用"屏幕边框"表示，M2 会加上其他窗口的顶边。 */
export type Side = 'floor' | 'ceiling' | 'left' | 'right';

export type Mode =
  | 'idle' // 站着
  | 'walk' // 沿当前面走/爬
  | 'held' // 被鼠标拎着
  | 'air' // 飞行中
  | 'land' // 普通落地硬直
  | 'roll' // 成龙式翻滚
  | 'hero' // 超级英雄落地
  | 'splat' // 脸着地
  | 'cling'; // 蜘蛛侠式贴墙/天花板的瞬间

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
  | { type: 'leap' };

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

const GROUNDED: ReadonlySet<Mode> = new Set(['idle', 'walk', 'land', 'hero', 'splat', 'cling', 'roll']);

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

  private hold: Hold | null = null;
  private rollDust = 0;

  constructor(
    public tuning: Tuning,
    public grid: [number, number],
    public bounds: Bounds,
    private rng: () => number = Math.random,
  ) {}

  // ---------- 尺寸 ----------

  get halfW() {
    return (this.grid[0] * this.tuning.petScale) / 2;
  }
  get halfH() {
    return (this.grid[1] * this.tuning.petScale) / 2;
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
    const sizeChanged = t.petScale !== this.tuning.petScale;
    this.tuning = t;
    if (sizeChanged) this.resnap();
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
      default:
        this.stepRecover();
    }
  }

  private setMode(m: Mode, duration = 0) {
    this.mode = m;
    this.modeTime = 0;
    this.modeDuration = duration;
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
    this.pos.x += this.vel.x * dt;
    this.pos.y += this.vel.y * dt;

    this.rot += this.angVel * dt;
    this.angVel *= Math.max(0, 1 - T.angularDrag * dt);

    // 快落地时像猫一样自动转正
    const toFloor = this.bounds.bottom - (this.pos.y + this.halfH);
    if (this.vel.y > 0 && toFloor < T.rightingDistance) {
      const target = nearestEquivalent(this.rot, 0);
      const a = approach(T.airRighting, dt);
      this.rot += (target - this.rot) * a;
      this.angVel *= 1 - a;
    }

    this.collideAir();
  }

  private collideAir() {
    const { left, top, right, bottom } = this.bounds;
    // 旋转后的包围盒半宽/半高
    const c = Math.abs(Math.cos(this.rot));
    const s = Math.abs(Math.sin(this.rot));
    const ex = c * this.halfW + s * this.halfH;
    const ey = s * this.halfW + c * this.halfH;

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

  private hitFloor() {
    const T = this.tuning;
    const impact = this.vel.y;
    const vx = this.vel.x;
    const contact = { x: this.pos.x, y: this.bounds.bottom };

    if (impact >= T.splatSpeed) {
      this.attach('floor');
      this.setMode('splat', T.splatHold);
      this.hitstop = T.hitstopSplat;
      this.dizzy = Math.max(this.dizzy, T.splatHold + 1.2);
      this.kickSquash(impact, 'floor');
      this.impact('splat', contact, NORMAL.floor, impact);
      return;
    }
    if (Math.abs(vx) >= T.rollSpeed && Math.abs(vx) >= impact * T.rollBias) {
      const rot = this.rot;
      this.attach('floor', undefined, { keepRot: true });
      this.rot = rot;
      this.pos.y = this.bounds.bottom - this.rollRadius;
      this.vel.x = vx;
      this.setMode('roll');
      this.kickSquash(impact * 0.6, 'floor');
      this.impact('roll', contact, NORMAL.floor, Math.hypot(vx, impact));
      return;
    }
    if (impact >= T.heroSpeed) {
      this.attach('floor');
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
    this.attach('floor');
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

    const r = this.rollRadius;
    const { left, right, bottom } = this.bounds;
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
      this.leaveSurface();
      return;
    }

    if (this.mode === 'walk') {
      const speed = this.side === 'floor' ? T.walkSpeed : T.climbSpeed;
      const [lo, hi] = this.sRange(this.side);
      const s = this.sOf(this.side) + this.dir * speed * dt;
      if (s <= lo || s >= hi) {
        this.atCorner(s <= lo ? 'lo' : 'hi');
      } else {
        this.pos = this.surfacePos(this.side, s);
      }
    }

    if (this.modeTime >= this.modeDuration) {
      if (this.mode === 'idle' && this.dizzy <= 0) {
        this.setMode('walk', rand(T.walkMin, T.walkMax, this.rng));
        this.dir = this.rng() < 0.5 ? 1 : -1;
      } else {
        this.setMode('idle', rand(T.idleMin, T.idleMax, this.rng));
      }
    }
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
    if (this.rng() >= chance) {
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

  // ---------- 面上坐标 ----------

  private sRange(side: Side): [number, number] {
    const { left, top, right, bottom } = this.bounds;
    const hw = this.halfW;
    const [lo, hi] =
      side === 'floor' || side === 'ceiling' ? [left + hw, right - hw] : [top + hw, bottom - hw];
    return [lo, Math.max(lo, hi)];
  }

  private sOf(side: Side): number {
    return side === 'floor' || side === 'ceiling' ? this.pos.x : this.pos.y;
  }

  private surfacePos(side: Side, s: number): Vec2 {
    const { left, top, right, bottom } = this.bounds;
    const hh = this.halfH;
    switch (side) {
      case 'floor':
        return { x: s, y: bottom - hh };
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

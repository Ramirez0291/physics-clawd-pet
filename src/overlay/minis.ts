// 迷你 Clawd：Claude Code 每派出一个子代理，就从天上掉下来一只小号的，落地开始敲电脑；
// 子代理干完活，它蹦一下、噗地消失。它们是完整的物理宠物（会落到窗口上、会躲输入框），只是不能抓。

import { clamp, rand } from '../engine/math';
import { mergeTuning, type Tuning } from '../engine/params';
import type { ParticleSystem } from '../engine/particles';
import { type Activity, type Bounds, Pet, type Platform } from '../engine/pet';
import type { Vec2 } from '../engine/math';

/** 同时最多几只（再多就挤满屏了） */
const MAX = 6;
/** 相对主宠物的大小 */
const SCALE = 0.5;
/** 离开：蹦起来多久后噗地消失（秒） */
const LEAVE_AFTER = 0.35;

interface Mini {
  id: string;
  pet: Pet;
  /** 开始离开的时刻（主循环的模拟时间），null = 还在干活 */
  leftAt: number | null;
}

export class Minis {
  private list: Mini[] = [];
  private t = 0;
  /** 上次同步给小家伙们的主宠物状态（引用比较，变了才同步） */
  private synced: { tuning: Tuning | null; bounds: Bounds | null; platforms: Platform[] | null; zone: Bounds | null } = {
    tuning: null,
    bounds: null,
    platforms: null,
    zone: null,
  };

  constructor(
    private main: Pet,
    private particles: ParticleSystem,
    private look: () => { pixelArt: boolean; dpr: number; particles: boolean },
  ) {}

  get pets(): Pet[] {
    return this.list.map((m) => m.pet);
  }

  get active(): boolean {
    return this.list.length > 0;
  }

  /** 来了一个子代理 */
  spawn(id: string) {
    if (this.list.some((m) => m.id === id)) return;
    if (this.list.filter((m) => m.leftAt === null).length >= MAX) return;
    const main = this.main;
    const { pixelArt, dpr } = this.look();
    const pet = new Pet(this.tuning(), main.grid, main.bounds);
    pet.setPixelRatio(dpr);
    const actions: Activity[] = ['laptop'];
    pet.setGrid(main.grid, { pixelArt, actions });
    pet.setPlatforms(main.platforms);
    pet.setInputZone(main.inputZone);
    pet.setAgentMood('working');
    const b = main.bounds;
    // 在主宠物附近挑几个落点，选离已有的小家伙最远的，别叠在一起
    const others = this.list.map((m) => m.pet.pos.x).concat(main.pos.x);
    let x = main.pos.x;
    let best = -1;
    for (let i = 0; i < 8; i++) {
      const c = clamp(main.pos.x + rand(-320, 320), b.left + 40, b.right - 40);
      const gap = Math.min(...others.map((o) => Math.abs(o - c)));
      if (gap > best) {
        best = gap;
        x = c;
      }
    }
    // 转着圈从天上掉下来
    pet.launch({ x, y: b.top + 30, vx: rand(-200, 200), vy: 0, rot: rand(-1, 1), angVel: rand(-9, 9) });
    this.list.push({ id, pet, leftAt: null });
  }

  /** 子代理干完了 */
  dismiss(id: string) {
    const m = this.list.find((x) => x.id === id);
    if (!m || m.leftAt !== null) return;
    m.leftAt = this.t;
    const p = m.pet;
    p.setAgentMood('idle');
    // 蹦一下就消失
    p.launch({ x: p.pos.x, y: p.pos.y, vx: 0, vy: -900, rot: p.rot, angVel: rand(-10, 10) });
  }

  /** 主宠物换了皮肤：小家伙们跟着换 */
  restyle() {
    const { pixelArt } = this.look();
    for (const m of this.list) m.pet.setGrid(this.main.grid, { pixelArt, actions: ['laptop'] });
  }

  /** 全部收工（会话结束、关掉联动） */
  clear() {
    for (const m of this.list) this.dismiss(m.id);
  }

  step(dt: number, cursor: Vec2 | null) {
    if (!this.list.length) return;
    this.t += dt;
    this.sync();
    const { particles } = this.look();
    for (const m of this.list) {
      m.pet.step(dt, cursor);
      for (const ev of m.pet.consumeEvents()) if (particles) this.particles.handle(ev);
    }
    this.list = this.list.filter((m) => {
      if (m.leftAt === null || this.t - m.leftAt < LEAVE_AFTER) return true;
      this.particles.handle({ type: 'poof', x: m.pet.pos.x, y: m.pet.pos.y });
      return false;
    });
  }

  /** 主宠物的手感参数、屏幕范围、窗口平台、输入框变了：小家伙们跟着变 */
  private sync() {
    const main = this.main;
    const s = this.synced;
    if (s.tuning !== main.tuning) {
      s.tuning = main.tuning;
      const t = this.tuning();
      const { dpr } = this.look();
      for (const m of this.list) {
        m.pet.setTuning(t);
        m.pet.setPixelRatio(dpr);
      }
    }
    if (s.bounds !== main.bounds) {
      s.bounds = main.bounds;
      for (const m of this.list) m.pet.setBounds(main.bounds);
    }
    if (s.platforms !== main.platforms) {
      s.platforms = main.platforms;
      for (const m of this.list) m.pet.setPlatforms(main.platforms);
    }
    if (s.zone !== main.inputZone) {
      s.zone = main.inputZone;
      for (const m of this.list) m.pet.setInputZone(main.inputZone);
    }
  }

  private tuning(): Tuning {
    const t = this.main.tuning;
    // 小号、不乱跳窗口、不自己玩别的（只跟着 Claude 敲电脑）
    return mergeTuning(t, { petScale: t.petScale * SCALE, platformJumpChance: 0.05, activityChance: 0 });
  }
}

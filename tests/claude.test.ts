import { describe, expect, it } from 'vitest';
import { AgentTracker, type CcEvent, STALE_MS, folderName } from '../src/claude/agent';
import { DEFAULT_TUNING, type Tuning } from '../src/engine/params';
import { Pet } from '../src/engine/pet';

const ev = (event: string, t: number, extra: Partial<CcEvent> = {}): CcEvent => ({
  event,
  session_id: 's1',
  cwd: 'E:\\work\\demo',
  t,
  ...extra,
});

describe('Claude Code 会话追踪', () => {
  it('提问 → 思考，用工具 → 干活，结束 → 空闲并且报告这一轮', () => {
    const a = new AgentTracker();
    expect(a.handle(ev('UserPromptSubmit', 1000))).toEqual([]);
    expect(a.mood(1000)).toBe('thinking');
    a.handle(ev('PreToolUse', 2000, { tool_name: 'Bash', tool: 'npm test' }));
    expect(a.mood(2000)).toBe('working');
    // 工具之间不掉回"思考"，免得电脑开开关关
    a.handle(ev('PostToolUse', 3000, { tool_name: 'Bash', tool: 'npm test' }));
    expect(a.mood(3000)).toBe('working');
    const r = a.handle(ev('Stop', 41000, { last: 'done!' }));
    expect(r).toContainEqual({
      kind: 'done',
      session: 's1',
      cwd: 'E:\\work\\demo',
      turnMs: 40000,
      tools: 1,
      last: 'done!',
      window: undefined,
    });
    expect(a.mood(41000)).toBe('idle');
  });

  it('好几个会话：显示最忙的那个；很久没动静的不算', () => {
    const a = new AgentTracker();
    a.handle(ev('UserPromptSubmit', 0, { session_id: 'a' }));
    a.handle(ev('PreToolUse', 0, { session_id: 'b' }));
    expect(a.mood(1000)).toBe('working');
    a.handle(ev('Stop', 2000, { session_id: 'b' }));
    expect(a.mood(2000)).toBe('thinking');
    expect(a.mood(STALE_MS + 1000)).toBe('idle');
  });

  it('压缩上下文：扫地，压完回到原来的状态', () => {
    const a = new AgentTracker();
    a.handle(ev('PreToolUse', 0));
    a.handle(ev('PreCompact', 10, { trigger: 'auto' }));
    expect(a.mood(10)).toBe('compacting');
    a.handle(ev('PostCompact', 20, { trigger: 'auto' }));
    expect(a.mood(20)).toBe('working');
    // 没在干活时手动 /compact：压完就空闲
    const b = new AgentTracker();
    b.handle(ev('PreCompact', 0, { trigger: 'manual' }));
    b.handle(ev('PostCompact', 10, { trigger: 'manual' }));
    expect(b.mood(10)).toBe('idle');
  });

  it('子代理来来去去；会话结束时没走的一起散', () => {
    const a = new AgentTracker();
    expect(a.handle(ev('SubagentStart', 0, { agent_id: 'x' }))).toEqual([{ kind: 'subagent-start', id: 'x' }]);
    a.handle(ev('SubagentStart', 0, { agent_id: 'y' }));
    expect(a.handle(ev('SubagentStop', 1, { agent_id: 'x' }))).toEqual([{ kind: 'subagent-stop', id: 'x' }]);
    // 同一个子代理不会散两次
    expect(a.handle(ev('SubagentStop', 2, { agent_id: 'x' }))).toEqual([]);
    expect(a.handle(ev('SessionEnd', 3, { reason: 'other' }))).toContainEqual({ kind: 'subagent-stop', id: 'y' });
    expect(a.list()).toEqual([]);
  });

  it('出错：工具失败、API 报错会触发；用户自己中断不算', () => {
    const a = new AgentTracker();
    const kinds = (e: CcEvent) => a.handle(e).map((r) => r.kind);
    expect(kinds(ev('PostToolUseFailure', 0, { error: 'exit 1' }))).toContain('error');
    expect(kinds(ev('PostToolUseFailure', 1, { is_interrupt: true }))).not.toContain('error');
    expect(kinds(ev('StopFailure', 2, { error: 'rate_limit' }))).toContain('error');
  });

  it('等你批准的通知', () => {
    const a = new AgentTracker();
    const r = a.handle(ev('Notification', 0, { notification_type: 'permission_prompt', message: 'needs ok', window: 42 }));
    expect(r).toEqual([{ kind: 'attention', session: 's1', cwd: 'E:\\work\\demo', message: 'needs ok', window: 42 }]);
    expect(a.handle(ev('Notification', 1, { notification_type: 'idle_prompt' }))).toEqual([]);
  });

  it('文件夹名', () => {
    expect(folderName('E:\\work\\demo\\')).toBe('demo');
    expect(folderName('/home/me/proj')).toBe('proj');
  });
});

// ---------- 宠物的新动作 ----------

const STEP = 1 / 120;
const W = 1600;
const H = 900;

function makePet(over: Partial<Tuning> = {}) {
  let seed = 11;
  const rng = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
  return new Pet({ ...DEFAULT_TUNING, ...over }, [16, 10], { left: 0, top: 0, right: W, bottom: H }, rng);
}

function run(pet: Pet, seconds: number, until?: (p: Pet) => boolean) {
  const events: string[] = [];
  for (let i = 0; i < seconds / STEP; i++) {
    pet.step(STEP, null);
    for (const e of pet.consumeEvents()) events.push(e.type);
    if (until?.(pet)) break;
  }
  return events;
}

describe('跟着 Claude Code 动', () => {
  it('干活时敲电脑，收工就合上', () => {
    // 关掉随机小动作：不然收工后发呆一会儿可能又自己掏出电脑
    const pet = makePet({ idleMin: 0.2, idleMax: 0.2, activityChance: 0 });
    pet.placeOnFloor(800);
    pet.setAgentMood('working');
    run(pet, 1, (p) => p.mode === 'laptop');
    expect(pet.mode).toBe('laptop');
    run(pet, 20);
    expect(pet.mode).toBe('laptop');
    pet.setAgentMood('idle');
    run(pet, 1);
    expect(pet.mode).not.toBe('laptop');
  });

  it('压缩上下文时扫地，扫的时候扬灰', () => {
    const pet = makePet({ idleMin: 0.2, idleMax: 0.2 });
    pet.placeOnFloor(800);
    pet.setAgentMood('compacting');
    const events = run(pet, 3);
    expect(pet.mode).toBe('sweep');
    expect(events.filter((e) => e === 'sweep').length).toBeGreaterThanOrEqual(3);
    pet.setAgentMood('working');
    run(pet, 1);
    expect(pet.mode).not.toBe('sweep');
  });

  it('思考时原地等着，不乱跑', () => {
    const pet = makePet({ idleMin: 0.1, idleMax: 0.1 });
    pet.placeOnFloor(800);
    pet.setAgentMood('thinking');
    run(pet, 5);
    expect(pet.mode).toBe('idle');
    expect(pet.pos.x).toBe(800);
  });

  it('庆祝：撒彩纸、翻个跟头、落地站好', () => {
    const pet = makePet();
    pet.placeOnFloor(800);
    pet.cue('celebrate');
    expect(pet.mode).toBe('air');
    let spun = 0;
    let last = pet.rot;
    const events: string[] = [];
    for (let i = 0; i < 3 / STEP && !(pet.grounded && pet.mode !== 'air'); i++) {
      pet.step(STEP, null);
      spun += Math.abs(pet.rot - last);
      last = pet.rot;
      for (const e of pet.consumeEvents()) events.push(e.type);
    }
    expect(events).toContain('impact');
    expect(spun).toBeGreaterThan(Math.PI * 1.6);
    expect(pet.side).toBe('floor');
  });

  it('被电：冒火花，然后栽倒晕一会儿', () => {
    const pet = makePet();
    pet.placeOnFloor(800);
    pet.cue('zap');
    expect(pet.mode).toBe('zap');
    const events = run(pet, 1.3, (p) => p.mode === 'splat');
    expect(events.filter((e) => e === 'spark').length).toBeGreaterThan(8);
    expect(events).toContain('smoke');
    expect(pet.mode).toBe('splat');
    expect(pet.dizzy).toBeGreaterThan(0);
  });

  it('跺脚：跑到要敲的窗口底下，跳上去再跺', () => {
    const pet = makePet({ platformJumpChance: 0, activityChance: 0 });
    pet.placeOnFloor(300);
    const win = { id: 99, x0: 900, x1: 1300, y: H - 300 };
    pet.setPlatforms([win]);
    pet.cue('knock', { target: 99 });
    run(pet, 10, (p) => p.mode === 'knock');
    expect(pet.mode).toBe('knock');
    expect(pet.support?.id).toBe(99);
    const events = run(pet, 3);
    expect(events.filter((e) => e === 'impact').length).toBeGreaterThanOrEqual(5);
  });

  it('跺脚：窗口找不到就原地跺', () => {
    const pet = makePet();
    pet.placeOnFloor(300);
    pet.cue('knock', { target: 12345 });
    expect(pet.mode).toBe('knock');
    expect(pet.pos.x).toBe(300);
  });
});

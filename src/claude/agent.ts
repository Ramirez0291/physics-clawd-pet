// Claude Code 会话追踪：把 hooks 事件变成"宠物现在该是什么心情"和"该做什么反应"。
// 纯逻辑，时间从外面传进来，方便测试。可以同时有好几个会话（好几个终端/窗口）。

import type { AgentMood } from '../engine/pet';

/** 原生侧精简过的 hook 事件（见 src-tauri/src/claude.rs 的 summarize） */
export interface CcEvent {
  event: string;
  session_id: string;
  cwd: string;
  /** 事件发生的时间（ms） */
  t: number;
  tool_name?: string;
  /** 工具的一行说明：命令、文件路径、网址…… */
  tool?: string;
  notification_type?: string;
  message?: string;
  title?: string;
  error?: string;
  is_interrupt?: boolean;
  agent_id?: string;
  agent_type?: string;
  trigger?: string;
  reason?: string;
  /** Stop：Claude 最后一句话的开头 */
  last?: string;
  /** 跑着这个会话的窗口（窗口句柄） */
  window?: number;
}

/** 权限请求（原生侧挂着等决定） */
export interface CcPermission extends CcEvent {
  id: number;
}

export type Reaction =
  /** 一轮干完了。turnMs：这一轮用了多久；tools：用了几次工具 */
  | { kind: 'done'; session: string; cwd: string; turnMs: number; tools: number; last?: string; window?: number }
  /** 工具失败 / API 报错 */
  | { kind: 'error'; session: string; message: string }
  | { kind: 'subagent-start'; id: string }
  | { kind: 'subagent-stop'; id: string }
  /** Claude 在等你（权限提示的通知；没装权限 hook 时靠它） */
  | { kind: 'attention'; session: string; cwd: string; message: string; window?: number }
  /**
   * 这个会话往前走了：挂着的权限请求肯定已经处理过了。
   * 带 tool 的只说明这一个工具跑完了（并行的其他工具可能还在等批准）
   */
  | { kind: 'progress'; session: string; tool_name?: string; tool?: string };

interface Session {
  id: string;
  cwd: string;
  mood: AgentMood;
  /** 压缩前的心情（压完恢复） */
  before: AgentMood;
  turnStart: number | null;
  tools: number;
  last: number;
  subagents: Set<string>;
}

/** 多久没动静就当这个会话没在干活了（长时间跑的命令中间也没有事件，所以给宽一点） */
export const STALE_MS = 15 * 60000;
/** 心情优先级：好几个会话同时在跑时，显示最忙的那个 */
const RANK: Record<AgentMood, number> = { idle: 0, thinking: 1, compacting: 2, working: 3 };

export class AgentTracker {
  private sessions = new Map<string, Session>();

  /** 处理一个事件，返回宠物该做的一次性反应 */
  handle(e: CcEvent): Reaction[] {
    const out: Reaction[] = [];
    const id = e.session_id || '?';
    if (e.event === 'SessionEnd') {
      const s = this.sessions.get(id);
      if (s) {
        for (const a of s.subagents) out.push({ kind: 'subagent-stop', id: a });
        this.sessions.delete(id);
      }
      out.push({ kind: 'progress', session: id });
      return out;
    }
    let s = this.sessions.get(id);
    if (!s) {
      s = { id, cwd: e.cwd, mood: 'idle', before: 'idle', turnStart: null, tools: 0, last: e.t, subagents: new Set() };
      this.sessions.set(id, s);
    }
    s.last = Math.max(s.last, e.t);
    if (e.cwd) s.cwd = e.cwd;

    switch (e.event) {
      case 'UserPromptSubmit':
        s.mood = 'thinking';
        s.turnStart = e.t;
        s.tools = 0;
        break;
      case 'PreToolUse':
        s.mood = 'working';
        s.tools++;
        if (s.turnStart === null) s.turnStart = e.t;
        break;
      case 'PostToolUse':
        // 工具之间 Claude 在想下一步，但宠物别电脑开开关关的：保持干活
        if (s.mood === 'idle') s.mood = 'working';
        out.push({ kind: 'progress', session: id, tool_name: e.tool_name ?? '', tool: e.tool ?? '' });
        break;
      case 'PostToolUseFailure':
        out.push({ kind: 'progress', session: id, tool_name: e.tool_name ?? '', tool: e.tool ?? '' });
        // 用户自己按了中断不算出错
        if (!e.is_interrupt) out.push({ kind: 'error', session: id, message: e.error ?? '' });
        break;
      case 'Notification':
        if (e.notification_type === 'permission_prompt') {
          out.push({ kind: 'attention', session: id, cwd: s.cwd, message: e.message ?? '', window: e.window });
        }
        break;
      case 'SubagentStart':
        if (e.agent_id) {
          s.subagents.add(e.agent_id);
          out.push({ kind: 'subagent-start', id: e.agent_id });
        }
        if (s.mood === 'idle' || s.mood === 'thinking') s.mood = 'working';
        break;
      case 'SubagentStop':
        if (e.agent_id && s.subagents.delete(e.agent_id)) out.push({ kind: 'subagent-stop', id: e.agent_id });
        break;
      case 'PreCompact':
        if (s.mood !== 'compacting') s.before = s.mood;
        s.mood = 'compacting';
        break;
      case 'PostCompact':
        if (s.mood === 'compacting') s.mood = s.turnStart !== null ? s.before : 'idle';
        break;
      case 'Stop':
      case 'StopFailure': {
        const turnMs = s.turnStart !== null ? e.t - s.turnStart : 0;
        out.push({ kind: 'progress', session: id });
        if (e.event === 'Stop') {
          out.push({ kind: 'done', session: id, cwd: s.cwd, turnMs, tools: s.tools, last: e.last, window: e.window });
        } else {
          out.push({ kind: 'error', session: id, message: e.error ?? '' });
        }
        // 还没收工的子代理（比如被中断了）也一起散了
        for (const a of s.subagents) out.push({ kind: 'subagent-stop', id: a });
        s.subagents.clear();
        s.mood = 'idle';
        s.turnStart = null;
        s.tools = 0;
        break;
      }
    }
    return out;
  }

  /** 所有还活跃的会话里最忙的那个心情；顺便清掉很久没动静的会话 */
  mood(now: number): AgentMood {
    let best: AgentMood = 'idle';
    for (const [id, s] of this.sessions) {
      if (now - s.last > STALE_MS) {
        if (s.mood !== 'idle' || now - s.last > 4 * STALE_MS) this.sessions.delete(id);
        continue;
      }
      if (RANK[s.mood] > RANK[best]) best = s.mood;
    }
    return best;
  }

  /** 给小助手窗口显示的会话列表 */
  list(): { id: string; cwd: string; mood: AgentMood; last: number; subagents: number }[] {
    return [...this.sessions.values()]
      .map((s) => ({ id: s.id, cwd: s.cwd, mood: s.mood, last: s.last, subagents: s.subagents.size }))
      .sort((a, b) => b.last - a.last);
  }
}

/** 路径的最后一段（项目文件夹名） */
export function folderName(cwd: string): string {
  const parts = cwd.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}

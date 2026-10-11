// 覆盖层里的 Claude Code 联动：收原生侧转来的 hooks 事件，让宠物跟着 Claude 的状态动起来。
//   思考 → 头顶冒省略号；干活 → 敲电脑；压缩上下文 → 扫地（见 Pet.setAgentMood）
//   一轮干完 → 后空翻撒彩纸；出错 → 被电；子代理 → 迷你 Clawd
//   要你批准 → 跑到那个终端窗口上跺脚，头顶气泡上可以直接点允许/拒绝

import { AgentTracker, type CcEvent, type CcPermission, type Reaction, folderName } from '../claude/agent';
import { T } from '../assistant/i18n';
import type { ClaudeSettings } from '../assistant/model';
import type { Pet } from '../engine/pet';
import { type Bus, ccDecide } from '../platform/host';
import type { Bubbles } from './bubbles';
import type { Minis } from './minis';

/** 同一会话一轮干了多久才值得庆祝（用了工具也算） */
const CELEBRATE_MS = 8000;
/** 干了多久才在完成时冒气泡（你多半离开电脑了） */
const DONE_BUBBLE_MS = 30000;
const DONE_BUBBLE_SHOW = 8000;
/** 被电的冷却：连着失败好几次别一直电 */
const ZAP_COOLDOWN = 10000;

/** 发给小助手窗口的联动状态 */
export interface ClaudeLive {
  sessions: ReturnType<AgentTracker['list']>;
  pending: number;
}

export class ClaudeLink {
  private tracker = new AgentTracker();
  private perms = new Map<number, CcPermission>();
  private lastZap = -Infinity;

  constructor(
    private bus: Bus,
    private pet: Pet,
    private bubbles: Bubbles,
    private minis: Minis,
    private settings: () => ClaudeSettings,
  ) {}

  start() {
    this.bus.on('cc-event', (e: CcEvent) => this.onEvent(e));
    this.bus.on('cc-permission', (p: CcPermission) => this.onPermission(p));
    this.bus.on('cc-permission-gone', (m: { id: number }) => this.dropPermission(m.id));
    this.bus.on('cc-hello', () => this.publish());
    window.setInterval(() => this.updateMood(), 2000);
  }

  private onEvent(e: CcEvent) {
    for (const r of this.tracker.handle(e)) this.react(r);
    this.updateMood();
    this.publish();
  }

  private updateMood() {
    this.pet.setAgentMood(this.tracker.mood(Date.now()));
  }

  private publish() {
    const live: ClaudeLive = { sessions: this.tracker.list(), pending: this.perms.size };
    this.bus.emit('cc-live', live);
  }

  private react(r: Reaction) {
    const s = this.settings();
    switch (r.kind) {
      case 'done':
        if (s.celebrate && (r.tools > 0 || r.turnMs >= CELEBRATE_MS)) this.pet.cue('celebrate');
        if (s.doneBubble && r.turnMs >= DONE_BUBBLE_MS) {
          this.bubbles.post({
            key: `done:${r.session}`,
            kind: 'claude',
            title: T.ccDone(folderName(r.cwd)),
            body: r.last,
            buttons: [],
            hideAfter: DONE_BUBBLE_SHOW,
          });
        }
        break;
      case 'error': {
        const now = Date.now();
        if (s.zap && now - this.lastZap >= ZAP_COOLDOWN) {
          this.lastZap = now;
          this.pet.cue('zap');
        }
        break;
      }
      case 'subagent-start':
        if (s.minis) this.minis.spawn(r.id);
        break;
      case 'subagent-stop':
        this.minis.dismiss(r.id);
        break;
      case 'attention': {
        // 已经有这个会话的权限气泡了（装了权限 hook）：通知是重复的
        if ([...this.perms.values()].some((p) => p.session_id === r.session)) break;
        this.bubbles.post({
          key: `attn:${r.session}`,
          kind: 'claude',
          title: T.ccWaiting,
          body: [folderName(r.cwd), r.message].filter(Boolean).join('\n'),
          buttons: [{ label: T.gotIt, primary: true, run: () => {} }],
          priority: 1,
          onShow: () => this.pet.cue('knock', { target: r.window ?? null }),
        });
        break;
      }
      case 'progress':
        // 会话往前走了：挂着的权限请求、"在等你"的提示都过时了
        for (const [id, p] of this.perms) {
          if (p.session_id !== r.session) continue;
          if (r.tool_name !== undefined && (p.tool_name !== r.tool_name || p.tool !== r.tool)) continue;
          this.dropPermission(id);
        }
        this.bubbles.retract(`attn:${r.session}`);
        break;
    }
  }

  private onPermission(p: CcPermission) {
    this.perms.set(p.id, p);
    const decide = (b: 'allow' | 'deny' | 'pass') => {
      this.perms.delete(p.id);
      void ccDecide(p.id, b);
      this.publish();
    };
    this.bubbles.post({
      key: `perm:${p.id}`,
      kind: 'claude',
      title: T.ccPermTitle(p.tool_name ?? ''),
      body: `${folderName(p.cwd)} · ${T.ccPermHint}`,
      code: p.tool,
      buttons: [
        { label: T.ccAllow, primary: true, run: () => decide('allow') },
        { label: T.ccDeny, run: () => decide('deny') },
      ],
      priority: 2,
      onShow: () => this.pet.cue('knock', { target: p.window ?? null }),
      onClose: () => decide('pass'),
      valid: () => this.perms.has(p.id),
    });
    this.bubbles.retract(`attn:${p.session_id}`);
    this.publish();
  }

  /** 权限请求已经在别处处理了（终端里选了、hook 超时了） */
  private dropPermission(id: number) {
    this.perms.delete(id);
    this.bubbles.retract(`perm:${id}`);
    this.publish();
  }
}

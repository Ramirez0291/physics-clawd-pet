// 覆盖层里的小助手：定时检查该不该提醒，提醒时在宠物头顶冒一个气泡（见 bubbles.ts），宠物配合做动作。
// 数据（待办、设置）存在原生侧，小助手窗口改了会广播过来；日程在这里下载解析。

import { CalendarCache, type SourceStatus } from '../assistant/calendar';
import type { CalEvent } from '../assistant/ical';
import { T, dayLabel, hhmm } from '../assistant/i18n';
import { type AssistantData, DEFAULT_ASSISTANT, dueTime, sanitizeAssistant, toDue } from '../assistant/model';
import { type Reminder, Scheduler } from '../assistant/scheduler';
import type { Pet } from '../engine/pet';
import { type Bus, idleMs, loadAssistant, saveAssistant } from '../platform/host';
import type { BubbleButton, Bubbles } from './bubbles';

const MIN = 60000;
/** 多久检查一次（秒级就够，整点报时允许晚几秒） */
const TICK_MS = 5000;
/** 报时气泡自己消失；排队太久的报时就不报了 */
const CHIME_SHOW_MS = 8000;
const CHIME_STALE_MS = 2 * MIN;
/** 休息提醒没人理就收起来（过 repeatMin 还会再提醒） */
const REST_SHOW_MS = 2 * MIN;

/** 发给小助手窗口的运行状态 */
export interface AssistantStatus {
  sources: Record<string, SourceStatus | null>;
  upcoming: CalEvent[];
  activeMin: number;
}

/** 小助手：报时、休息、日程、待办。气泡交给 Bubbles 显示 */
export class Companion {
  private _data: AssistantData = structuredClone(DEFAULT_ASSISTANT);
  private scheduler = new Scheduler(Date.now());
  private calendar = new CalendarCache();
  private ticking = false;
  /** 数据变了（包括别的窗口改的）时回调 */
  onData: (d: AssistantData) => void = () => {};

  constructor(
    private bus: Bus,
    private pet: Pet,
    private bubbles: Bubbles,
  ) {}

  get data(): AssistantData {
    return this._data;
  }

  async start() {
    this.setData(sanitizeAssistant(await loadAssistant()));
    this.calendar.onChange = () => this.publish();
    this.bus.on('assistant-data', (d: unknown) => this.setData(sanitizeAssistant(d)));
    this.bus.on('assistant-hello', () => this.publish());
    this.bus.on('assistant-cmd', (msg: { cmd: string; kind?: Reminder['kind'] }) => {
      if (msg.cmd === 'refresh') this.calendar.refresh(Date.now());
      else if (msg.cmd === 'test' && msg.kind) this.enqueue(this.sample(msg.kind), true);
    });
    window.setInterval(() => void this.tick(), TICK_MS);
    window.setInterval(() => this.publish(), MIN);
    void this.tick();
  }

  // ---------- 数据 ----------

  private setData(d: AssistantData) {
    this._data = d;
    this.calendar.setSources(d.calendar.sources, Date.now());
    this.onData(d);
    this.publish();
  }

  /** 改一下数据并存盘（存盘后会广播回来） */
  private update(fn: (d: AssistantData) => void) {
    const d = structuredClone(this._data);
    fn(d);
    this._data = d;
    void saveAssistant(d).catch((e) => console.warn('保存小助手数据失败', e));
  }

  private publish() {
    const now = Date.now();
    const status: AssistantStatus = {
      sources: Object.fromEntries(this._data.calendar.sources.map((s) => [s.id, this.calendar.status(s.id)])),
      upcoming: this.calendar
        .events()
        .filter((e) => e.end > now && e.start < now + 7 * 24 * 60 * MIN)
        .slice(0, 50),
      activeMin: Math.floor(this.scheduler.activeMs(now) / MIN),
    };
    this.bus.emit('assistant-status', status);
  }

  private async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const idle = await idleMs();
      const now = Date.now();
      this.calendar.tick(now, this._data.calendar.refreshMin);
      for (const r of this.scheduler.tick(now, idle, this._data, this.calendar.events())) this.enqueue(r);
    } finally {
      this.ticking = false;
    }
  }

  // ---------- 排队 ----------

  private enqueue(r: Reminder, front = false) {
    // 报时、休息同时只留一条
    const key = r.kind === 'rest' || r.kind === 'chime' ? r.kind : r.key;
    const at = Date.now();
    const c = this.content(r);
    this.bubbles.post(
      {
        key,
        kind: r.kind,
        ...c,
        onShow: () => this.cue(r),
        valid: () => {
          const now = Date.now();
          if (r.kind === 'chime') return now - at <= CHIME_STALE_MS;
          if (r.kind === 'event') return now < r.event.end;
          return true;
        },
      },
      front,
    );
    // 到点的待办记下来，重启后不会再提醒一遍（"稍后提醒"只在内存里）
    if (r.kind === 'todo') {
      this.update((d) => {
        const t = d.todos.find((x) => x.id === r.todoId);
        if (t && t.due === r.due) t.reminded = true;
      });
    }
  }

  /** 宠物配合做的动作 */
  private cue(r: Reminder) {
    switch (r.kind) {
      case 'chime':
        this.pet.cue('chime', { count: r.hour % 12 || 12 });
        break;
      case 'rest':
        this.pet.cue('stretch');
        break;
      case 'event':
        this.pet.cue('sign', { sign: 'event' });
        break;
      case 'todo':
        this.pet.cue('sign', { sign: 'todo' });
        break;
    }
  }

  private content(r: Reminder): { title: string; body: string; buttons: BubbleButton[]; hideAfter: number } {
    const now = Date.now();
    switch (r.kind) {
      case 'chime':
        return { title: T.chimeTitle(r.hour), body: T.chimeBody(r.hour), buttons: [], hideAfter: CHIME_SHOW_MS };
      case 'rest':
        return {
          title: T.restTitle,
          body: T.restBody(r.workedMin),
          buttons: [
            { label: T.restOk, primary: true, run: () => {} },
            { label: T.restLater, run: () => {} },
          ],
          hideAfter: REST_SHOW_MS,
        };
      case 'event': {
        const e = r.event;
        const name = e.title || T.untitled;
        const where = e.location ? ` · ${e.location}` : '';
        if (e.allDay) return { title: T.eventToday + name, body: T.allDay + where, buttons: [], hideAfter: 0 };
        const mins = Math.ceil((e.start - now) / MIN);
        const buttons: BubbleButton[] = [{ label: T.gotIt, primary: true, run: () => {} }];
        if (e.start - now > MIN) {
          buttons.push({
            label: T.remindAtStart,
            run: () => this.scheduler.snooze(r, Date.now(), Math.max(0, e.start - Date.now())),
          });
        }
        return {
          title: (mins > 0 ? T.eventSoon(mins) : T.eventNow) + name,
          body: `${dayLabel(e.start, now)} ${hhmm(e.start)}–${hhmm(e.end)}${where}`,
          buttons,
          hideAfter: 0,
        };
      }
      case 'todo': {
        const due = dueTime(r.due);
        const when = `${dayLabel(due, now)} ${hhmm(due)}`;
        return {
          title: T.todoTitle,
          body: `${r.text}\n${now - due > MIN ? T.todoOverdue(when) : T.todoDue(when)}`,
          buttons: [
            {
              label: T.todoDone,
              primary: true,
              run: () => {
                this.scheduler.forget(r.key);
                this.update((d) => {
                  const t = d.todos.find((x) => x.id === r.todoId);
                  if (t) t.done = true;
                });
              },
            },
            { label: T.remindLater, run: () => this.scheduler.snooze(r, Date.now(), 10 * MIN) },
          ],
          hideAfter: 0,
        };
      }
    }
  }

  /** 小助手窗口里的"试一下"：用真实数据或者编一条 */
  private sample(kind: Reminder['kind']): Reminder {
    const now = Date.now();
    switch (kind) {
      case 'chime':
        return { kind, key: `test:${now}`, hour: new Date(now).getHours() };
      case 'rest':
        return { kind, key: `test:${now}`, workedMin: this._data.rest.workMin };
      case 'event': {
        const e = this.calendar.events().find((x) => x.start > now) ?? {
          uid: 'test',
          title: T.sampleEvent,
          location: '',
          start: now + this._data.calendar.leadMin * MIN,
          end: now + (this._data.calendar.leadMin + 30) * MIN,
          allDay: false,
        };
        return { kind, key: `test:${now}`, event: e };
      }
      case 'todo': {
        const t = this._data.todos.find((x) => !x.done);
        // todoId 留空：在试用的气泡上点"完成啦"不会真的勾掉待办
        return {
          kind,
          key: `test:${now}`,
          todoId: '',
          text: t?.text ?? T.sampleTodo,
          due: t?.due ?? toDue(now),
        };
      }
    }
  }
}

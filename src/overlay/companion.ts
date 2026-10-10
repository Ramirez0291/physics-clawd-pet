// 覆盖层里的小助手：定时检查该不该提醒，提醒时在宠物头顶冒一个气泡，宠物配合做动作。
// 数据（待办、设置）存在原生侧，小助手窗口改了会广播过来；日程在这里下载解析。

import { CalendarCache, type SourceStatus } from '../assistant/calendar';
import type { CalEvent } from '../assistant/ical';
import { T, dayLabel, hhmm } from '../assistant/i18n';
import { type AssistantData, DEFAULT_ASSISTANT, dueTime, sanitizeAssistant, toDue } from '../assistant/model';
import { type Reminder, Scheduler } from '../assistant/scheduler';
import type { Pet } from '../engine/pet';
import { type Bus, type HitRect, idleMs, loadAssistant, saveAssistant } from '../platform/host';

const MIN = 60000;
/** 多久检查一次（秒级就够，整点报时允许晚几秒） */
const TICK_MS = 5000;
/** 报时气泡自己消失；排队太久的报时就不报了 */
const CHIME_SHOW_MS = 8000;
const CHIME_STALE_MS = 2 * MIN;
/** 休息提醒没人理就收起来（过 repeatMin 还会再提醒） */
const REST_SHOW_MS = 2 * MIN;
const GAP_MS = 400;

/** 发给小助手窗口的运行状态 */
export interface AssistantStatus {
  sources: Record<string, SourceStatus | null>;
  upcoming: CalEvent[];
  activeMin: number;
}

interface Button {
  label: string;
  primary?: boolean;
  run: () => void;
}

interface Shown {
  reminder: Reminder;
  el: HTMLDivElement;
  w: number;
  h: number;
  hideAt: number | null;
}

export class Companion {
  private data: AssistantData = structuredClone(DEFAULT_ASSISTANT);
  private scheduler = new Scheduler(Date.now());
  private calendar = new CalendarCache();
  private queue: { reminder: Reminder; at: number }[] = [];
  private shown: Shown | null = null;
  private nextShowAt = 0;
  private rect: HitRect | null = null;
  private ticking = false;

  constructor(
    private bus: Bus,
    private pet: Pet,
    /** 宠物现在的包围盒（含道具），没画出来为 null */
    private anchor: () => HitRect | null,
    /** 覆盖层被隐藏（全屏免打扰、手动隐藏） */
    private hidden: () => boolean,
  ) {}

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

  /** 每帧调用：摆好气泡的位置，返回它的可点击区域 */
  frame(now: number): HitRect | null {
    if (this.hidden()) {
      // 隐藏期间气泡先收回队列里，回来再弹
      if (this.shown) {
        this.queue.unshift({ reminder: this.shown.reminder, at: Date.now() });
        this.remove(false);
      }
      return null;
    }
    if (this.shown?.hideAt && now >= this.shown.hideAt) this.dismiss();
    if (!this.shown && this.queue.length && now >= this.nextShowAt) this.showNext();
    this.pet.attentive = this.shown !== null;
    return this.place();
  }

  // ---------- 数据 ----------

  private setData(d: AssistantData) {
    this.data = d;
    this.calendar.setSources(d.calendar.sources, Date.now());
    this.publish();
  }

  /** 改一下数据并存盘（存盘后会广播回来） */
  private update(fn: (d: AssistantData) => void) {
    const d = structuredClone(this.data);
    fn(d);
    this.data = d;
    void saveAssistant(d).catch((e) => console.warn('保存小助手数据失败', e));
  }

  private publish() {
    const now = Date.now();
    const status: AssistantStatus = {
      sources: Object.fromEntries(this.data.calendar.sources.map((s) => [s.id, this.calendar.status(s.id)])),
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
      this.calendar.tick(now, this.data.calendar.refreshMin);
      for (const r of this.scheduler.tick(now, idle, this.data, this.calendar.events())) this.enqueue(r);
    } finally {
      this.ticking = false;
    }
  }

  // ---------- 排队 ----------

  private enqueue(r: Reminder, front = false) {
    const same = (x: Reminder) => x.key === r.key || (x.kind === r.kind && (r.kind === 'rest' || r.kind === 'chime'));
    if (this.shown && same(this.shown.reminder)) return;
    this.queue = this.queue.filter((q) => !same(q.reminder));
    const item = { reminder: r, at: Date.now() };
    if (front) this.queue.unshift(item);
    else this.queue.push(item);
    // 到点的待办记下来，重启后不会再提醒一遍（"稍后提醒"只在内存里）
    if (r.kind === 'todo') {
      this.update((d) => {
        const t = d.todos.find((x) => x.id === r.todoId);
        if (t && t.due === r.due) t.reminded = true;
      });
    }
  }

  private showNext() {
    const now = Date.now();
    while (this.queue.length) {
      const { reminder, at } = this.queue.shift()!;
      if (reminder.kind === 'chime' && now - at > CHIME_STALE_MS) continue;
      if (reminder.kind === 'event' && now >= reminder.event.end) continue;
      this.show(reminder);
      return;
    }
  }

  // ---------- 气泡 ----------

  private show(r: Reminder) {
    const { title, body, buttons, hideAfter } = this.content(r);
    const el = document.createElement('div');
    el.className = `bubble kind-${r.kind}`;
    const close = document.createElement('button');
    close.className = 'bubble-x';
    close.textContent = '×';
    close.title = T.close;
    close.onclick = () => this.dismiss();
    const h = document.createElement('div');
    h.className = 'bubble-title';
    h.textContent = title;
    el.append(close, h);
    if (body) {
      const b = document.createElement('div');
      b.className = 'bubble-body';
      b.textContent = body;
      el.append(b);
    }
    if (buttons.length) {
      const row = document.createElement('div');
      row.className = 'bubble-actions';
      for (const btn of buttons) {
        const e = document.createElement('button');
        e.textContent = btn.label;
        if (btn.primary) e.className = 'primary';
        e.onclick = () => {
          btn.run();
          this.dismiss();
        };
        row.append(e);
      }
      el.append(row);
    } else {
      // 没有按钮的（报时）：点哪儿都关
      el.onclick = () => this.dismiss();
    }
    document.body.append(el);
    this.shown = { reminder: r, el, w: el.offsetWidth, h: el.offsetHeight, hideAt: hideAfter ? performance.now() + hideAfter : null };
    requestAnimationFrame(() => el.classList.add('in'));
    this.cue(r);
  }

  private dismiss() {
    this.remove(true);
  }

  private remove(animate: boolean) {
    const s = this.shown;
    if (!s) return;
    this.shown = null;
    this.rect = null;
    this.nextShowAt = performance.now() + GAP_MS;
    if (!animate) {
      s.el.remove();
      return;
    }
    s.el.classList.remove('in');
    s.el.style.pointerEvents = 'none';
    window.setTimeout(() => s.el.remove(), 200);
  }

  /** 气泡放在宠物头顶（放不下就放脚下），水平方向夹在屏幕里，小尾巴指着宠物 */
  private place(): HitRect | null {
    const s = this.shown;
    const a = this.anchor();
    if (!s || !a) {
      this.rect = null;
      return null;
    }
    const W = window.innerWidth;
    const H = window.innerHeight;
    const margin = 8;
    const gap = 14;
    const cx = (a[0] + a[2]) / 2;
    const left = Math.round(Math.min(W - s.w - margin, Math.max(margin, cx - s.w / 2)));
    let top = a[1] - gap - s.h;
    const below = top < margin;
    if (below) top = Math.min(H - s.h - margin, a[3] + gap);
    top = Math.round(top);
    const tail = Math.round(Math.min(s.w - 16, Math.max(16, cx - left)));
    s.el.style.transform = `translate(${left}px, ${top}px)`;
    s.el.style.setProperty('--tail', `${tail}px`);
    s.el.classList.toggle('below', below);
    this.rect = [left, top, left + s.w, top + s.h];
    return this.rect;
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

  private content(r: Reminder): { title: string; body: string; buttons: Button[]; hideAfter: number } {
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
        const buttons: Button[] = [{ label: T.gotIt, primary: true, run: () => {} }];
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
        return { kind, key: `test:${now}`, workedMin: this.data.rest.workMin };
      case 'event': {
        const e = this.calendar.events().find((x) => x.start > now) ?? {
          uid: 'test',
          title: T.sampleEvent,
          location: '',
          start: now + this.data.calendar.leadMin * MIN,
          end: now + (this.data.calendar.leadMin + 30) * MIN,
          allDay: false,
        };
        return { kind, key: `test:${now}`, event: e };
      }
      case 'todo': {
        const t = this.data.todos.find((x) => !x.done);
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

// 什么时候该提醒什么：整点报时、休息、日程、待办。纯逻辑，时间都从外面传进来，方便测试。

import type { CalEvent } from './ical';
import { type AssistantData, dueTime } from './model';

const MIN = 60000;
/** 整点过了几分钟还算"整点"（电脑刚从睡眠醒来时别补报） */
const CHIME_GRACE = 3 * MIN;
/** 日程开始后几分钟内还会提醒（提醒的时候正好没开机） */
const EVENT_GRACE = 5 * MIN;

export type Reminder =
  | { kind: 'chime'; key: string; hour: number }
  | { kind: 'rest'; key: string; workedMin: number }
  | { kind: 'event'; key: string; event: CalEvent }
  | { kind: 'todo'; key: string; todoId: string; text: string; due: string };

const hourKey = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}-${d.getHours()}`;
};

/** from..to（含两头），to < from 表示跨午夜 */
export const inHours = (h: number, from: number, to: number) => (from <= to ? h >= from && h <= to : h >= from || h <= to);

/** 全天事件当天几点提醒 */
function allDayRemindAt(e: CalEvent, hour: number): number {
  const d = new Date(e.start);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), hour).getTime();
}

export class Scheduler {
  private lastChime: string;
  private lastTick: number | null = null;
  /** 这一段连续使用从什么时候开始；null = 人不在 */
  private activeSince: number | null = null;
  private lastRest: number | null = null;
  /** 已经提醒过的日程/待办 → 什么时候可以忘掉它 */
  private fired = new Map<string, number>();
  private snoozed = new Map<string, { at: number; reminder: Reminder }>();

  constructor(now: number) {
    // 启动那一刻不补报当前这个整点
    this.lastChime = hourKey(now);
  }

  /** 这一段已经连续用了多久（毫秒），人不在为 0 */
  activeMs(now: number): number {
    return this.activeSince === null ? 0 : now - this.activeSince;
  }

  /**
   * 每隔几秒调用一次。idleMs：距离上一次键盘/鼠标操作多久。
   * events：最近一段时间的日程（已展开重复）。返回这一刻该弹出的提醒。
   */
  tick(now: number, idleMs: number, data: AssistantData, events: CalEvent[]): Reminder[] {
    const out: Reminder[] = [];
    this.tickChime(now, data, out);
    this.tickRest(now, idleMs, data, out);
    this.tickEvents(now, data, events, out);
    this.tickTodos(now, data, out);
    this.tickSnoozed(now, data, events, out);
    for (const [k, until] of this.fired) if (until < now) this.fired.delete(k);
    this.lastTick = now;
    return out;
  }

  /** 过一会儿再提醒一次 */
  snooze(r: Reminder, now: number, ms: number) {
    this.snoozed.set(r.key, { at: now + ms, reminder: r });
  }

  /** 这条不用再提醒了（比如待办已经勾掉） */
  forget(key: string) {
    this.snoozed.delete(key);
  }

  private tickChime(now: number, data: AssistantData, out: Reminder[]) {
    const key = hourKey(now);
    if (key === this.lastChime) return;
    this.lastChime = key;
    const d = new Date(now);
    const c = data.chime;
    if (!c.enabled || d.getMinutes() * MIN + d.getSeconds() * 1000 > CHIME_GRACE) return;
    if (!inHours(d.getHours(), c.from, c.to)) return;
    out.push({ kind: 'chime', key: `chime:${key}`, hour: d.getHours() });
  }

  private tickRest(now: number, idleMs: number, data: AssistantData, out: Reminder[]) {
    const r = data.rest;
    const away = r.awayMin * MIN;
    // 离开够久，或者电脑睡了一觉（两次 tick 隔了很久）：算休息过了
    const slept = this.lastTick !== null && now - this.lastTick >= away;
    if (idleMs >= away || slept) {
      this.activeSince = null;
      this.lastRest = null;
      if (idleMs >= away) return;
    }
    if (this.activeSince === null) this.activeSince = now - Math.min(idleMs, away);
    if (!r.enabled) return;
    const due = this.lastRest !== null ? this.lastRest + r.repeatMin * MIN : this.activeSince + r.workMin * MIN;
    if (now < due) return;
    this.lastRest = now;
    out.push({ kind: 'rest', key: 'rest', workedMin: Math.round((now - this.activeSince) / MIN) });
  }

  private tickEvents(now: number, data: AssistantData, events: CalEvent[], out: Reminder[]) {
    const lead = data.calendar.leadMin * MIN;
    for (const e of events) {
      const key = `event:${e.uid}@${e.start}`;
      if (this.fired.has(key) || this.snoozed.has(key)) continue;
      const at = e.allDay ? allDayRemindAt(e, data.calendar.allDayHour) : e.start - lead;
      const until = e.allDay ? e.end : e.start + EVENT_GRACE;
      if (now < at || now >= until) continue;
      this.fired.set(key, Math.max(e.end, until) + MIN);
      out.push({ kind: 'event', key, event: e });
    }
  }

  private tickTodos(now: number, data: AssistantData, out: Reminder[]) {
    for (const t of data.todos) {
      if (t.done || !t.due || t.reminded) continue;
      const key = `todo:${t.id}@${t.due}`;
      if (this.fired.has(key) || this.snoozed.has(key) || now < dueTime(t.due)) continue;
      // 存盘把 reminded 写回去之前别重复提醒；一天后还没写回去就再提醒一次
      this.fired.set(key, now + 24 * 60 * MIN);
      out.push({ kind: 'todo', key, todoId: t.id, text: t.text, due: t.due });
    }
  }

  private tickSnoozed(now: number, data: AssistantData, events: CalEvent[], out: Reminder[]) {
    for (const [key, s] of this.snoozed) {
      if (now < s.at) continue;
      this.snoozed.delete(key);
      const r = s.reminder;
      // 睡觉期间待办被勾掉/删掉了，或者日程已经结束了：不用再提醒
      if (r.kind === 'todo') {
        const t = data.todos.find((x) => x.id === r.todoId);
        if (!t || t.done || t.due !== r.due) continue;
      } else if (r.kind === 'event') {
        const e = events.find((x) => `event:${x.uid}@${x.start}` === key) ?? r.event;
        if (now >= e.end) continue;
      }
      out.push(r);
    }
  }
}

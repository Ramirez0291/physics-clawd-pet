// 日历订阅的缓存：按设置的间隔下载/读取每个来源，解析出最近几天的日程。

import { fetchText, readTextFile } from '../platform/host';
import { T } from './i18n';
import { type CalEvent, parseCalendar } from './ical';
import { type CalendarSource, normalizeUrl } from './model';

const DAY = 86400000;
/** 解析的时间窗口：昨天到 8 天后（全天事件和"即将开始"都够用） */
const BEHIND = DAY;
const AHEAD = 8 * DAY;
/** 窗口往前滑了这么多就重新解析一遍 */
const REPARSE = 3600000;

export interface SourceStatus {
  ok: boolean;
  error: string | null;
  /** 窗口里有几个日程 */
  count: number;
  /** 上次成功读取的时间 */
  fetchedAt: number | null;
}

interface Entry {
  key: string;
  text: string | null;
  events: CalEvent[];
  status: SourceStatus;
  parsedAt: number;
  loading: boolean;
}

const keyOf = (s: CalendarSource) => `${s.kind}:${s.target}`;

export class CalendarCache {
  private entries = new Map<string, Entry>();
  private sources: CalendarSource[] = [];
  private lastRefresh = 0;
  /** 有新数据（下载完成、出错）时回调 */
  onChange: () => void = () => {};

  /** 设置变了：新来源马上读，删掉的来源丢掉 */
  setSources(list: CalendarSource[], now: number) {
    this.sources = list.filter((s) => s.enabled);
    const keep = new Set(this.sources.map(keyOf));
    for (const k of this.entries.keys()) if (!keep.has(k)) this.entries.delete(k);
    for (const s of this.sources) if (!this.entries.has(keyOf(s))) void this.load(s, now);
  }

  /** 定时调用：到刷新间隔了就重新下载，窗口滑动了就重新解析 */
  tick(now: number, refreshMin: number) {
    if (now - this.lastRefresh >= refreshMin * 60000) this.refresh(now);
    for (const e of this.entries.values()) {
      if (e.text !== null && now - e.parsedAt >= REPARSE) this.parse(e, now);
    }
  }

  refresh(now: number) {
    this.lastRefresh = now;
    for (const s of this.sources) void this.load(s, now);
  }

  /** 所有来源的日程合在一起，按开始时间排序 */
  events(): CalEvent[] {
    return [...this.entries.values()].flatMap((e) => e.events).sort((a, b) => a.start - b.start);
  }

  status(id: string): SourceStatus | null {
    const s = this.sources.find((x) => x.id === id);
    return s ? (this.entries.get(keyOf(s))?.status ?? null) : null;
  }

  private async load(s: CalendarSource, now: number) {
    const key = keyOf(s);
    let e = this.entries.get(key);
    if (!e) {
      e = {
        key,
        text: null,
        events: [],
        status: { ok: false, error: null, count: 0, fetchedAt: null },
        parsedAt: 0,
        loading: false,
      };
      this.entries.set(key, e);
    }
    if (e.loading) return;
    e.loading = true;
    try {
      const text = s.kind === 'url' ? await fetchText(normalizeUrl(s.target)) : await readTextFile(s.target);
      if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error(T.calNotIcal);
      e.text = text;
      e.status = { ...e.status, ok: true, error: null, fetchedAt: Date.now() };
      this.parse(e, now);
    } catch (err) {
      // 下载失败：保留上一次的日程，只标记错误
      e.status = { ...e.status, ok: false, error: String((err as Error)?.message ?? err) };
    } finally {
      e.loading = false;
    }
    // 下载期间这个来源被删掉了
    if (this.entries.get(key) !== e) return;
    this.onChange();
  }

  private parse(e: Entry, now: number) {
    e.parsedAt = now;
    try {
      e.events = parseCalendar(e.text!, now - BEHIND, now + AHEAD);
      e.status = { ...e.status, count: e.events.length };
    } catch (err) {
      e.status = { ...e.status, ok: false, error: T.calParseFailed(String(err)) };
    }
  }
}

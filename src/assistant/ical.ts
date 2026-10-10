// iCalendar（RFC 5545）的最小子集：够读 Google / Outlook / 飞书 / 钉钉导出的订阅日历。
// 支持：VEVENT、全天事件、UTC / TZID / 浮动时间、DTEND 或 DURATION、
// RRULE（DAILY / WEEKLY / MONTHLY / YEARLY，INTERVAL、COUNT、UNTIL、BYDAY、BYMONTHDAY、BYMONTH）、
// EXDATE、RECURRENCE-ID 改期、STATUS:CANCELLED。

export interface CalEvent {
  uid: string;
  title: string;
  location: string;
  /** 开始/结束（epoch ms） */
  start: number;
  end: number;
  allDay: boolean;
}

/** 一个"墙上时间"：年月日时分秒，不带时区 */
interface Wall {
  y: number;
  mo: number; // 1..12
  d: number;
  h: number;
  mi: number;
  s: number;
}

/** 时间值：墙上时间 + 怎么解释它 */
interface Stamp {
  wall: Wall;
  /** 'utc'：以 Z 结尾；'local'：浮动时间或全天；其他：IANA 时区名 */
  zone: string;
  date: boolean;
}

interface Prop {
  name: string;
  params: Record<string, string>;
  value: string;
}

interface RawEvent {
  uid: string;
  title: string;
  location: string;
  start: Stamp | null;
  end: Stamp | null;
  duration: number | null;
  rrule: Record<string, string> | null;
  exdates: Stamp[];
  recurrenceId: Stamp | null;
  cancelled: boolean;
}

// ---------- 时区 ----------

/** Outlook / Exchange 导出时常用 Windows 时区名 */
const WINDOWS_ZONES: Record<string, string> = {
  'China Standard Time': 'Asia/Shanghai',
  'Taipei Standard Time': 'Asia/Taipei',
  'Tokyo Standard Time': 'Asia/Tokyo',
  'Korea Standard Time': 'Asia/Seoul',
  'Singapore Standard Time': 'Asia/Singapore',
  'India Standard Time': 'Asia/Kolkata',
  'AUS Eastern Standard Time': 'Australia/Sydney',
  'GMT Standard Time': 'Europe/London',
  'W. Europe Standard Time': 'Europe/Berlin',
  'Romance Standard Time': 'Europe/Paris',
  'Central Europe Standard Time': 'Europe/Budapest',
  'Russian Standard Time': 'Europe/Moscow',
  'Eastern Standard Time': 'America/New_York',
  'Central Standard Time': 'America/Chicago',
  'Mountain Standard Time': 'America/Denver',
  'Pacific Standard Time': 'America/Los_Angeles',
  UTC: 'UTC',
  'Coordinated Universal Time': 'UTC',
};

const zoneFormatters = new Map<string, Intl.DateTimeFormat | null>();

function formatterFor(zone: string): Intl.DateTimeFormat | null {
  if (!zoneFormatters.has(zone)) {
    let f: Intl.DateTimeFormat | null = null;
    try {
      f = new Intl.DateTimeFormat('en-US', {
        timeZone: zone,
        hourCycle: 'h23',
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        second: 'numeric',
      });
    } catch {
      f = null;
    }
    zoneFormatters.set(zone, f);
  }
  return zoneFormatters.get(zone)!;
}

/** TZID → 认识的 IANA 名；认不出来返回 'local'（按本机时区算，总比不显示强） */
export function resolveZone(tzid: string | undefined): string {
  if (!tzid) return 'local';
  let z = tzid.trim().replace(/^"|"$/g, '');
  // 有的导出器会写成 /Asia/Shanghai 或 /citadel.org/.../Asia/Shanghai
  if (z.startsWith('/')) z = z.split('/').slice(-2).join('/');
  z = WINDOWS_ZONES[z] ?? z;
  if (z === 'UTC' || z === 'Etc/UTC' || z === 'GMT') return 'utc';
  return formatterFor(z) ? z : 'local';
}

/** 某时区里 utc 这一刻比 UTC 快多少毫秒 */
function zoneOffset(zone: string, utc: number): number {
  const parts = formatterFor(zone)!.formatToParts(new Date(utc));
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - Math.floor(utc / 1000) * 1000;
}

const wallMs = (w: Wall) => Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);

/** 墙上时间在某时区里对应的那一刻（epoch ms） */
function toEpoch(wall: Wall, zone: string): number {
  if (zone === 'utc') return wallMs(wall);
  if (zone === 'local') return new Date(wall.y, wall.mo - 1, wall.d, wall.h, wall.mi, wall.s).getTime();
  // 先按 UTC 当猜测值，再用该时刻的偏移修正两次（跨夏令时也能收敛）
  const naive = wallMs(wall);
  let t = naive - zoneOffset(zone, naive);
  t = naive - zoneOffset(zone, t);
  return t;
}

const stampEpoch = (s: Stamp) => toEpoch(s.wall, s.zone);

// ---------- 词法 ----------

function unfold(text: string): string[] {
  return text.replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '').split('\n');
}

function parseLine(line: string): Prop | null {
  // 名字和参数里冒号只可能出现在引号里
  let i = 0;
  let quoted = false;
  for (; i < line.length; i++) {
    const c = line[i];
    if (c === '"') quoted = !quoted;
    else if (c === ':' && !quoted) break;
  }
  if (i >= line.length) return null;
  const head = line.slice(0, i);
  const value = line.slice(i + 1);
  const segs: string[] = [];
  let cur = '';
  quoted = false;
  for (const c of head) {
    if (c === '"') quoted = !quoted;
    if (c === ';' && !quoted) {
      segs.push(cur);
      cur = '';
    } else cur += c;
  }
  segs.push(cur);
  const params: Record<string, string> = {};
  for (const p of segs.slice(1)) {
    const eq = p.indexOf('=');
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name: segs[0].toUpperCase(), params, value };
}

function unescapeText(v: string): string {
  return v.replace(/\\([nN\\;,])/g, (_, c: string) => (c === 'n' || c === 'N' ? '\n' : c));
}

function parseStamp(value: string, params: Record<string, string>): Stamp | null {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(value.trim());
  if (!m) return null;
  const date = !m[4] || params.VALUE === 'DATE';
  const wall: Wall = {
    y: +m[1],
    mo: +m[2],
    d: +m[3],
    h: date ? 0 : +m[4],
    mi: date ? 0 : +m[5],
    s: date ? 0 : +(m[6] ?? 0),
  };
  const zone = date ? 'local' : m[7] ? 'utc' : resolveZone(params.TZID);
  return { wall, zone, date };
}

/** ISO 8601 时长（P1DT2H、PT30M、-PT15M……）→ 毫秒 */
export function parseDuration(v: string): number | null {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(v.trim());
  if (!m) return null;
  const [, sign, w, d, h, mi, s] = m;
  const ms = ((+(w ?? 0) * 7 + +(d ?? 0)) * 86400 + +(h ?? 0) * 3600 + +(mi ?? 0) * 60 + +(s ?? 0)) * 1000;
  return sign === '-' ? -ms : ms;
}

function parseRaw(text: string): RawEvent[] {
  const out: RawEvent[] = [];
  let ev: RawEvent | null = null;
  // VEVENT 里可能嵌着 VALARM，里面的属性不能当成事件的
  let depth = 0;
  for (const line of unfold(text)) {
    if (!line) continue;
    const p = parseLine(line);
    if (!p) continue;
    if (p.name === 'BEGIN') {
      if (p.value.toUpperCase() === 'VEVENT' && !ev) {
        ev = {
          uid: '',
          title: '',
          location: '',
          start: null,
          end: null,
          duration: null,
          rrule: null,
          exdates: [],
          recurrenceId: null,
          cancelled: false,
        };
        depth = 0;
      } else if (ev) depth++;
      continue;
    }
    if (p.name === 'END') {
      if (ev && depth === 0 && p.value.toUpperCase() === 'VEVENT') {
        out.push(ev);
        ev = null;
      } else if (ev) depth--;
      continue;
    }
    if (!ev || depth > 0) continue;
    switch (p.name) {
      case 'UID':
        ev.uid = p.value.trim();
        break;
      case 'SUMMARY':
        ev.title = unescapeText(p.value).trim();
        break;
      case 'LOCATION':
        ev.location = unescapeText(p.value).trim();
        break;
      case 'DTSTART':
        ev.start = parseStamp(p.value, p.params);
        break;
      case 'DTEND':
        ev.end = parseStamp(p.value, p.params);
        break;
      case 'DURATION':
        ev.duration = parseDuration(p.value);
        break;
      case 'RRULE': {
        const r: Record<string, string> = {};
        for (const kv of p.value.split(';')) {
          const eq = kv.indexOf('=');
          if (eq > 0) r[kv.slice(0, eq).toUpperCase()] = kv.slice(eq + 1).toUpperCase();
        }
        ev.rrule = r;
        break;
      }
      case 'EXDATE':
        for (const v of p.value.split(',')) {
          const s = parseStamp(v, p.params);
          if (s) ev.exdates.push(s);
        }
        break;
      case 'RECURRENCE-ID':
        ev.recurrenceId = parseStamp(p.value, p.params);
        break;
      case 'STATUS':
        ev.cancelled = p.value.trim().toUpperCase() === 'CANCELLED';
        break;
    }
  }
  return out;
}

// ---------- 重复规则 ----------

const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const DAY = 86400000;
/** 一个重复事件最多展开这么多个周期（每天一次的事件 ≈ 55 年） */
const MAX_PERIODS = 20000;

const daysIn = (y: number, mo: number) => new Date(Date.UTC(y, mo, 0)).getUTCDate();
const weekday = (y: number, mo: number, d: number) => new Date(Date.UTC(y, mo - 1, d)).getUTCDay();

function addDays(w: Wall, n: number): Wall {
  const t = new Date(Date.UTC(w.y, w.mo - 1, w.d + n));
  return { ...w, y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

/** BYDAY 的一项：可选序号 + 星期，例如 MO、2TU、-1FR */
function parseByDay(v: string): { n: number; wd: number }[] {
  return v
    .split(',')
    .map((s) => /^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/.exec(s.trim()))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ n: m[1] ? +m[1] : 0, wd: WEEKDAYS.indexOf(m[2]) }));
}

const numList = (v: string | undefined) =>
  v
    ? v
        .split(',')
        .map(Number)
        .filter((n) => Number.isInteger(n) && n !== 0)
    : [];

/** 某月里符合 BYDAY（带序号或不带）和 BYMONTHDAY 的日子 */
function monthDays(y: number, mo: number, byDay: { n: number; wd: number }[], byMonthDay: number[]): number[] {
  const len = daysIn(y, mo);
  const md = new Set(byMonthDay.map((m) => (m > 0 ? m : len + m + 1)).filter((d) => d >= 1 && d <= len));
  const wd = new Set<number>();
  for (const { n, wd: w } of byDay) {
    const all: number[] = [];
    for (let d = 1; d <= len; d++) if (weekday(y, mo, d) === w) all.push(d);
    if (n === 0) all.forEach((d) => wd.add(d));
    else {
      const d = n > 0 ? all[n - 1] : all[all.length + n];
      if (d !== undefined) wd.add(d);
    }
  }
  // 两个都写了取交集（例如"13 号又是星期五"）
  const days = byDay.length && byMonthDay.length ? [...wd].filter((d) => md.has(d)) : [...wd, ...md];
  return days.sort((a, b) => a - b);
}

/**
 * 按 RRULE 生成每次开始的墙上时间（按时间顺序），直到 stop 返回 true。
 * 第一次总是 DTSTART 本身（RFC 规定它算第一次）。
 */
function* expand(start: Stamp, rule: Record<string, string>): Generator<Wall> {
  const freq = rule.FREQ;
  const interval = Math.max(1, +(rule.INTERVAL ?? 1) || 1);
  const byDay = parseByDay(rule.BYDAY ?? '');
  const byMonthDay = numList(rule.BYMONTHDAY);
  const byMonth = numList(rule.BYMONTH);
  const s = start.wall;
  const startMs = wallMs(s);
  const keep = (w: Wall) => wallMs(w) >= startMs;

  yield s;
  const after = function* (list: Wall[]) {
    for (const w of list) if (keep(w) && wallMs(w) !== startMs) yield w;
  };

  for (let period = 0, k = 0; period < MAX_PERIODS; period++, k += interval) {
    if (freq === 'DAILY') {
      if (period === 0) continue;
      const w = addDays(s, k);
      if (byMonth.length && !byMonth.includes(w.mo)) continue;
      if (byDay.length && !byDay.some((b) => b.wd === weekday(w.y, w.mo, w.d))) continue;
      yield w;
    } else if (freq === 'WEEKLY') {
      // 以 DTSTART 所在的那一周（周一开始）为第 0 周
      const back = (weekday(s.y, s.mo, s.d) + 6) % 7;
      const monday = addDays(s, -back + k * 7);
      const days = byDay.length ? byDay.map((b) => (b.wd + 6) % 7) : [back];
      const list = [...new Set(days)].sort((a, b) => a - b).map((i) => addDays(monday, i));
      yield* after(list.filter((w) => !byMonth.length || byMonth.includes(w.mo)));
    } else if (freq === 'MONTHLY') {
      const mIndex = s.mo - 1 + k;
      const y = s.y + Math.floor(mIndex / 12);
      const mo = (mIndex % 12) + 1;
      if (byMonth.length && !byMonth.includes(mo)) continue;
      const days = byDay.length || byMonthDay.length ? monthDays(y, mo, byDay, byMonthDay) : [s.d];
      yield* after(days.filter((d) => d <= daysIn(y, mo)).map((d) => ({ ...s, y, mo, d })));
    } else if (freq === 'YEARLY') {
      const y = s.y + k;
      const months = byMonth.length ? byMonth : [s.mo];
      const list: Wall[] = [];
      for (const mo of [...months].sort((a, b) => a - b)) {
        const days = byDay.length || byMonthDay.length ? monthDays(y, mo, byDay, byMonthDay) : [s.d];
        for (const d of days) if (d <= daysIn(y, mo)) list.push({ ...s, y, mo, d });
      }
      yield* after(list);
    } else {
      return;
    }
  }
}

// ---------- 对外 ----------

/**
 * 解析 .ics 文本，返回与 [from, to) 有重叠的每一次事件（已展开重复、去掉取消和例外），按开始时间排序。
 */
export function parseCalendar(text: string, from: number, to: number): CalEvent[] {
  const raws = parseRaw(text).filter((r) => r.start);
  // 改期/取消了某一次：RECURRENCE-ID 指向原来那次
  const overrides = new Map<string, RawEvent>();
  for (const r of raws) {
    if (r.recurrenceId) overrides.set(`${r.uid}@${stampEpoch(r.recurrenceId)}`, r);
  }

  const out: CalEvent[] = [];
  const emit = (r: RawEvent, start: Stamp, length: number) => {
    if (r.cancelled) return;
    const s = stampEpoch(start);
    const e = s + Math.max(0, length);
    // 零时长的事件也要能被看到
    if (s < to && (e > from || (e === s && s >= from))) {
      out.push({ uid: r.uid, title: r.title, location: r.location, start: s, end: e, allDay: start.date });
    }
  };

  for (const r of raws) {
    if (r.recurrenceId) {
      emit(r, r.start!, lengthOf(r));
      continue;
    }
    const length = lengthOf(r);
    if (!r.rrule) {
      emit(r, r.start!, length);
      continue;
    }
    const start = r.start!;
    const count = r.rrule.COUNT ? +r.rrule.COUNT : Infinity;
    const until = r.rrule.UNTIL ? parseStamp(r.rrule.UNTIL, {}) : null;
    // UNTIL 是全天日期时包含那一整天
    let untilMs = Infinity;
    if (until) untilMs = until.date ? toEpoch(addDays(until.wall, 1), 'local') - 1 : stampEpoch(until);
    const ex = new Set(r.exdates.map(stampEpoch));
    let n = 0;
    for (const wall of expand(start, r.rrule)) {
      if (n >= count) break;
      // 墙上时间当 UTC 看，和真实时刻最多差一天：离窗口很远的那些不用精确换算时区
      const naive = wallMs(wall);
      const far = naive + length + DAY < from;
      const occ: Stamp = { ...start, wall };
      const t = far ? naive : stampEpoch(occ);
      if (t > untilMs || t >= to) break;
      n++;
      if (far || ex.has(t) || overrides.has(`${r.uid}@${t}`)) continue;
      emit(r, occ, length);
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

function lengthOf(r: RawEvent): number {
  if (r.end) return stampEpoch(r.end) - stampEpoch(r.start!);
  if (r.duration !== null) return r.duration;
  // 没写结束：全天事件算一天，其他算零时长
  return r.start!.date ? DAY : 0;
}

// 小助手的数据：待办、日历订阅、报时和休息提醒的设置。
// 存在 %APPDATA%\com.physicsclawdpet.desktop\assistant.json，覆盖层和小助手窗口共用。

export interface ChimeSettings {
  enabled: boolean;
  /** 只在这几个整点报时（含两头，0..23） */
  from: number;
  to: number;
}

export interface RestSettings {
  enabled: boolean;
  /** 连续用电脑多少分钟提醒休息 */
  workMin: number;
  /** 离开（没有键鼠操作）多少分钟算休息过了，重新计时 */
  awayMin: number;
  /** 提醒过还没休息：隔多少分钟再提醒 */
  repeatMin: number;
}

export interface CalendarSource {
  id: string;
  name: string;
  /** url：http(s)/webcal 订阅地址；file：本地 .ics 路径 */
  kind: 'url' | 'file';
  target: string;
  enabled: boolean;
}

export interface CalendarSettings {
  /** 提前几分钟提醒 */
  leadMin: number;
  /** 订阅多久刷新一次（分钟） */
  refreshMin: number;
  /** 全天事件在几点提醒（0..23） */
  allDayHour: number;
  sources: CalendarSource[];
}

export interface Todo {
  id: string;
  text: string;
  done: boolean;
  /** 截止时间，本地时间 'YYYY-MM-DDTHH:mm'（<input type=datetime-local> 的格式），没有为 null */
  due: string | null;
  /** 到点已经提醒过（改了截止时间会清掉） */
  reminded: boolean;
  created: number;
}

export interface AssistantData {
  chime: ChimeSettings;
  rest: RestSettings;
  calendar: CalendarSettings;
  todos: Todo[];
}

export const DEFAULT_ASSISTANT: AssistantData = {
  chime: { enabled: true, from: 9, to: 22 },
  rest: { enabled: true, workMin: 45, awayMin: 5, repeatMin: 10 },
  calendar: { leadMin: 10, refreshMin: 30, allDayHour: 9, sources: [] },
  todos: [],
};

const num = (v: unknown, def: number, lo: number, hi: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : def;
const bool = (v: unknown, def: boolean) => (typeof v === 'boolean' ? v : def);
const str = (v: unknown, def = '') => (typeof v === 'string' ? v : def);
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

const DUE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

export function newId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/** 读进来的 JSON 可能是旧版本或者被手改过：缺的补默认值，不对的丢掉 */
export function sanitizeAssistant(raw: unknown): AssistantData {
  const r = obj(raw);
  const d = DEFAULT_ASSISTANT;
  const c = obj(r.chime);
  const rest = obj(r.rest);
  const cal = obj(r.calendar);
  const sources = Array.isArray(cal.sources) ? cal.sources : [];
  const todos = Array.isArray(r.todos) ? r.todos : [];
  return {
    chime: {
      enabled: bool(c.enabled, d.chime.enabled),
      from: num(c.from, d.chime.from, 0, 23),
      to: num(c.to, d.chime.to, 0, 23),
    },
    rest: {
      enabled: bool(rest.enabled, d.rest.enabled),
      workMin: num(rest.workMin, d.rest.workMin, 5, 240),
      awayMin: num(rest.awayMin, d.rest.awayMin, 1, 60),
      repeatMin: num(rest.repeatMin, d.rest.repeatMin, 1, 120),
    },
    calendar: {
      leadMin: num(cal.leadMin, d.calendar.leadMin, 0, 120),
      refreshMin: num(cal.refreshMin, d.calendar.refreshMin, 5, 1440),
      allDayHour: num(cal.allDayHour, d.calendar.allDayHour, 0, 23),
      sources: sources
        .map(obj)
        .filter((s) => typeof s.target === 'string' && s.target)
        .map((s) => ({
          id: str(s.id) || newId(),
          name: str(s.name),
          kind: s.kind === 'file' ? 'file' : 'url',
          target: str(s.target).trim(),
          enabled: bool(s.enabled, true),
        })),
    },
    todos: todos
      .map(obj)
      .filter((t) => typeof t.text === 'string')
      .map((t) => ({
        id: str(t.id) || newId(),
        text: str(t.text),
        done: bool(t.done, false),
        due: typeof t.due === 'string' && DUE_RE.test(t.due) ? t.due : null,
        reminded: bool(t.reminded, false),
        created: typeof t.created === 'number' ? t.created : Date.now(),
      })),
  };
}

/** 'YYYY-MM-DDTHH:mm'（本地时间）→ epoch ms */
export function dueTime(due: string): number {
  const [d, t] = due.split('T');
  const [y, mo, day] = d.split('-').map(Number);
  const [h, mi] = t.split(':').map(Number);
  return new Date(y, mo - 1, day, h, mi).getTime();
}

/** epoch ms → 'YYYY-MM-DDTHH:mm'（本地时间） */
export function toDue(ms: number): string {
  const t = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}T${p(t.getHours())}:${p(t.getMinutes())}`;
}

/** webcal:// 就是 https:// */
export function normalizeUrl(url: string): string {
  return url.trim().replace(/^webcals?:\/\//i, 'https://');
}

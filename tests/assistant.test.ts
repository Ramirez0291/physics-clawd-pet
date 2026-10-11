import { describe, expect, it } from 'vitest';
import { parseCalendar, parseDuration, resolveZone } from '../src/assistant/ical';
import { DEFAULT_ASSISTANT, type AssistantData, dueTime, sanitizeAssistant, toDue } from '../src/assistant/model';
import { Scheduler, inHours } from '../src/assistant/scheduler';

const ics = (...events: string[]) =>
  ['BEGIN:VCALENDAR', 'VERSION:2.0', ...events.flatMap((e) => ['BEGIN:VEVENT', e, 'END:VEVENT']), 'END:VCALENDAR'].join(
    '\r\n',
  );

const utc = (s: string) => Date.parse(s);
const ALL = [0, 8.64e15] as const;

describe('iCal 解析', () => {
  it('UTC 时间、折行和转义', () => {
    const text = ics(
      [
        'UID:a',
        'SUMMARY:周会\\, 记得带',
        '  电脑',
        'LOCATION:3F\\;会议室',
        'DTSTART:20261012T020000Z',
        'DTEND:20261012T030000Z',
      ].join('\r\n'),
    );
    const [e] = parseCalendar(text, ...ALL);
    expect(e.title).toBe('周会, 记得带 电脑');
    expect(e.location).toBe('3F;会议室');
    expect(e.start).toBe(utc('2026-10-12T02:00:00Z'));
    expect(e.end - e.start).toBe(3600000);
    expect(e.allDay).toBe(false);
  });

  it('TZID：IANA 和 Windows 时区名都认识', () => {
    const text = ics(
      'UID:a\r\nSUMMARY:x\r\nDTSTART;TZID=Asia/Shanghai:20261012T100000\r\nDURATION:PT30M',
      'UID:b\r\nSUMMARY:y\r\nDTSTART;TZID="China Standard Time":20261012T100000\r\nDURATION:PT30M',
      // 纽约 11 月 1 日结束夏令时：之前 UTC-4，之后 UTC-5
      'UID:c\r\nSUMMARY:z\r\nDTSTART;TZID=America/New_York:20261102T090000\r\nDURATION:PT1H',
    );
    const [a, b, c] = parseCalendar(text, ...ALL);
    expect(a.start).toBe(utc('2026-10-12T02:00:00Z'));
    expect(b.start).toBe(a.start);
    expect(a.end - a.start).toBe(30 * 60000);
    expect(c.start).toBe(utc('2026-11-02T14:00:00Z'));
    expect(resolveZone('/Asia/Tokyo')).toBe('Asia/Tokyo');
    expect(resolveZone('Not/AZone')).toBe('local');
  });

  it('TZID：日文版 Outlook 把显示名当 TZID 导出', () => {
    expect(resolveZone('(UTC+09:00) 大阪、札幌、東京')).toBe('Asia/Tokyo');
    expect(resolveZone('(GMT+09:00) Osaka, Sapporo, Tokyo')).toBe('Asia/Tokyo');
    expect(resolveZone('(UTC-08:00) 太平洋標準時 (米国およびカナダ)')).toBe('America/Los_Angeles');
    expect(resolveZone('(UTC+08:00) 北京、重慶、香港特別行政区、ウルムチ')).toBe('Asia/Shanghai');
    // 城市认不出：用括号里的固定偏移
    expect(resolveZone('(UTC+03:00) 未知の都市')).toBe('Etc/GMT-3');
    expect(resolveZone('(UTC-03:00) Salvador')).toBe('Etc/GMT+3');
    expect(resolveZone('(UTC) 協定世界時')).toBe('utc');
    expect(resolveZone('(UTC+05:30) 未知')).toBe('+05:30');
    // 括号里是胡话：当本机
    expect(resolveZone('(UTC+99:00) x')).toBe('local');
    const text = ics(
      'UID:a\r\nSUMMARY:会議\r\nDTSTART;TZID="(UTC+09:00) 大阪、札幌、東京":20261012T100000\r\nDURATION:PT30M',
      'UID:b\r\nSUMMARY:定例\r\nDTSTART;TZID="(UTC-08:00) 太平洋標準時 (米国およびカナダ)":20260715T090000\r\nDURATION:PT30M',
    );
    const [b, a] = parseCalendar(text, ...ALL); // 按开始时间排序：7 月的在前
    expect(a.start).toBe(utc('2026-10-12T01:00:00Z'));
    expect(b.start).toBe(utc('2026-07-15T16:00:00Z')); // 夏令时 UTC-7：城市名认出来了，所以夏天也对
  });

  it('全天事件和浮动时间按本机时区', () => {
    const text = ics('UID:a\r\nSUMMARY:国庆\r\nDTSTART;VALUE=DATE:20261001\r\nDTEND;VALUE=DATE:20261004');
    const [e] = parseCalendar(text, ...ALL);
    expect(e.allDay).toBe(true);
    expect(e.start).toBe(new Date(2026, 9, 1).getTime());
    expect(e.end).toBe(new Date(2026, 9, 4).getTime());
  });

  it('每周重复：BYDAY、COUNT、EXDATE', () => {
    const text = ics(
      [
        'UID:w',
        'SUMMARY:站会',
        'DTSTART:20261005T010000Z', // 周一
        'DURATION:PT15M',
        'RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=6',
        'EXDATE:20261009T010000Z',
      ].join('\r\n'),
    );
    const days = parseCalendar(text, ...ALL).map((e) => new Date(e.start).toISOString().slice(0, 10));
    // 6 次里去掉 10/9（被 EXDATE 去掉的那次也占 COUNT）
    expect(days).toEqual(['2026-10-05', '2026-10-07', '2026-10-12', '2026-10-14', '2026-10-16']);
  });

  it('只返回和窗口重叠的，UNTIL 截止', () => {
    const text = ics('UID:d\r\nSUMMARY:x\r\nDTSTART:20200101T000000Z\r\nDTEND:20200101T010000Z\r\nRRULE:FREQ=DAILY;UNTIL=20261012T000000Z');
    const list = parseCalendar(text, utc('2026-10-09T12:00:00Z'), utc('2026-10-20T00:00:00Z'));
    expect(list.map((e) => new Date(e.start).toISOString().slice(0, 10))).toEqual([
      '2026-10-10',
      '2026-10-11',
      '2026-10-12',
    ]);
  });

  it('每月：第几个星期几、倒数几号；跳过不存在的日子', () => {
    const second = ics('UID:m\r\nSUMMARY:x\r\nDTSTART:20261013T000000Z\r\nRRULE:FREQ=MONTHLY;BYDAY=2TU;COUNT=3');
    expect(parseCalendar(second, ...ALL).map((e) => new Date(e.start).toISOString().slice(0, 10))).toEqual([
      '2026-10-13',
      '2026-11-10',
      '2026-12-08',
    ]);
    const last = ics('UID:n\r\nSUMMARY:x\r\nDTSTART:20260131T000000Z\r\nRRULE:FREQ=MONTHLY;BYMONTHDAY=-1;COUNT=3');
    expect(parseCalendar(last, ...ALL).map((e) => new Date(e.start).toISOString().slice(0, 10))).toEqual([
      '2026-01-31',
      '2026-02-28',
      '2026-03-31',
    ]);
    const d31 = ics('UID:o\r\nSUMMARY:x\r\nDTSTART:20260131T000000Z\r\nRRULE:FREQ=MONTHLY;COUNT=3');
    expect(parseCalendar(d31, ...ALL).map((e) => new Date(e.start).toISOString().slice(0, 10))).toEqual([
      '2026-01-31',
      '2026-03-31',
      '2026-05-31',
    ]);
  });

  it('改期的那一次替换原来的，取消的不显示', () => {
    const text = ics(
      'UID:r\r\nSUMMARY:周会\r\nDTSTART:20261005T010000Z\r\nDURATION:PT1H\r\nRRULE:FREQ=WEEKLY;COUNT=3',
      'UID:r\r\nRECURRENCE-ID:20261012T010000Z\r\nSUMMARY:周会（改到下午）\r\nDTSTART:20261012T060000Z\r\nDURATION:PT1H',
      'UID:r\r\nRECURRENCE-ID:20261019T010000Z\r\nSTATUS:CANCELLED\r\nDTSTART:20261019T010000Z',
    );
    const list = parseCalendar(text, ...ALL);
    expect(list.map((e) => [new Date(e.start).toISOString(), e.title])).toEqual([
      ['2026-10-05T01:00:00.000Z', '周会'],
      ['2026-10-12T06:00:00.000Z', '周会（改到下午）'],
    ]);
  });

  it('VALARM 里的属性不算事件的', () => {
    const text = ics('UID:v\r\nSUMMARY:外面\r\nDTSTART:20261012T010000Z\r\nBEGIN:VALARM\r\nSUMMARY:里面\r\nEND:VALARM');
    expect(parseCalendar(text, ...ALL)[0].title).toBe('外面');
  });

  it('时长', () => {
    expect(parseDuration('P1DT2H30M')).toBe((26 * 60 + 30) * 60000);
    expect(parseDuration('-PT15M')).toBe(-15 * 60000);
    expect(parseDuration('P1W')).toBe(7 * 86400000);
    expect(parseDuration('nope')).toBeNull();
  });
});

describe('数据', () => {
  it('缺的补默认值，坏的丢掉', () => {
    const d = sanitizeAssistant({
      chime: { from: 30 },
      todos: [{ text: '买菜', due: '2026-10-10T18:00' }, { text: 1 }, { text: '坏时间', due: 'tomorrow' }],
      calendar: { sources: [{ target: 'webcal://x' }, { name: '没地址' }] },
    });
    expect(d.chime).toEqual({ enabled: true, from: 23, to: 22 });
    expect(d.todos.map((t) => [t.text, t.due])).toEqual([
      ['买菜', '2026-10-10T18:00'],
      ['坏时间', null],
    ]);
    expect(d.calendar.sources).toHaveLength(1);
    expect(d.calendar.sources[0].kind).toBe('url');
  });

  it('截止时间来回转换', () => {
    expect(toDue(dueTime('2026-10-10T08:05'))).toBe('2026-10-10T08:05');
  });
});

describe('提醒调度', () => {
  const MIN = 60000;
  const at = (h: number, m = 0, s = 0) => new Date(2026, 9, 12, h, m, s).getTime();
  const data = (over: Partial<AssistantData> = {}): AssistantData => ({ ...structuredClone(DEFAULT_ASSISTANT), ...over });

  it('整点报时：只在设定的时段里，启动那个钟头不补报', () => {
    const d = data();
    const s = new Scheduler(at(9, 0, 10));
    expect(s.tick(at(9, 0, 20), 0, d, [])).toEqual([]);
    expect(s.tick(at(9, 59), 0, d, [])).toEqual([]);
    expect(s.tick(at(10, 0, 5), 0, d, []).map((r) => r.kind)).toEqual(['chime']);
    expect(s.tick(at(10, 0, 10), 0, d, [])).toEqual([]);
    // 睡眠醒来已经 10 分了：不补报
    expect(s.tick(at(11, 10), 0, d, []).filter((r) => r.kind === 'chime')).toEqual([]);
    const late = new Scheduler(at(22, 59));
    expect(late.tick(at(23, 0), 0, d, [])).toEqual([]);
    expect(inHours(1, 22, 6)).toBe(true);
    expect(inHours(12, 22, 6)).toBe(false);
  });

  it('休息：连续用够时长提醒，离开够久重新计时', () => {
    const d = data({ chime: { enabled: false, from: 0, to: 23 } });
    const s = new Scheduler(at(9));
    // 实际每几秒 tick 一次；这里按分钟走，记下哪几分钟提醒了
    const restsBetween = (from: number, to: number, idle = (_t: number) => 0) => {
      const hits: number[] = [];
      for (let t = from; t <= to; t += MIN) {
        if (s.tick(t, idle(t), d, []).some((r) => r.kind === 'rest')) hits.push((t - at(9)) / MIN);
      }
      return hits;
    };
    // 45 分钟提醒；没理它，每隔 repeatMin 再提醒
    expect(restsBetween(at(9), at(9, 58))).toEqual([45, 55]);
    // 离开 6 分钟（9:59~10:05 没操作）回来，重新算
    const away = (t: number) => (t > at(9, 58) && t <= at(10, 5) ? t - at(9, 58) : 0);
    expect(restsBetween(at(9, 59), at(10, 5), away)).toEqual([]);
    expect(s.activeMs(at(10, 4))).toBe(0);
    expect(restsBetween(at(10, 6), at(10, 52))).toEqual([111]);
  });

  it('休息：电脑睡了一觉也算休息过', () => {
    const d = data();
    const s = new Scheduler(at(9, 1));
    s.tick(at(9, 1), 0, d, []);
    s.tick(at(9, 40), 0, d, []);
    // 睡眠期间没有 tick；醒来 GetLastInputInfo 的空闲时间可能很小
    expect(s.tick(at(11, 30), 1000, d, []).map((r) => r.kind)).toEqual([]);
    expect(s.activeMs(at(11, 30))).toBeLessThan(2000);
  });

  it('日程：提前 N 分钟提醒一次；开始后几分钟内补提醒；全天事件按设定的钟点', () => {
    const d = data({ chime: { enabled: false, from: 0, to: 23 }, rest: { ...DEFAULT_ASSISTANT.rest, enabled: false } });
    const meet = { uid: 'm', title: '评审', location: '', start: at(14), end: at(15), allDay: false };
    const holiday = { uid: 'h', title: '放假', location: '', start: at(0), end: at(0) + 86400000, allDay: true };
    const s = new Scheduler(at(8));
    expect(s.tick(at(8, 30), 0, d, [meet, holiday])).toEqual([]);
    expect(s.tick(at(9), 0, d, [meet, holiday]).map((r) => r.key)).toEqual(['event:h@' + at(0)]);
    expect(s.tick(at(13, 49), 0, d, [meet])).toEqual([]);
    const [r] = s.tick(at(13, 50), 0, d, [meet]);
    expect(r.kind).toBe('event');
    expect(s.tick(at(13, 51), 0, d, [meet])).toEqual([]);
    // 稍后提醒
    s.snooze(r, at(13, 51), 5 * MIN);
    expect(s.tick(at(13, 55), 0, d, [meet])).toEqual([]);
    expect(s.tick(at(13, 56), 0, d, [meet])).toHaveLength(1);
    // 开机晚了，开始 3 分钟内还补一次；再晚就算了
    const late = new Scheduler(at(14, 3));
    expect(late.tick(at(14, 3), 0, d, [meet])).toHaveLength(1);
    const later = new Scheduler(at(14, 6));
    expect(later.tick(at(14, 6), 0, d, [meet])).toEqual([]);
  });

  it('待办：到点提醒；勾掉了就不再提醒', () => {
    const d = data({ chime: { enabled: false, from: 0, to: 23 } });
    d.todos = [
      { id: 'a', text: '交周报', done: false, due: '2026-10-12T17:00', reminded: false, created: 0 },
      { id: 'b', text: '早就过期', done: false, due: '2026-10-01T09:00', reminded: false, created: 0 },
      { id: 'c', text: '提醒过了', done: false, due: '2026-10-01T09:00', reminded: true, created: 0 },
      { id: 'd', text: '没截止时间', done: false, due: null, reminded: false, created: 0 },
    ];
    const s = new Scheduler(at(16));
    expect(s.tick(at(16), 0, d, []).map((r) => r.key)).toEqual(['todo:b@2026-10-01T09:00']);
    expect(s.tick(at(16, 59), 0, d, [])).toEqual([]);
    const [r] = s.tick(at(17), 0, d, []);
    expect(r.kind === 'todo' && r.text).toBe('交周报');
    s.snooze(r, at(17), 10 * MIN);
    d.todos[0].done = true;
    expect(s.tick(at(17, 11), 0, d, [])).toEqual([]);
  });
});

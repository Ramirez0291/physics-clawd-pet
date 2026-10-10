// 小助手的文字：系统是中文就用中文，否则英文（和托盘菜单一致）。

export const isZh = typeof navigator !== 'undefined' && /^zh\b/i.test(navigator.language);

const pad = (n: number) => String(n).padStart(2, '0');
export const hhmm = (t: number) => {
  const d = new Date(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** 10/12 周一（中文）/ Mon 10/12（英文） */
export function dayLabel(t: number, now = Date.now()): string {
  const d = new Date(t);
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() - today.getTime()) / 86400000);
  if (isZh) {
    if (diff === 0) return '今天';
    if (diff === 1) return '明天';
    if (diff === -1) return '昨天';
    return `${d.getMonth() + 1}/${d.getDate()} 周${'日一二三四五六'[d.getDay()]}`;
  }
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  return `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()]} ${d.getMonth() + 1}/${d.getDate()}`;
}

function zhHour(h: number): string {
  const period = h < 6 ? '凌晨' : h < 9 ? '早上' : h < 12 ? '上午' : h < 13 ? '中午' : h < 18 ? '下午' : '晚上';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${period} ${h12} 点`;
}

function enHour(h: number): string {
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12} ${h < 12 ? 'AM' : 'PM'}`;
}

const ZH = {
  chimeTitle: (h: number) => `${zhHour(h)}啦！`,
  chimeBody: (h: number): string =>
    h >= 23 || h < 6 ? '很晚了，早点睡哦' : h === 12 ? '该吃午饭了' : h === 18 ? '下班时间到～' : '喝口水，活动一下吧',
  restTitle: '休息一下吧',
  restBody: (m: number) => `已经连续用了 ${m} 分钟电脑，站起来走走、看看远处～`,
  restOk: '好的',
  restLater: '等会儿',
  eventSoon: (m: number) => `${m} 分钟后：`,
  eventNow: '现在：',
  eventToday: '今天：',
  allDay: '全天',
  gotIt: '知道了',
  remindAtStart: '开始时再提醒',
  remindLater: '10 分钟后再提醒',
  sampleEvent: '示例日程（试一下）',
  sampleTodo: '示例待办（试一下）',
  todoTitle: '该做这件事了',
  todoDue: (t: string) => `截止 ${t}`,
  todoOverdue: (t: string) => `已经过了截止时间（${t}）`,
  todoDone: '完成啦',
  close: '关闭',
  untitled: '（无标题）',
};

const EN: typeof ZH = {
  chimeTitle: (h: number) => `It's ${enHour(h)}!`,
  chimeBody: (h: number) =>
    h >= 23 || h < 6 ? "It's late. Time for bed?" : h === 12 ? 'Lunch time!' : h === 18 ? 'Quitting time~' : 'Grab some water and stretch.',
  restTitle: 'Time for a break',
  restBody: (m: number) => `You've been at the computer for ${m} minutes. Stand up and look at something far away.`,
  restOk: 'OK',
  restLater: 'Later',
  eventSoon: (m: number) => `In ${m} min: `,
  eventNow: 'Now: ',
  eventToday: 'Today: ',
  allDay: 'All day',
  gotIt: 'Got it',
  remindAtStart: 'Remind me when it starts',
  remindLater: 'Remind me in 10 min',
  sampleEvent: 'Sample event (just testing)',
  sampleTodo: 'Sample to-do (just testing)',
  todoTitle: 'To-do due',
  todoDue: (t: string) => `Due ${t}`,
  todoOverdue: (t: string) => `Overdue (was due ${t})`,
  todoDone: 'Done',
  close: 'Close',
  untitled: '(untitled)',
};

export const T = isZh ? ZH : EN;

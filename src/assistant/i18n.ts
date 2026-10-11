// 宠物自己说的话（气泡）和日期时间格式：跟着系统语言走，中文 / 日文 / 英文三种，其他语言用英文（和托盘菜单一致）。
// 日文版的 Clawd 是大阪的螃蟹，说关西腔；设置项和错误提示用礼貌体，权限按钮用最清楚的说法。

export type Lang = 'zh' | 'ja' | 'en';

function detect(): Lang {
  if (typeof navigator === 'undefined') return 'en';
  const l = navigator.language;
  return /^zh\b/i.test(l) ? 'zh' : /^ja\b/i.test(l) ? 'ja' : 'en';
}

export const LANG: Lang = detect();
export const isZh = LANG === 'zh';
export const isJa = LANG === 'ja';

/** 按当前语言挑一项 */
export const pick = <T>(by: Record<Lang, T>): T => by[LANG];

// 页面的 lang 决定汉字用哪种字形/字体（日文和中文的同一个字长得不一样，如 直、骨、令）。
// 气泡和日程里显示的是用户自己的内容（日文日程标题、Claude 的日文回复），所以跟着系统语言走。
if (typeof document !== 'undefined') {
  document.documentElement.lang = { zh: 'zh-CN', ja: 'ja', en: 'en' }[LANG];
}

const pad = (n: number) => String(n).padStart(2, '0');
export const hhmm = (t: number) => {
  const d = new Date(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** 10/12 周一（中文）/ 10/12(月)（日文）/ Mon 10/12（英文） */
export function dayLabel(t: number, now = Date.now(), lang: Lang = LANG): string {
  const d = new Date(t);
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() - today.getTime()) / 86400000);
  if (lang === 'zh') {
    if (diff === 0) return '今天';
    if (diff === 1) return '明天';
    if (diff === -1) return '昨天';
    return `${d.getMonth() + 1}/${d.getDate()} 周${'日一二三四五六'[d.getDay()]}`;
  }
  if (lang === 'ja') {
    if (diff === 0) return '今日';
    if (diff === 1) return '明日';
    if (diff === -1) return '昨日';
    return `${d.getMonth() + 1}/${d.getDate()}(${'日月火水木金土'[d.getDay()]})`;
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
  ccPermTitle: (tool: string) =>
    tool === 'Bash' || tool === 'PowerShell'
      ? 'Claude 想运行命令'
      : /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(tool)
        ? 'Claude 想修改文件'
        : tool === 'WebFetch'
          ? 'Claude 想访问网页'
          : `Claude 想使用 ${tool}`,
  ccAllow: '允许',
  ccDeny: '拒绝',
  ccPermHint: '关掉气泡 = 回终端里自己选',
  ccWaiting: 'Claude 在等你确认',
  ccDone: (folder: string) => `Claude 干完了：${folder}`,
  calNotIcal: '不是 iCalendar 格式（没有 BEGIN:VCALENDAR）',
  calParseFailed: (e: string) => `解析失败：${e}`,
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
  ccPermTitle: (tool: string) =>
    tool === 'Bash' || tool === 'PowerShell'
      ? 'Claude wants to run a command'
      : /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(tool)
        ? 'Claude wants to edit a file'
        : tool === 'WebFetch'
          ? 'Claude wants to fetch a page'
          : `Claude wants to use ${tool}`,
  ccAllow: 'Allow',
  ccDeny: 'Deny',
  ccPermHint: 'Close the bubble to answer in the terminal instead',
  ccWaiting: 'Claude is waiting for you',
  ccDone: (folder: string) => `Claude finished: ${folder}`,
  calNotIcal: 'Not an iCalendar file (no BEGIN:VCALENDAR)',
  calParseFailed: (e: string) => `Parse failed: ${e}`,
};

// 大阪の蟹：Clawd の台詞は関西弁。許可／拒否のボタンだけは誤解のない標準語にしてある。
const JA: typeof ZH = {
  chimeTitle: (h: number) => `${h}時やで！`,
  chimeBody: (h: number): string =>
    h >= 23 || h < 6
      ? 'もう遅いで〜。はよ寝なあかんで'
      : h === 12
        ? 'お昼ごはんの時間やで！'
        : h === 18
          ? '定時やで〜。お疲れさん！'
          : '水飲んで、ちょっと体動かそか',
  restTitle: 'ちょっと休憩しいや',
  restBody: (m: number) => `もう${m}分もパソコン触りっぱなしやで。立ち上がって、遠くを見てみ〜`,
  restOk: 'せやな',
  restLater: 'あとでな',
  eventSoon: (m: number) => `${m}分後やで：`,
  eventNow: '今や：',
  eventToday: '今日：',
  allDay: '終日',
  gotIt: 'わかった',
  remindAtStart: '始まる時にもっかい教えて',
  remindLater: '10分後にもっかい教えて',
  sampleEvent: 'サンプルの予定（お試しやで）',
  sampleTodo: 'サンプルのToDo（お試しやで）',
  todoTitle: 'これやる時間やで',
  todoDue: (t: string) => `期限 ${t}`,
  todoOverdue: (t: string) => `期限、過ぎてるで！（${t}）`,
  todoDone: 'できたで！',
  close: '閉じる',
  untitled: '（無題）',
  ccPermTitle: (tool: string) =>
    tool === 'Bash' || tool === 'PowerShell'
      ? 'Claude、コマンド実行したい言うてるで'
      : /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(tool)
        ? 'Claude、ファイル編集したい言うてるで'
        : tool === 'WebFetch'
          ? 'Claude、ウェブページ見に行きたい言うてるで'
          : `Claude、${tool} を使いたい言うてるで`,
  ccAllow: '許可',
  ccDeny: '拒否',
  ccPermHint: '吹き出しを閉じたら、Claude Code側で選べるで',
  ccWaiting: 'Claude、確認待ちやで',
  ccDone: (folder: string) => `Claude、終わったで：${folder}`,
  calNotIcal: 'iCalendar形式ではありません（BEGIN:VCALENDAR がありません）',
  calParseFailed: (e: string) => `解析に失敗しました：${e}`,
};

export const TEXTS: Record<Lang, typeof ZH> = { zh: ZH, ja: JA, en: EN };
export const T = TEXTS[LANG];

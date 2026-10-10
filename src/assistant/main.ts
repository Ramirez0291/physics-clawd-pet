// 小助手窗口：管理待办、日历订阅、报时和休息提醒的设置。
// 提醒本身由覆盖层（宠物那边）负责；这里只改数据，再显示覆盖层发来的日程和状态。

import type { AssistantStatus } from '../overlay/companion';
import { createBus, loadAssistant, pickIcsFile, saveAssistant } from '../platform/host';
import { dayLabel, hhmm, isZh } from './i18n';
import { type AssistantData, type CalendarSource, type Todo, dueTime, newId, sanitizeAssistant } from './model';

const ZH = {
  tabTodo: '待办',
  tabCalendar: '日历',
  tabRemind: '报时与休息',
  todoPlaceholder: '要做什么？回车添加',
  dueTitle: '截止时间（可不填），到点 Clawd 会提醒你',
  add: '添加',
  todoEmpty: '还没有待办。加一条试试，设了截止时间的到点会提醒。',
  done: (n: number) => `已完成 ${n} 项`,
  clearDone: '清除已完成',
  delete: '删除',
  noDue: '设截止时间',
  sources: '日历订阅',
  sourceEmpty: '还没有日历。贴一个 iCal 订阅地址，或者选一个本地 .ics 文件。',
  urlPlaceholder: 'https://…/basic.ics 或 webcal://…',
  subscribe: '订阅',
  pickFile: '选择本地 .ics 文件…',
  refresh: '立即刷新',
  urlHint:
    'Google 日历：设置 → 日历设置 → "iCal 格式的私密地址"；Outlook：设置 → 日历 → 共享日历 → 发布日历 → ICS 链接；飞书、钉钉一般在日历设置的"订阅/导出"里。订阅地址相当于密码，别分享给别人。',
  calSettings: '日历提醒',
  leadMin: '提前提醒',
  refreshMin: '订阅刷新间隔',
  allDayHour: '全天日程在几点提醒',
  minutes: '分钟',
  hour: (h: number) => `${h} 点`,
  upcoming: '接下来 7 天',
  noUpcoming: '接下来 7 天没有日程。',
  waiting: '正在等 Clawd 回应…（宠物没在运行的话，日程和状态显示不出来）',
  statusOk: (n: number, t: string) => `✓ ${n} 个日程 · ${t} 更新`,
  statusLoading: '读取中…',
  statusErr: (e: string) => `✗ ${e}`,
  enabled: '启用',
  file: '本地文件',
  chime: '整点报时',
  chimeFrom: '从',
  chimeTo: '到（含）',
  chimeHint: '只在这段时间里的整点报时。Clawd 会举着铃铛摇，几点就摇几下。',
  rest: '休息提醒',
  workMin: '连续用电脑',
  awayMin: '离开多久算休息过',
  repeatMin: '没休息的话隔多久再提醒',
  active: (m: number) => `现在已经连续用了 ${m} 分钟。`,
  tryIt: '试一下',
  testChime: '报时',
  testRest: '休息',
  testEvent: '日程',
  testTodo: '待办',
  saved: '已保存',
  saveFailed: (e: string) => `保存失败：${e}`,
  pickUnavailable: '浏览器预览里不能选本地文件',
  badUrl: '要以 http://、https:// 或 webcal:// 开头',
  allDay: '全天',
};

const EN: typeof ZH = {
  tabTodo: 'To-dos',
  tabCalendar: 'Calendar',
  tabRemind: 'Chime & breaks',
  todoPlaceholder: 'What needs doing? Press Enter to add',
  dueTitle: 'Due time (optional). Clawd reminds you when it is due',
  add: 'Add',
  todoEmpty: 'No to-dos yet. Give one a due time and Clawd will remind you.',
  done: (n: number) => `${n} completed`,
  clearDone: 'Clear completed',
  delete: 'Delete',
  noDue: 'Set due time',
  sources: 'Calendar subscriptions',
  sourceEmpty: 'No calendars yet. Paste an iCal subscription link or choose a local .ics file.',
  urlPlaceholder: 'https://…/basic.ics or webcal://…',
  subscribe: 'Subscribe',
  pickFile: 'Choose a local .ics file…',
  refresh: 'Refresh now',
  urlHint:
    'Google Calendar: Settings → your calendar → "Secret address in iCal format". Outlook: Settings → Calendar → Shared calendars → Publish a calendar → ICS link. Treat the link like a password.',
  calSettings: 'Calendar reminders',
  leadMin: 'Remind me',
  refreshMin: 'Refresh every',
  allDayHour: 'All-day events at',
  minutes: 'min',
  hour: (h: number) => `${h}:00`,
  upcoming: 'Next 7 days',
  noUpcoming: 'Nothing in the next 7 days.',
  waiting: 'Waiting for Clawd… (events and status show up while the pet is running)',
  statusOk: (n: number, t: string) => `✓ ${n} events · updated ${t}`,
  statusLoading: 'Loading…',
  statusErr: (e: string) => `✗ ${e}`,
  enabled: 'Enabled',
  file: 'Local file',
  chime: 'Hourly chime',
  chimeFrom: 'From',
  chimeTo: 'To (inclusive)',
  chimeHint: 'Chimes only on the hour within this range. Clawd rings a bell once per hour on the clock.',
  rest: 'Break reminders',
  workMin: 'After using the computer for',
  awayMin: 'Counts as a break after',
  repeatMin: 'If no break, remind again after',
  active: (m: number) => `You've been at it for ${m} minutes.`,
  tryIt: 'Try it',
  testChime: 'Chime',
  testRest: 'Break',
  testEvent: 'Event',
  testTodo: 'To-do',
  saved: 'Saved',
  saveFailed: (e: string) => `Save failed: ${e}`,
  pickUnavailable: 'Local files are not available in the browser preview',
  badUrl: 'Must start with http://, https:// or webcal://',
  allDay: 'All day',
};

const W = isZh ? ZH : EN;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
/** 建一个元素：属性直接赋值（className、value、checked……），后面是子节点 */
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, unknown> = {},
  ...kids: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  Object.assign(e, props);
  e.append(...kids);
  return e;
}

async function main() {
  document.documentElement.lang = isZh ? 'zh-CN' : 'en';
  document.title = isZh ? 'Clawd 小助手' : 'Clawd Assistant';
  for (const n of document.querySelectorAll<HTMLElement>('[data-t]')) n.textContent = String(W[n.dataset.t as keyof typeof W]);
  for (const n of document.querySelectorAll<HTMLInputElement>('[data-t-placeholder]'))
    n.placeholder = String(W[n.dataset.tPlaceholder as keyof typeof W]);
  for (const n of document.querySelectorAll<HTMLElement>('[data-t-title]')) n.title = String(W[n.dataset.tTitle as keyof typeof W]);

  const bus = await createBus();
  let data: AssistantData = sanitizeAssistant(await loadAssistant());
  let status: AssistantStatus | null = null;

  // ---------- 存盘 ----------

  let noteTimer = 0;
  const note = (msg: string) => {
    $('note').textContent = msg;
    clearTimeout(noteTimer);
    noteTimer = window.setTimeout(() => ($('note').textContent = ''), 2500);
  };
  const save = async () => {
    try {
      await saveAssistant(data);
    } catch (e) {
      note(W.saveFailed(String(e)));
    }
  };
  /** 改数据、存盘、重画 */
  const change = (fn: (d: AssistantData) => void) => {
    fn(data);
    data = sanitizeAssistant(data);
    render();
    void save();
  };

  // 别处（覆盖层）改了数据：比如提醒过的待办、气泡上点了"完成啦"
  bus.on('assistant-data', (d: unknown) => {
    const next = sanitizeAssistant(d);
    if (JSON.stringify(next) === JSON.stringify(data)) return;
    data = next;
    render();
  });
  bus.on('assistant-status', (s: AssistantStatus) => {
    status = s;
    renderSources();
    renderUpcoming();
    renderActive();
  });
  bus.emit('assistant-hello');
  window.setInterval(() => bus.emit('assistant-hello'), 30000);

  // ---------- 标签页 ----------

  const tabs = [...document.querySelectorAll<HTMLButtonElement>('[data-tab]')];
  const showTab = (name: string) => {
    for (const t of tabs) {
      const on = t.dataset.tab === name;
      t.setAttribute('aria-selected', String(on));
      $(`tab-${t.dataset.tab}`).hidden = !on;
    }
    try {
      localStorage.setItem('clawd-assistant:tab', name);
    } catch {
      /* 存不了就算了 */
    }
  };
  for (const t of tabs) t.onclick = () => showTab(t.dataset.tab!);
  let initial = 'todo';
  try {
    initial = localStorage.getItem('clawd-assistant:tab') ?? 'todo';
  } catch {
    /* 同上 */
  }
  showTab(tabs.some((t) => t.dataset.tab === initial) ? initial : 'todo');

  // ---------- 待办 ----------

  $<HTMLFormElement>('todoForm').onsubmit = (e) => {
    e.preventDefault();
    const text = $<HTMLInputElement>('todoText').value.trim();
    if (!text) return;
    const due = $<HTMLInputElement>('todoDue').value || null;
    change((d) => d.todos.push({ id: newId(), text, done: false, due, reminded: false, created: Date.now() }));
    $<HTMLInputElement>('todoText').value = '';
    $<HTMLInputElement>('todoDue').value = '';
    $('todoText').focus();
  };
  $('clearDone').onclick = () => change((d) => (d.todos = d.todos.filter((t) => !t.done)));

  const editTodo = (id: string, fn: (t: Todo) => void) =>
    change((d) => {
      const t = d.todos.find((x) => x.id === id);
      if (t) fn(t);
    });

  const todoRow = (t: Todo) => {
    const check = el('input', { type: 'checkbox', checked: t.done, title: t.text });
    check.onchange = () => editTodo(t.id, (x) => (x.done = check.checked));
    const text = el('input', { type: 'text', value: t.text, className: 'todo-text', maxLength: 200 });
    text.onchange = () => {
      const v = text.value.trim();
      if (v) editTodo(t.id, (x) => (x.text = v));
      else text.value = t.text;
    };
    text.onkeydown = (e) => e.key === 'Enter' && text.blur();
    const overdue = !t.done && t.due !== null && dueTime(t.due) < Date.now();
    const due = el('input', { type: 'datetime-local', value: t.due ?? '', className: `due${overdue ? ' overdue' : ''}${t.due ? '' : ' unset'}`, title: W.noDue });
    due.onchange = () =>
      editTodo(t.id, (x) => {
        x.due = due.value || null;
        // 改了截止时间：重新提醒
        x.reminded = false;
      });
    const del = el('button', { type: 'button', className: 'icon-btn', textContent: '×', title: W.delete });
    del.setAttribute('aria-label', W.delete);
    del.onclick = () => change((d) => (d.todos = d.todos.filter((x) => x.id !== t.id)));
    return el('li', { className: t.done ? 'done' : '' }, check, el('div', { className: 'grow' }, text), due, del);
  };

  const renderTodos = () => {
    // 没完成的按截止时间排（没截止时间的放后面），完成的收起来
    const open = data.todos
      .filter((t) => !t.done)
      .sort((a, b) => (a.due ? dueTime(a.due) : Infinity) - (b.due ? dueTime(b.due) : Infinity) || a.created - b.created);
    const done = data.todos.filter((t) => t.done);
    $('todoList').replaceChildren(...open.map(todoRow));
    $('todoEmpty').hidden = data.todos.length > 0;
    $('doneBox').hidden = done.length === 0;
    $('doneSummary').textContent = W.done(done.length);
    $('doneList').replaceChildren(...done.map(todoRow));
  };

  // ---------- 日历 ----------

  $<HTMLFormElement>('urlForm').onsubmit = (e) => {
    e.preventDefault();
    const input = $<HTMLInputElement>('urlInput');
    const url = input.value.trim();
    if (!url) return;
    if (!/^(https?|webcals?):\/\//i.test(url)) {
      note(W.badUrl);
      return;
    }
    let name = url;
    try {
      name = new URL(url.replace(/^webcals?:/i, 'https:')).hostname;
    } catch {
      /* 留原样 */
    }
    change((d) => d.calendar.sources.push({ id: newId(), name, kind: 'url', target: url, enabled: true }));
    input.value = '';
  };
  $('pickFile').onclick = async () => {
    const path = await pickIcsFile().catch(() => null);
    if (path === null) {
      if (!('__TAURI_INTERNALS__' in window)) note(W.pickUnavailable);
      return;
    }
    const name = path.split(/[\\/]/).pop() ?? path;
    change((d) => d.calendar.sources.push({ id: newId(), name, kind: 'file', target: path, enabled: true }));
  };
  $('refresh').onclick = () => bus.emit('assistant-cmd', { cmd: 'refresh' });

  const sourceRow = (s: CalendarSource) => {
    const on = el('input', { type: 'checkbox', checked: s.enabled, title: W.enabled });
    on.setAttribute('aria-label', W.enabled);
    on.onchange = () =>
      change((d) => {
        const x = d.calendar.sources.find((y) => y.id === s.id);
        if (x) x.enabled = on.checked;
      });
    const st = status?.sources[s.id];
    let line = '';
    let cls = 'source-status';
    if (s.enabled && status) {
      if (!st || (!st.ok && !st.error)) line = W.statusLoading;
      else if (st.error) {
        line = W.statusErr(st.error);
        cls += ' err';
      } else {
        line = W.statusOk(st.count, st.fetchedAt ? hhmm(st.fetchedAt) : '');
        cls += ' ok';
      }
    }
    const del = el('button', { type: 'button', className: 'icon-btn', textContent: '×', title: W.delete });
    del.setAttribute('aria-label', W.delete);
    del.onclick = () => change((d) => (d.calendar.sources = d.calendar.sources.filter((x) => x.id !== s.id)));
    const target = s.kind === 'file' ? `${W.file} · ${s.target}` : s.target.replace(/([?&](?:token|key|auth|private)[^=]*=)[^&]+/gi, '$1…');
    return el(
      'li',
      {},
      on,
      el(
        'div',
        { className: 'grow' },
        el('div', { className: 'source-name', textContent: s.name || s.target }),
        el('div', { className: 'source-target', textContent: target, title: s.kind === 'file' ? s.target : '' }),
        line ? el('div', { className: cls, textContent: line }) : '',
      ),
      del,
    );
  };

  const renderSources = () => {
    $('sourceList').replaceChildren(...data.calendar.sources.map(sourceRow));
    $('sourceEmpty').hidden = data.calendar.sources.length > 0;
  };

  const renderUpcoming = () => {
    const box = $('upcoming');
    if (!status) {
      box.replaceChildren(el('p', { className: 'empty', textContent: W.waiting }));
      return;
    }
    if (!status.upcoming.length) {
      box.replaceChildren(el('p', { className: 'empty', textContent: W.noUpcoming }));
      return;
    }
    const nodes: Node[] = [];
    let lastDay = '';
    for (const e of status.upcoming) {
      const day = dayLabel(e.start);
      if (day !== lastDay) {
        nodes.push(el('div', { className: 'day', textContent: day }));
        lastDay = day;
      }
      const when = e.allDay ? W.allDay : `${hhmm(e.start)}–${hhmm(e.end)}`;
      nodes.push(
        el(
          'div',
          { className: 'event' },
          el('time', { textContent: when }),
          el('div', {}, e.title || '—', e.location ? el('span', { className: 'where', textContent: ` · ${e.location}` }) : ''),
        ),
      );
    }
    box.replaceChildren(...nodes);
  };

  const hourOptions = (sel: HTMLSelectElement) =>
    sel.replaceChildren(...Array.from({ length: 24 }, (_, h) => el('option', { value: String(h), textContent: W.hour(h) })));
  for (const id of ['allDayHour', 'chimeFrom', 'chimeTo']) hourOptions($(id));

  /** 数字/下拉框/开关 ↔ 数据里的某个字段 */
  const bindNum = (id: string, get: (d: AssistantData) => number, set: (d: AssistantData, v: number) => void) => {
    const input = $<HTMLInputElement | HTMLSelectElement>(id);
    input.onchange = () => {
      const v = Number(input.value);
      if (Number.isFinite(v)) change((d) => set(d, v));
    };
    return () => (input.value = String(get(data)));
  };
  const bindBool = (id: string, get: (d: AssistantData) => boolean, set: (d: AssistantData, v: boolean) => void) => {
    const input = $<HTMLInputElement>(id);
    input.onchange = () => change((d) => set(d, input.checked));
    return () => (input.checked = get(data));
  };
  const fields = [
    bindNum('leadMin', (d) => d.calendar.leadMin, (d, v) => (d.calendar.leadMin = v)),
    bindNum('refreshMin', (d) => d.calendar.refreshMin, (d, v) => (d.calendar.refreshMin = v)),
    bindNum('allDayHour', (d) => d.calendar.allDayHour, (d, v) => (d.calendar.allDayHour = v)),
    bindBool('chimeOn', (d) => d.chime.enabled, (d, v) => (d.chime.enabled = v)),
    bindNum('chimeFrom', (d) => d.chime.from, (d, v) => (d.chime.from = v)),
    bindNum('chimeTo', (d) => d.chime.to, (d, v) => (d.chime.to = v)),
    bindBool('restOn', (d) => d.rest.enabled, (d, v) => (d.rest.enabled = v)),
    bindNum('workMin', (d) => d.rest.workMin, (d, v) => (d.rest.workMin = v)),
    bindNum('awayMin', (d) => d.rest.awayMin, (d, v) => (d.rest.awayMin = v)),
    bindNum('repeatMin', (d) => d.rest.repeatMin, (d, v) => (d.rest.repeatMin = v)),
  ];

  const renderActive = () => {
    $('activeNow').textContent = status && data.rest.enabled ? W.active(status.activeMin) : '';
  };

  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-test]')) {
    b.onclick = () => bus.emit('assistant-cmd', { cmd: 'test', kind: b.dataset.test });
  }

  // ---------- 画 ----------

  function render() {
    renderTodos();
    renderSources();
    renderUpcoming();
    renderActive();
    for (const f of fields) f();
  }
  render();
  // 过期标红要跟着时间走
  window.setInterval(renderTodos, 60000);
}

void main();

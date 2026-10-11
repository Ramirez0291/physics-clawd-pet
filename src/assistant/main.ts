// 小助手窗口：管理待办、日历订阅、报时和休息提醒的设置。
// 提醒本身由覆盖层（宠物那边）负责；这里只改数据，再显示覆盖层发来的日程和状态。

import { folderName } from '../claude/agent';
import type { ClaudeLive } from '../overlay/claude';
import type { AssistantStatus } from '../overlay/companion';
import {
  type CcStatus,
  ccInstall,
  ccStatus,
  ccUninstall,
  createBus,
  loadAssistant,
  pickIcsFile,
  saveAssistant,
} from '../platform/host';
import { dayLabel, hhmm, pick } from './i18n';
import { type AssistantData, type CalendarSource, type Todo, dueTime, newId, sanitizeAssistant } from './model';
import { W } from './strings';

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
  // <html lang> 由 i18n.ts 按系统语言设置
  document.title = pick({ zh: 'Clawd 小助手', ja: 'Clawd アシスタント', en: 'Clawd Assistant' });
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
    // 日文/中文输入法组字时按 Enter 是"确定候选"，不是"完成编辑"（keyCode 229 = IME 正在处理）
    text.onkeydown = (e) => e.key === 'Enter' && !e.isComposing && e.keyCode !== 229 && text.blur();
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
    bindBool('ccCelebrate', (d) => d.claude.celebrate, (d, v) => (d.claude.celebrate = v)),
    bindBool('ccDoneBubble', (d) => d.claude.doneBubble, (d, v) => (d.claude.doneBubble = v)),
    bindBool('ccZap', (d) => d.claude.zap, (d, v) => (d.claude.zap = v)),
    bindBool('ccMinis', (d) => d.claude.minis, (d, v) => (d.claude.minis = v)),
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

  // ---------- Claude Code ----------

  let cc: CcStatus | null = null;
  let live: ClaudeLive | null = null;
  const permBox = $<HTMLInputElement>('ccPermission');
  permBox.checked = true;
  const agoText = (t: number) => W.ago(Math.max(0, Math.round((Date.now() - t) / 1000)));

  function renderClaude() {
    if (!cc) return;
    const state = $('ccState');
    const toggle = $<HTMLButtonElement>('ccToggle');
    const h = cc.hooks;
    let text: string;
    let cls = 'cc-state';
    const problem = cc.bridge_error ?? h.error;
    if (problem) {
      text = problem;
      cls += ' err';
    } else if (h.installed && !h.current) {
      text = W.ccStale;
      cls += ' err';
    } else if (h.installed) {
      text = `${W.ccOn}\n${cc.last_event ? W.ccLast(agoText(cc.last_event)) : W.ccNever}`;
      cls += ' ok';
    } else {
      text = W.ccOff;
    }
    state.textContent = text;
    state.className = cls;
    state.style.whiteSpace = 'pre-line';
    toggle.textContent = h.installed ? (h.current ? W.ccDisable : W.ccReinstall) : W.ccEnable;
    toggle.className = h.installed && h.current ? '' : 'primary';
    toggle.disabled = !!cc.bridge_error && !h.installed;
    $('ccHint').textContent = W.ccHint(h.settings_path);

    const sessions = live?.sessions ?? [];
    $('ccSessions').replaceChildren(
      ...sessions.map((s) => {
        const mood = `${W.ccMood[s.mood] ?? s.mood}${s.subagents ? W.ccSubagents(s.subagents) : ''} · ${agoText(s.last)}`;
        return el(
          'li',
          {},
          el(
            'div',
            { className: 'grow' },
            el('div', { className: 'source-name', textContent: folderName(s.cwd) || s.id }),
            el('div', { className: 'source-target', textContent: s.cwd, title: s.cwd }),
          ),
          el('span', { className: 'session-mood', textContent: mood }),
        );
      }),
    );
    $('ccNoSessions').hidden = sessions.length > 0;
  }

  async function refreshClaude() {
    try {
      cc = await ccStatus();
      if (cc.hooks.installed) permBox.checked = cc.hooks.permission;
    } catch (e) {
      note(String(e));
    }
    renderClaude();
  }

  $('ccToggle').onclick = async () => {
    try {
      if (cc?.hooks.installed && cc.hooks.current) await ccUninstall();
      else await ccInstall(permBox.checked);
    } catch (e) {
      note(String(e));
    }
    await refreshClaude();
  };
  permBox.onchange = async () => {
    if (!cc?.hooks.installed) return;
    try {
      await ccInstall(permBox.checked);
    } catch (e) {
      note(String(e));
    }
    await refreshClaude();
  };

  bus.on('cc-live', (l: ClaudeLive) => {
    live = l;
    renderClaude();
  });
  bus.emit('cc-hello');
  void refreshClaude();
  window.setInterval(() => {
    if (!$('tab-claude').hidden) void refreshClaude();
  }, 5000);

  // 试一下：在本地编几条 Claude Code 事件发给覆盖层
  const testSession = 'clawd-test';
  const testCwd = pick({ zh: '~/示例项目', ja: '~/サンプル', en: '~/demo-project' });
  const fake = (event: string, extra: Record<string, unknown> = {}) =>
    bus.emit('cc-event', { event, session_id: testSession, cwd: testCwd, t: Date.now(), ...extra });
  let subN = 0;
  const tests: Record<string, () => void> = {
    think: () => fake('UserPromptSubmit'),
    work: () => fake('PreToolUse', { tool_name: 'Bash', tool: 'npm test' }),
    sub: () => fake('SubagentStart', { agent_id: `test-${++subN}`, agent_type: 'general-purpose' }),
    compact: () => {
      fake('PreCompact', { trigger: 'manual' });
      window.setTimeout(() => fake('PostCompact', { trigger: 'manual' }), 5000);
    },
    error: () => fake('PostToolUseFailure', { tool_name: 'Bash', tool: 'npm test', error: 'Exit code 1' }),
    perm: () =>
      bus.emit('cc-permission', {
        id: -Date.now(),
        event: 'PermissionRequest',
        session_id: testSession,
        cwd: testCwd,
        t: Date.now(),
        tool_name: 'Bash',
        tool: 'rm -rf node_modules && npm install',
      }),
    done: () => {
      // 假装这一轮干了一分钟、用过工具：庆祝和气泡都会出来
      fake('UserPromptSubmit', { t: Date.now() - 60000 });
      fake('PreToolUse', { tool_name: 'Edit', tool: 'src/app.ts', t: Date.now() - 50000 });
      fake('Stop', {
        last: pick({ zh: '全部 42 个测试都通过了。', ja: '42個のテストがすべて通りました。', en: 'All 42 tests pass.' }),
      });
    },
  };
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-cc-test]')) {
    b.onclick = () => tests[b.dataset.ccTest!]?.();
  }

  // ---------- 画 ----------

  function render() {
    renderClaude();
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

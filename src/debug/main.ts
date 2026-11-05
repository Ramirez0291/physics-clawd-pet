import {
  DEFAULT_TUNING,
  PARAM_DEFS,
  type ParamDef,
  type Tuning,
  type TuningKey,
  mergeTuning,
} from '../engine/params';
import type { Telemetry } from '../overlay/main';
import { type SkinInfo, createBus, isTauri, loadTuning, openAssistantPanel, saveTuning } from '../platform/host';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const MODE_NAMES: Record<string, string> = {
  idle: '发呆',
  walk: '走路',
  held: '被拎着',
  air: '飞行',
  land: '落地',
  roll: '翻滚',
  hero: '英雄落地',
  splat: '脸着地',
  cling: '贴墙',
  petted: '被摸摸',
  laptop: '敲代码',
  stocks: '炒股',
  coin: '吃TOKEN',
  shake: '抖毛',
  read: '读书',
  write: '写字',
  think: '思考',
  perch: '坐标题栏',
  peek: '边缘探头',
  hop: '跳窗蓄力',
  chime: '报时',
  stretch: '伸懒腰',
  sign: '举牌子',
  zap: '被电',
  knock: '跺脚',
  sweep: '扫地',
  clip: '播片',
  magic: '魔法',
};
/** 播片按钮上的名字（文件名 → 中文） */
const CLIP_NAMES: Record<string, string> = { ghost: '床单幽灵' };
const SIDE_NAMES: Record<string, string> = { floor: '地面', ceiling: '天花板', left: '左墙', right: '右墙' };
const TIER_NAMES: Record<string, string> = {
  soft: '普通',
  bounce: '弹跳',
  roll: '翻滚',
  hero: '英雄',
  splat: '脸着地',
  wall: '撞墙',
  cling: '贴墙',
};

interface Row {
  def: ParamDef;
  el: HTMLElement;
  range: HTMLInputElement;
  num: HTMLInputElement;
}

const decimals = (step: number) => Math.max(0, Math.ceil(-Math.log10(step) - 1e-9));

/** 原生按钮负责 Enter / Space，方向键在同一组标签间移动。 */
function bindTabs(selector: string, select: (button: HTMLButtonElement) => void) {
  const buttons = [...document.querySelectorAll<HTMLButtonElement>(selector)];
  for (const button of buttons) {
    button.onclick = () => select(button);
    button.onkeydown = (e) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
      e.preventDefault();
      const visible = buttons.filter((b) => !b.hidden);
      const index = visible.indexOf(button);
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? visible.length - 1
        : (index + (e.key === 'ArrowRight' ? 1 : -1) + visible.length) % visible.length;
      select(visible[next]);
      visible[next].focus();
    };
  }
}

async function main() {
  const bus = await createBus();
  let tuning: Tuning = { ...DEFAULT_TUNING };
  let defaults: Tuning = { ...DEFAULT_TUNING };
  let connected = false;
  let availableActions = new Set<string>();
  const rows = new Map<TuningKey, Row[]>();
  const groups: { name: string; view: string; details: HTMLDetailsElement; count: HTMLElement; keys: TuningKey[] }[] = [];
  let activeView = 'common';
  let filtering = false;
  const expandedBeforeFilter = new Map<HTMLDetailsElement, boolean>();

  // ---------- 参数控件 ----------

  const container = $('params');
  function createRow(def: ParamDef, context: string) {
    const el = document.createElement('div');
    el.className = 'row';
    el.dataset.key = def.key;
    const label = document.createElement('label');
    label.textContent = def.label;
    label.title = `${def.key}${def.hint ? '\n' + def.hint : ''}`;
    const range = document.createElement('input');
    range.id = `${context}-${def.key}`;
    label.htmlFor = range.id;
    range.setAttribute('aria-label', def.label);
    const num = document.createElement('input');
    num.type = 'number';
    num.step = String(def.step);
    num.setAttribute('aria-label', `${def.label}数值`);
    if (def.kind === 'bool') {
      el.classList.add('bool-row');
      range.type = 'checkbox';
      range.className = 'bool';
      num.hidden = true;
    } else {
      range.type = 'range';
      range.min = String(def.min);
      range.max = String(def.max);
      range.step = String(def.step);
    }
    const reset = document.createElement('button');
    reset.className = 'reset';
    reset.textContent = '↺';
    reset.title = '恢复默认';
    reset.setAttribute('aria-label', `${def.label}恢复默认`);
    el.append(label, range, num, reset);
    rows.set(def.key, [...(rows.get(def.key) ?? []), { def, el, range, num }]);

    const commit = (v: number) => setValue(def.key, v, true);
    range.addEventListener('input', () => commit(def.kind === 'bool' ? (range.checked ? 1 : 0) : Number(range.value)));
    num.addEventListener('change', () => {
      const v = Number(num.value);
      if (Number.isFinite(v)) commit(v);
    });
    reset.addEventListener('click', () => commit(defaults[def.key]));
    return el;
  }

  function createGroup(name: string, view: string, defs: ParamDef[]) {
    const details = document.createElement('details');
    details.className = 'param-group';
    details.open = view === 'common';
    const summary = document.createElement('summary');
    const title = document.createElement('span');
    title.className = 'group-name';
    title.textContent = name;
    summary.append(title);
    const count = document.createElement('span');
    count.className = 'count';
    summary.append(count);
    details.append(summary, ...defs.map((def) => createRow(def, view)));
    container.append(details);
    groups.push({ name, view, details, count, keys: defs.map((def) => def.key) });
    details.addEventListener('toggle', () => {
      // 高级参数一次只展开一组；搜索时允许展开所有匹配结果。
      if (details.open && view !== 'common' && !filtering) {
        for (const other of groups) {
          if (other.view === view && other.details !== details) other.details.open = false;
        }
      }
    });
  }
  const defsFor = (keys: TuningKey[]) => keys.map((key) => PARAM_DEFS.find((def) => def.key === key)!);
  createGroup('大小与日常', 'common', defsFor(['petScale', 'walkSpeed', 'avoidInput']));
  createGroup('抛掷手感', 'common', defsFor(['throwMul', 'floorRestitution']));
  for (const name of new Set(PARAM_DEFS.map((def) => def.group))) {
    const view = ['行为', '小动作', '避让输入框'].includes(name) ? 'behavior'
      : ['外观', '调试显示'].includes(name) ? 'appearance' : 'physics';
    createGroup(name, view, PARAM_DEFS.filter((def) => def.group === name));
  }

  function render(key: TuningKey) {
    const v = tuning[key];
    for (const r of rows.get(key)!) {
      if (r.def.kind === 'bool') r.range.checked = v !== 0;
      else {
        r.range.value = String(v);
        r.el.style.setProperty('--pct', `${Math.min(100, Math.max(0, ((v - r.def.min) / (r.def.max - r.def.min)) * 100))}%`);
      }
      r.num.value = v.toFixed(decimals(r.def.step));
      r.el.classList.toggle('changed', Math.abs(v - defaults[key]) > 1e-12);
    }
  }

  function renderAll() {
    for (const key of rows.keys()) render(key);
    applyFilter();
  }

  function setValue(key: TuningKey, v: number, send: boolean) {
    tuning[key] = v;
    render(key);
    applyFilter();
    if (send) bus.emit('tuning-set', { [key]: v });
  }

  function updateCounts() {
    for (const g of groups) {
      const n = g.keys.filter((k) => Math.abs(tuning[k] - defaults[k]) > 1e-12).length;
      g.count.textContent = n ? `${n}/${g.keys.length}` : String(g.keys.length);
      g.count.title = n ? `共 ${g.keys.length} 项，改了 ${n} 项` : `共 ${g.keys.length} 项`;
      g.count.classList.toggle('changed-count', n > 0);
    }
    const changed = [...rows.keys()].filter((key) => Math.abs(tuning[key] - defaults[key]) > 1e-12).length;
    $('changeSummary').textContent = changed ? `${changed} 项与默认不同` : '当前为默认参数';
    $('changeSummary').classList.toggle('has-changes', changed > 0);
  }

  function applyFilter() {
    const q = $<HTMLInputElement>('search').value.trim().toLowerCase();
    const changedOnly = $<HTMLInputElement>('changedOnly').checked;
    const nextFiltering = !!q || changedOnly;
    if (nextFiltering && !filtering) {
      for (const g of groups) expandedBeforeFilter.set(g.details, g.details.open);
    } else if (!nextFiltering && filtering) {
      for (const g of groups) g.details.open = expandedBeforeFilter.get(g.details) ?? false;
      expandedBeforeFilter.clear();
    }
    filtering = nextFiltering;
    let totalVisible = 0;
    for (const g of groups) {
      const inView = filtering ? g.view !== 'common' : g.view === activeView;
      let visible = 0;
      for (const key of g.keys) {
        const r = rows.get(key)!.find((row) => row.el.parentElement === g.details)!;
        const matches =
          inView && (!q || g.name.includes(q) || r.def.label.toLowerCase().includes(q) || key.toLowerCase().includes(q)) &&
          (!changedOnly || Math.abs(tuning[key] - defaults[key]) > 1e-12);
        r.el.classList.toggle('hidden', !matches);
        if (matches) visible++;
      }
      g.details.classList.toggle('hidden', visible === 0);
      if (filtering && visible) g.details.open = true;
      totalVisible += visible;
    }
    $('empty').hidden = totalVisible > 0;
    $('viewHint').textContent = filtering ? `在全部参数中找到 ${totalVisible} 项，切换分类可退出筛选。`
      : activeView === 'common' ? '常用的几项放在这里，更多细节按分类展开。' : '展开一组调节，修改会实时生效。';
    container.setAttribute('aria-labelledby', filtering ? 'viewHint' : `tab-${activeView}`);
    updateCounts();
  }
  $('search').addEventListener('input', applyFilter);
  $('changedOnly').addEventListener('change', applyFilter);
  bindTabs('[data-view]', (button) => {
    activeView = button.dataset.view!;
    $<HTMLInputElement>('search').value = '';
    $<HTMLInputElement>('changedOnly').checked = false;
    for (const tab of document.querySelectorAll<HTMLButtonElement>('[data-view]')) {
      const selected = tab === button;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
    }
    applyFilter();
  });

  // ---------- 分类动作弹框 ----------

  const actionDialog = $<HTMLDialogElement>('actionDialog');
  function selectActionTab(button: HTMLButtonElement) {
    for (const tab of document.querySelectorAll<HTMLButtonElement>('[data-action-tab]')) {
      const selected = tab === button;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
    }
    for (const page of document.querySelectorAll<HTMLElement>('[data-action-page]')) {
      page.hidden = page.dataset.actionPage !== button.dataset.actionTab;
    }
  }
  bindTabs('[data-action-tab]', selectActionTab);
  $('actionMenu').onclick = () => {
    $<HTMLDetailsElement>('configMenu').open = false;
    actionDialog.showModal();
    actionDialog.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus();
  };
  $('closeActions').onclick = () => actionDialog.close();
  actionDialog.addEventListener('click', (e) => {
    const rect = actionDialog.getBoundingClientRect();
    if (e.target === actionDialog && (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom)) {
      actionDialog.close();
    }
  });

  // ---------- 覆盖层状态 ----------

  let paused = false;
  const skinSelect = $<HTMLSelectElement>('skin');
  bus.on(
    'tuning-state',
    (s: {
      tuning: Tuning;
      defaults: Tuning;
      paused: boolean;
      skins: SkinInfo[];
      skin: string;
      category?: 'creature' | 'humanoid';
      actions: string[];
      clips?: string[];
    }) => {
      connected = true;
      availableActions = new Set(s.actions);
      tuning = mergeTuning(DEFAULT_TUNING, s.tuning);
      defaults = mergeTuning(DEFAULT_TUNING, s.defaults);
      paused = s.paused;
      $('pause').textContent = paused ? '继续' : '暂停';
      $('pause').classList.toggle('active', paused);
      $('pause').setAttribute('aria-pressed', String(paused));
      document.querySelector('.telemetry')?.classList.add('connected');
      skinSelect.replaceChildren(...(['creature', 'humanoid'] as const).flatMap((category) => {
        const skins = s.skins.filter((skin) => (skin.category ?? 'creature') === category);
        if (!skins.length) return [];
        const group = document.createElement('optgroup');
        group.label = category === 'humanoid' ? '拟人角色' : '宠物角色';
        group.append(...skins.map(({ id, name }) => new Option(name, id, false, id === s.skin)));
        return [group];
      }));
      // 当前形象不会的小动作按钮置灰（摸摸和提醒动作谁都会）
      for (const b of document.querySelectorAll<HTMLButtonElement>('[data-act]')) {
        const act = b.dataset.act!;
        b.disabled = act !== 'petted' && !b.hasAttribute('data-cue') && !s.actions.includes(act);
        b.title = b.disabled ? '这个形象不会这个动作' : '';
      }
      const affection = document.querySelector<HTMLButtonElement>('[data-act="petted"]');
      if (affection) {
        affection.title = s.category === 'humanoid' ? '脸红、双手合在胸前，安静地表达喜欢' : '摸摸头';
      }
      // 播片按钮：当前形象有哪些片就列哪些
      $('clips').replaceChildren(
        ...(s.clips ?? []).map((id) => {
          const b = document.createElement('button');
          b.textContent = CLIP_NAMES[id] ?? id;
          b.onclick = () => cmd('act', `clip:${id}`);
          return b;
        }),
      );
      $('clipTab').hidden = !s.clips?.length;
      if (!s.clips?.length && $('clipTab').getAttribute('aria-selected') === 'true') {
        selectActionTab($<HTMLButtonElement>('action-tab-daily'));
      }
      renderAll();
    },
  );
  // 换形象会立即保存，不用再点"保存"
  skinSelect.onchange = () => bus.emit('pet-skin', { id: skinSelect.value });

  // 遥测每秒刷新多次：两栏只建一次，之后只改文字。
  const statusValues = new Map<string, HTMLElement>();
  function renderStatus(lines: [string, string][]) {
    const box = $('status');
    if (!statusValues.size) box.replaceChildren();
    for (const [key, text] of lines) {
      let value = statusValues.get(key);
      if (!value) {
        const name = document.createElement('span');
        name.className = 'status-key';
        name.textContent = key;
        value = document.createElement('span');
        box.append(name, value);
        statusValues.set(key, value);
      }
      value.textContent = text;
    }
  }

  bus.on('telemetry', (t: Telemetry) => {
    for (const action of ['perch', 'peek', 'hop']) {
      const button = document.querySelector<HTMLButtonElement>(`[data-act="${action}"]`);
      if (!button) continue;
      const possible = action === 'hop' ? t.canWindowHop : t.support !== null;
      button.disabled = !availableActions.has(action) || !possible;
      button.title = !availableActions.has(action) ? '这个形象不会这个动作' : possible ? '' : action === 'hop' ? '附近没有够得着的窗口' : '先把角色放到窗口标题栏上';
    }
    if (!connected) bus.emit('debug-hello');
    const grounded = !['air', 'held'].includes(t.mode);
    const surface = t.support !== null ? '窗口顶上' : (SIDE_NAMES[t.side] ?? t.side);
    const where = grounded ? ` @ ${surface}` : '';
    $('statusSummary').textContent = `${MODE_NAMES[t.mode] ?? t.mode}${grounded ? ` · ${surface}` : ''}${t.paused ? ' · 已暂停' : ''}`;
    const impact = t.lastImpact
      ? `${TIER_NAMES[t.lastImpact.tier] ?? t.lastImpact.tier} ${Math.round(t.lastImpact.speed)} px/s`
      : '—';
    renderStatus([
      ['状态', `${MODE_NAMES[t.mode] ?? t.mode}${where}${t.paused ? '（已暂停）' : ''}`],
      ['速度', `${Math.round(t.speed)} px/s (${Math.round(t.vx)}, ${Math.round(t.vy)})`],
      ['自转', `${t.angVel.toFixed(1)} rad/s`],
      ['上次冲击', impact],
      ['眩晕', `${t.dizzy.toFixed(1)} s`],
      ['帧率', `${Math.round(t.fps)} fps`],
      ['光标', `${t.cursor ? `${Math.round(t.cursor.x)}, ${Math.round(t.cursor.y)}` : '—'} · ${t.hover ? '在宠物上（可抓取）' : '点击穿透'}`],
      ['窗口', `${t.platforms} 段可站顶边`],
      ['脚下窗口', t.support !== null ? `${Math.round(t.carrierSpeed)} px/s` : '—'],
      ['屏幕', `${t.screen} / ${t.screens}`],
      ['输入框', `${t.input ? t.input.map(Math.round).join(', ') : '—'}${t.fleeing ? ' · 正在让路' : ''}`],
    ]);
    $<HTMLButtonElement>('replay').disabled = !t.hasLaunch;
    if (t.paused !== paused) {
      paused = t.paused;
      $('pause').textContent = paused ? '继续' : '暂停';
      $('pause').classList.toggle('active', paused);
      $('pause').setAttribute('aria-pressed', String(paused));
    }
  });

  // ---------- 按钮 ----------

  const cmd = (name: string, arg?: string) => {
    bus.emit('debug-cmd', { cmd: name, arg });
    if (actionDialog.open) actionDialog.close();
  };
  $('pause').onclick = () => cmd('pause');
  $('step').onclick = () => cmd('step');
  $('reset').onclick = () => cmd('reset');
  $('nextScreen').onclick = () => cmd('next-screen');
  $('replay').onclick = () => cmd('replay');
  $('openAssistant').onclick = () => void openAssistantPanel();
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-preset]')) {
    b.onclick = () => cmd('preset', b.dataset.preset);
  }
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-act]')) {
    b.onclick = () => cmd('act', b.dataset.act);
  }

  const note = (msg: string) => ($('note').textContent = msg);
  function showImport(show: boolean) {
    $('importBox').hidden = !show;
    $('importToggle').setAttribute('aria-expanded', String(show));
    if (show) $<HTMLDetailsElement>('configMenu').open = true;
  }
  document.addEventListener('click', (e) => {
    const menu = $<HTMLDetailsElement>('configMenu');
    if (menu.open && !menu.contains(e.target as Node)) menu.open = false;
  });

  $('save').onclick = async () => {
    try {
      // 合并进已保存的文件：托盘菜单存的形象等设置不会被覆盖掉
      const where = await saveTuning({ ...(await loadTuning()), ...tuning });
      note(`已保存到 ${where}`);
    } catch (e) {
      note(`保存失败：${e}`);
    }
  };
  $('defaults').onclick = () => {
    tuning = { ...defaults };
    bus.emit('tuning-set', tuning);
    renderAll();
    note('已恢复默认（还没保存）');
  };
  $('copy').onclick = async () => {
    const changed = Object.fromEntries(
      (Object.keys(tuning) as TuningKey[])
        .filter((k) => Math.abs(tuning[k] - defaults[k]) > 1e-12)
        .map((k) => [k, tuning[k]]),
    );
    const text = JSON.stringify(changed, null, 2);
    try {
      await navigator.clipboard.writeText(text);
      note(`已复制 ${Object.keys(changed).length} 项改动`);
    } catch {
      $<HTMLTextAreaElement>('importText').value = text;
      showImport(true);
      note('剪贴板不可用，已放到下面的文本框里');
    }
  };
  $('importToggle').onclick = () => showImport(!!$('importBox').hidden);
  $('importApply').onclick = () => {
    try {
      const patch = JSON.parse($<HTMLTextAreaElement>('importText').value);
      tuning = mergeTuning(tuning, patch);
      bus.emit('tuning-set', tuning);
      renderAll();
      note('已导入（还没保存）');
    } catch (e) {
      note(`JSON 解析失败：${e}`);
    }
  };

  if (isTauri) {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    const win = getCurrentWindow();
    $<HTMLInputElement>('pin').addEventListener('change', (e) => {
      void win.setAlwaysOnTop((e.target as HTMLInputElement).checked);
    });
    // 面板自己变成全屏窗口：覆盖层应该自动隐藏，退出后 Clawd 从天上掉回来
    $('fullscreenTest').onclick = async () => {
      actionDialog.close();
      const on = !(await win.isFullscreen());
      await win.setFullscreen(on);
      note(on ? '全屏中：Clawd 应该已经躲起来了。按 Esc 退出' : '');
    };
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !actionDialog.open) void win.setFullscreen(false).then(() => note(''));
    });
  } else {
    $('pinWrap').hidden = true;
    $('fullscreenTest').hidden = true;
  }

  // 快捷键（焦点不在输入框时）
  window.addEventListener('keydown', (e) => {
    if (actionDialog.open || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    const tag = (e.target as HTMLElement).tagName;
    if (e.key === 'Escape') {
      $<HTMLDetailsElement>('configMenu').open = false;
      return;
    }
    if (['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'SUMMARY'].includes(tag) || (e.target as HTMLElement).isContentEditable) return;
    if (e.key === ' ') {
      e.preventDefault();
      cmd('pause');
    } else if (e.key === 'ArrowRight') {
      cmd('step');
    } else if (e.key === 'r' || e.key === 'R') {
      cmd('replay');
    }
  });

  renderAll();
  bus.emit('debug-hello');
  // 心跳：覆盖层只在面板开着时才发遥测
  setInterval(() => bus.emit('debug-ping'), 2000);
}

void main();

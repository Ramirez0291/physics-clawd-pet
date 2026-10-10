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
  chime: '报时',
  stretch: '伸懒腰',
  sign: '举牌子',
};
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

async function main() {
  const bus = await createBus();
  let tuning: Tuning = { ...DEFAULT_TUNING };
  let defaults: Tuning = { ...DEFAULT_TUNING };
  let connected = false;
  const rows = new Map<TuningKey, Row>();
  const groups = new Map<string, { details: HTMLDetailsElement; count: HTMLElement; keys: TuningKey[] }>();

  // ---------- 参数控件 ----------

  const container = $('params');
  for (const def of PARAM_DEFS) {
    let g = groups.get(def.group);
    if (!g) {
      const details = document.createElement('details');
      details.open = true;
      const summary = document.createElement('summary');
      summary.textContent = def.group;
      const count = document.createElement('span');
      count.className = 'count';
      summary.append(count);
      details.append(summary);
      container.append(details);
      g = { details, count, keys: [] };
      groups.set(def.group, g);
    }
    g.keys.push(def.key);

    const el = document.createElement('div');
    el.className = 'row';
    const label = document.createElement('label');
    label.textContent = def.label;
    label.title = `${def.key}${def.hint ? '\n' + def.hint : ''}`;
    const range = document.createElement('input');
    const num = document.createElement('input');
    num.type = 'number';
    num.step = String(def.step);
    if (def.kind === 'bool') {
      range.type = 'checkbox';
      range.className = 'bool';
      num.style.visibility = 'hidden';
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
    el.append(label, range, num, reset);
    g.details.append(el);
    rows.set(def.key, { def, el, range, num });

    const commit = (v: number) => setValue(def.key, v, true);
    range.addEventListener('input', () => commit(def.kind === 'bool' ? (range.checked ? 1 : 0) : Number(range.value)));
    num.addEventListener('change', () => {
      const v = Number(num.value);
      if (Number.isFinite(v)) commit(v);
    });
    reset.addEventListener('click', () => commit(defaults[def.key]));
  }

  function render(key: TuningKey) {
    const r = rows.get(key)!;
    const v = tuning[key];
    if (r.def.kind === 'bool') r.range.checked = v !== 0;
    else r.range.value = String(v);
    r.num.value = v.toFixed(decimals(r.def.step));
    r.el.classList.toggle('changed', Math.abs(v - defaults[key]) > 1e-12);
  }

  function renderAll() {
    for (const key of rows.keys()) render(key);
    applyFilter();
  }

  function setValue(key: TuningKey, v: number, send: boolean) {
    tuning[key] = v;
    render(key);
    updateCounts();
    if (send) bus.emit('tuning-set', { [key]: v });
  }

  function updateCounts() {
    for (const g of groups.values()) {
      const n = g.keys.filter((k) => Math.abs(tuning[k] - defaults[k]) > 1e-12).length;
      g.count.textContent = n ? `改了 ${n} 项` : '';
    }
  }

  function applyFilter() {
    const q = $<HTMLInputElement>('search').value.trim().toLowerCase();
    const changedOnly = $<HTMLInputElement>('changedOnly').checked;
    for (const [name, g] of groups) {
      let visible = 0;
      for (const key of g.keys) {
        const r = rows.get(key)!;
        const matches =
          (!q || name.includes(q) || r.def.label.toLowerCase().includes(q) || key.toLowerCase().includes(q)) &&
          (!changedOnly || Math.abs(tuning[key] - defaults[key]) > 1e-12);
        r.el.classList.toggle('hidden', !matches);
        if (matches) visible++;
      }
      g.details.classList.toggle('hidden', visible === 0);
    }
    updateCounts();
  }
  $('search').addEventListener('input', applyFilter);
  $('changedOnly').addEventListener('change', applyFilter);

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
      actions: string[];
    }) => {
      connected = true;
      tuning = mergeTuning(DEFAULT_TUNING, s.tuning);
      defaults = mergeTuning(DEFAULT_TUNING, s.defaults);
      paused = s.paused;
      $('pause').textContent = paused ? '继续' : '暂停';
      $('pause').classList.toggle('active', paused);
      skinSelect.replaceChildren(...s.skins.map(({ id, name }) => new Option(name, id, false, id === s.skin)));
      // 当前形象不会的小动作按钮置灰（摸摸和提醒动作谁都会）
      for (const b of document.querySelectorAll<HTMLButtonElement>('[data-act]')) {
        const act = b.dataset.act!;
        b.disabled = act !== 'petted' && !b.hasAttribute('data-cue') && !s.actions.includes(act);
        b.title = b.disabled ? '这个形象不会这个动作' : '';
      }
      renderAll();
    },
  );
  // 换形象会立即保存，不用再点"保存"
  skinSelect.onchange = () => bus.emit('pet-skin', { id: skinSelect.value });

  bus.on('telemetry', (t: Telemetry) => {
    if (!connected) bus.emit('debug-hello');
    const grounded = !['air', 'held'].includes(t.mode);
    const surface = t.support !== null ? '窗口顶上' : (SIDE_NAMES[t.side] ?? t.side);
    const where = grounded ? ` @ ${surface}` : '';
    const impact = t.lastImpact
      ? `${TIER_NAMES[t.lastImpact.tier] ?? t.lastImpact.tier} ${Math.round(t.lastImpact.speed)} px/s`
      : '—';
    $('status').textContent =
      `状态  ${MODE_NAMES[t.mode] ?? t.mode}${where}${t.paused ? '（已暂停）' : ''}\n` +
      `速度  ${Math.round(t.speed).toString().padStart(5)} px/s   (${Math.round(t.vx)}, ${Math.round(t.vy)})   自转 ${t.angVel.toFixed(1)} rad/s\n` +
      `上次冲击  ${impact}   眩晕 ${t.dizzy.toFixed(1)}s   ${Math.round(t.fps)} fps\n` +
      `光标  ${t.cursor ? `${Math.round(t.cursor.x)}, ${Math.round(t.cursor.y)}` : '—'}   ${t.hover ? '在宠物上（可抓取）' : '点击穿透'}\n` +
      `窗口  ${t.platforms} 段可站顶边   脚下窗口速度 ${t.support !== null ? `${Math.round(t.carrierSpeed)} px/s` : '—'}
` +
      `输入框  ${t.input ? t.input.map(Math.round).join(', ') : '—'}${t.fleeing ? '   正在让路' : ''}`;
    $<HTMLButtonElement>('replay').disabled = !t.hasLaunch;
    if (t.paused !== paused) {
      paused = t.paused;
      $('pause').textContent = paused ? '继续' : '暂停';
      $('pause').classList.toggle('active', paused);
    }
  });

  // ---------- 按钮 ----------

  const cmd = (name: string, arg?: string) => bus.emit('debug-cmd', { cmd: name, arg });
  $('pause').onclick = () => cmd('pause');
  $('step').onclick = () => cmd('step');
  $('reset').onclick = () => cmd('reset');
  $('replay').onclick = () => cmd('replay');
  $('openAssistant').onclick = () => void openAssistantPanel();
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-preset]')) {
    b.onclick = () => cmd('preset', b.dataset.preset);
  }
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-act]')) {
    b.onclick = () => cmd('act', b.dataset.act);
  }

  const note = (msg: string) => ($('note').textContent = msg);

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
      $('importBox').hidden = false;
      note('剪贴板不可用，已放到下面的文本框里');
    }
  };
  $('importToggle').onclick = () => ($('importBox').hidden = !$('importBox').hidden);
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
      const on = !(await win.isFullscreen());
      await win.setFullscreen(on);
      note(on ? '全屏中：Clawd 应该已经躲起来了。按 Esc 退出' : '');
    };
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') void win.setFullscreen(false).then(() => note(''));
    });
  } else {
    $('pinWrap').hidden = true;
    $('fullscreenTest').hidden = true;
  }

  // 快捷键（焦点不在输入框时）
  window.addEventListener('keydown', (e) => {
    const tag = (e.target as HTMLElement).tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
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

// 宠物头顶的对话气泡：排队、按优先级抢占、跟着宠物走、给原生侧报可点击区域。
// 谁都可以往里发：小助手的提醒、Claude Code 的权限请求……

import { T } from '../assistant/i18n';
import type { Pet } from '../engine/pet';
import type { HitRect } from '../platform/host';

const GAP_MS = 400;

export interface BubbleButton {
  label: string;
  primary?: boolean;
  run: () => void;
}

export interface BubbleItem {
  /** 同一个 key 只会有一条（再发就替换） */
  key: string;
  /** 样式：决定标题前小方块的颜色（.kind-xxx） */
  kind: string;
  title: string;
  body?: string;
  /** 等宽字体显示的一段（命令之类） */
  code?: string;
  buttons: BubbleButton[];
  /** 多少毫秒后自己收起；不写就一直等人点 */
  hideAfter?: number;
  /** 优先级高的会把正在显示的挤回队列（默认 0） */
  priority?: number;
  /** 弹出来时调用（宠物配合做动作）；被挤掉再弹回来不会再调 */
  onShow?: () => void;
  /** 点右上角 × 关掉时调用 */
  onClose?: () => void;
  /** 轮到它时还值不值得弹（比如日程已经结束了） */
  valid?: () => boolean;
}

interface Shown {
  item: BubbleItem;
  el: HTMLDivElement;
  w: number;
  h: number;
  hideAt: number | null;
}

export class Bubbles {
  private queue: BubbleItem[] = [];
  private shown: Shown | null = null;
  private nextShowAt = 0;
  /** 已经调过 onShow 的 key */
  private cued = new Set<string>();

  constructor(
    private pet: Pet,
    /** 宠物现在的包围盒（含道具），没画出来为 null */
    private anchor: () => HitRect | null,
    /** 覆盖层被隐藏（全屏免打扰、手动隐藏） */
    private hidden: () => boolean,
  ) {}

  get current(): BubbleItem | null {
    return this.shown?.item ?? null;
  }

  has(key: string): boolean {
    return this.shown?.item.key === key || this.queue.some((q) => q.key === key);
  }

  /** 发一条。front：插到同优先级的最前面 */
  post(item: BubbleItem, front = false) {
    const p = item.priority ?? 0;
    if (this.shown?.item.key === item.key) {
      this.remove(false);
      this.cued.add(item.key);
    }
    this.queue = this.queue.filter((q) => q.key !== item.key);
    // 优先级高的插队；同优先级按先来后到（front 就排同级第一个）
    const at = this.queue.findIndex((q) => (front ? (q.priority ?? 0) <= p : (q.priority ?? 0) < p));
    if (at < 0) this.queue.push(item);
    else this.queue.splice(at, 0, item);
    // 比正在显示的更急：挤掉它（放回队首，之后接着显示）
    if (this.shown && p > (this.shown.item.priority ?? 0)) {
      const back = this.shown.item;
      this.remove(false);
      this.nextShowAt = 0;
      this.post(back, true);
    }
  }

  /** 收回（正在显示的就关掉，排队的就删掉） */
  retract(pred: string | ((item: BubbleItem) => boolean)) {
    const match = typeof pred === 'string' ? (i: BubbleItem) => i.key === pred : pred;
    this.queue = this.queue.filter((q) => !match(q));
    if (this.shown && match(this.shown.item)) this.remove(true);
  }

  /** 每帧调用：摆好位置，返回可点击区域 */
  frame(now: number): HitRect | null {
    if (this.hidden()) {
      // 隐藏期间气泡先收回队列里，回来再弹
      if (this.shown) {
        const back = this.shown.item;
        this.remove(false);
        this.post(back, true);
      }
      this.pet.attentive = false;
      return null;
    }
    if (this.shown?.hideAt && now >= this.shown.hideAt) this.remove(true);
    if (!this.shown && now >= this.nextShowAt) this.showNext();
    this.pet.attentive = this.shown !== null;
    return this.place();
  }

  private showNext() {
    while (this.queue.length) {
      const item = this.queue.shift()!;
      if (item.valid && !item.valid()) continue;
      this.show(item);
      return;
    }
  }

  private show(item: BubbleItem) {
    const el = document.createElement('div');
    el.className = `bubble kind-${item.kind}`;
    const close = document.createElement('button');
    close.className = 'bubble-x';
    close.textContent = '×';
    close.title = T.close;
    close.onclick = () => {
      item.onClose?.();
      this.remove(true);
    };
    const h = document.createElement('div');
    h.className = 'bubble-title';
    h.textContent = item.title;
    el.append(close, h);
    if (item.body) {
      const b = document.createElement('div');
      b.className = 'bubble-body';
      b.textContent = item.body;
      el.append(b);
    }
    if (item.code) {
      const c = document.createElement('pre');
      c.className = 'bubble-code';
      c.textContent = item.code;
      el.append(c);
    }
    if (item.buttons.length) {
      const row = document.createElement('div');
      row.className = 'bubble-actions';
      for (const btn of item.buttons) {
        const e = document.createElement('button');
        e.textContent = btn.label;
        if (btn.primary) e.className = 'primary';
        e.onclick = () => {
          btn.run();
          this.remove(true);
        };
        row.append(e);
      }
      el.append(row);
    } else {
      // 没有按钮的（报时、完成）：点哪儿都关
      el.onclick = () => this.remove(true);
    }
    document.body.append(el);
    this.shown = {
      item,
      el,
      w: el.offsetWidth,
      h: el.offsetHeight,
      hideAt: item.hideAfter ? performance.now() + item.hideAfter : null,
    };
    // 下一帧再加 .in 才有过渡动画；页面在后台没有 rAF 时靠定时器兜底
    const enter = () => el.classList.add('in');
    requestAnimationFrame(enter);
    window.setTimeout(enter, 50);
    if (!this.cued.has(item.key)) {
      this.cued.add(item.key);
      item.onShow?.();
    }
    if (this.cued.size > 200) this.cued = new Set([item.key]);
  }

  private remove(animate: boolean) {
    const s = this.shown;
    if (!s) return;
    this.shown = null;
    this.nextShowAt = performance.now() + GAP_MS;
    if (!animate) {
      s.el.remove();
      return;
    }
    s.el.classList.remove('in');
    s.el.style.pointerEvents = 'none';
    window.setTimeout(() => s.el.remove(), 200);
  }

  /** 放在宠物头顶（放不下就放脚下），水平方向夹在屏幕里，小尾巴指着宠物 */
  private place(): HitRect | null {
    const s = this.shown;
    const a = this.anchor();
    if (!s || !a) return null;
    const W = window.innerWidth;
    const H = window.innerHeight;
    const margin = 8;
    const gap = 14;
    const cx = (a[0] + a[2]) / 2;
    const left = Math.round(Math.min(W - s.w - margin, Math.max(margin, cx - s.w / 2)));
    let top = a[1] - gap - s.h;
    const below = top < margin;
    if (below) top = Math.min(H - s.h - margin, a[3] + gap);
    top = Math.round(top);
    const tail = Math.round(Math.min(s.w - 16, Math.max(16, cx - left)));
    s.el.style.transform = `translate(${left}px, ${top}px)`;
    s.el.style.setProperty('--tail', `${tail}px`);
    s.el.classList.toggle('below', below);
    return [left, top, left + s.w, top + s.h];
  }
}

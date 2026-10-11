import { describe, expect, it } from 'vitest';
import { type Lang, TEXTS, dayLabel } from '../src/assistant/i18n';
import { STRINGS } from '../src/assistant/strings';

const LANGS: Lang[] = ['zh', 'ja', 'en'];

/** 把表里的每一项都"用起来"：字符串原样，函数用样例参数调用 */
function render(table: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(table)) {
    if (typeof v === 'string') out[k] = v;
    else if (typeof v === 'function') out[k] = String((v as (...a: unknown[]) => unknown)(5, 'Edit', 'x'));
    else out[k] = Object.values(v as Record<string, string>).join('|'); // ccMood
  }
  return out;
}

describe.each([
  ['气泡', TEXTS],
  ['小助手窗口', STRINGS],
] as const)('%s文字', (_name, tables) => {
  it('三种语言的键一一对应，每一项都有内容', () => {
    const keys = Object.keys(tables.zh).sort();
    for (const lang of LANGS) {
      expect(Object.keys(tables[lang]).sort(), lang).toEqual(keys);
      for (const [k, v] of Object.entries(render(tables[lang]))) expect(v.trim(), `${lang}.${k}`).not.toBe('');
    }
  });

  it('日文和中文版不是英文原样照搬', () => {
    const en = render(tables.en);
    for (const lang of ['zh', 'ja'] as const) {
      const t = render(tables[lang]);
      const same = Object.keys(en).filter((k) => t[k] === en[k] && /[A-Za-z]{4}/.test(en[k]));
      // 少数专有名词（Claude Code、ToDo）两边一样没问题，但不该大面积相同
      expect(same.length, `${lang}: ${same.join(', ')}`).toBeLessThan(8);
    }
  });
});

describe('日文版', () => {
  it('只有日文里该有的假名/汉字，没有混进简体中文的专用字', () => {
    const all = Object.values(render(TEXTS.ja)).join('') + Object.values(render(STRINGS.ja)).join('');
    expect(all).toMatch(/[぀-ヿ]/); // 有假名
    // 简体中文专用字（日文汉字写法不同）：不该出现
    expect(all).not.toMatch(/[这个们说为开关时间设态后点击标题图]/);
  });

  it('气泡带占位符的句子替换正确', () => {
    expect(TEXTS.ja.chimeTitle(9)).toBe('9時やで！');
    expect(TEXTS.ja.restBody(45)).toContain('45分');
    expect(TEXTS.ja.eventSoon(10)).toBe('10分後やで：');
    expect(TEXTS.ja.ccDone('プロジェクト')).toContain('プロジェクト');
    expect(TEXTS.ja.ccPermTitle('Bash')).toContain('コマンド');
    expect(TEXTS.ja.ccPermTitle('mcp__x__y')).toContain('mcp__x__y');
  });

  it('权限按钮用标准说法，不用方言（安全相关，不能有歧义）', () => {
    expect(TEXTS.ja.ccAllow).toBe('許可');
    expect(TEXTS.ja.ccDeny).toBe('拒否');
  });

  it('时间段的措辞', () => {
    expect(STRINGS.ja.ago(30)).toBe('30秒前');
    expect(STRINGS.ja.ago(120)).toBe('2分前');
    expect(STRINGS.ja.ago(7300)).toBe('2時間前');
    expect(STRINGS.ja.hour(9)).toBe('9時');
  });
});

describe('dayLabel', () => {
  const now = new Date(2026, 9, 11, 12).getTime(); // 2026-10-11 周日
  const day = (offset: number) => new Date(2026, 9, 11 + offset, 9).getTime();

  it('日文：今日 / 明日 / 昨日，其余是 月/日(曜)', () => {
    expect(dayLabel(day(0), now, 'ja')).toBe('今日');
    expect(dayLabel(day(1), now, 'ja')).toBe('明日');
    expect(dayLabel(day(-1), now, 'ja')).toBe('昨日');
    expect(dayLabel(day(2), now, 'ja')).toBe('10/13(火)');
    expect(dayLabel(day(6), now, 'ja')).toBe('10/17(土)');
  });

  it('中文和英文没变', () => {
    expect(dayLabel(day(0), now, 'zh')).toBe('今天');
    expect(dayLabel(day(2), now, 'zh')).toBe('10/13 周二');
    expect(dayLabel(day(0), now, 'en')).toBe('Today');
    expect(dayLabel(day(2), now, 'en')).toBe('Tue 10/13');
  });
});

// 拟人像素皮肤的生成工具：把按图层画的 ASCII 像素图拼成 skins/<id>/skin.json。
//
// 一个字符 = 一个精灵像素（1/3 格），'.' 是透明。每个图层就是皮肤里的一个部件：
// 工具会自动裁掉空白、换算成格子坐标、给图层描边，并输出一张放大的预览 PNG 方便检查。
// 用法见 scripts/skins/*.mjs。

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const SUB = 3;

/** 一个图层：rows 是 ASCII 像素图，(x, y) 是它左上角在整张图里的位置（像素） */
export function layer(rows, x = 0, y = 0) {
  const w = Math.max(...rows.map((r) => r.length));
  return { x, y, rows: rows.map((r) => r.padEnd(w, '.')) };
}

/** 左右镜像 */
export function flip(rows) {
  return rows.map((r) => [...r].reverse().join(''));
}

/** 只画左半边，右半边镜像出来（中线在两列之间） */
export function sym(rows) {
  const w = rows[0].length;
  rows.forEach((r, i) => {
    if (r.length !== w) throw new Error(`sym: 第 ${i} 行是 ${r.length} 个字符，应该是 ${w}`);
  });
  return rows.map((r) => r + [...r].reverse().join(''));
}

/** 给图层外面描一圈 1 像素的边（四邻域），图层向外扩 1 像素 */
export function outline(l, ch = 'K') {
  const h = l.rows.length + 2;
  const w = l.rows[0].length + 2;
  const at = (x, y) => l.rows[y - 1]?.[x - 1] ?? '.';
  const rows = [];
  for (let y = 0; y < h; y++) {
    let row = '';
    for (let x = 0; x < w; x++) {
      const c = at(x, y);
      if (c !== '.') row += c;
      else row += [at(x - 1, y), at(x + 1, y), at(x, y - 1), at(x, y + 1)].some((n) => n !== '.') ? ch : '.';
    }
    rows.push(row);
  }
  return { x: l.x - 1, y: l.y - 1, rows };
}

/** 图层里不透明像素的包围盒（整张图坐标），空图层返回 null */
function bounds(l) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  l.rows.forEach((r, y) =>
    [...r].forEach((c, x) => {
      if (c === '.') return;
      x0 = Math.min(x0, l.x + x);
      x1 = Math.max(x1, l.x + x + 1);
      y0 = Math.min(y0, l.y + y);
      y1 = Math.max(y1, l.y + y + 1);
    }),
  );
  return x0 === Infinity ? null : { x0, y0, x1, y1 };
}

/** 从图层里切出一块（整张图坐标），超出的地方透明 */
function crop(l, b) {
  const rows = [];
  for (let y = b.y0; y < b.y1; y++) {
    let row = '';
    for (let x = b.x0; x < b.x1; x++) row += l.rows[y - l.y]?.[x - l.x] ?? '.';
    rows.push(row);
  }
  return rows;
}

const cells = (px) => Math.round((px / SUB) * 10000) / 10000;

/**
 * parts: [{ id, role, art, closed?, faces?: { 表情: 图层 }, pivot?: [px, py], sway?, gaze?, anchored? }]，
 * 按绘制顺序（后面的盖住前面的）。closed、faces 的图层和 art 放在同一个坐标系里，会裁成同样大小。
 * 整张图会被平移到网格里：左右居中、脚底贴着网格底边，网格宽高取整到整格。
 */
export function build({ id, name, description, category, palette, legend, actions, laptop, parts, out, preview }) {
  const all = parts.map((p) => bounds(p.art)).filter(Boolean);
  const bx0 = Math.min(...all.map((b) => b.x0));
  const by0 = Math.min(...all.map((b) => b.y0));
  const bx1 = Math.max(...all.map((b) => b.x1));
  const by1 = Math.max(...all.map((b) => b.y1));
  const gw = Math.ceil((bx1 - bx0) / SUB);
  const gh = Math.ceil((by1 - by0) / SUB);
  // 左右多出来的像素平分；上面多出来的放在头顶，脚贴底
  const ox = Math.floor((gw * SUB - (bx1 - bx0)) / 2) - bx0;
  const oy = gh * SUB - by1;

  const defs = parts.map((p) => {
    let b = bounds(p.art);
    for (const extra of [p.closed, ...Object.values(p.faces ?? {})]) {
      const c = extra && bounds(extra);
      if (c) b = { x0: Math.min(b.x0, c.x0), y0: Math.min(b.y0, c.y0), x1: Math.max(b.x1, c.x1), y1: Math.max(b.y1, c.y1) };
    }
    const def = {
      id: p.id,
      role: p.role,
      rect: [cells(b.x0 + ox), cells(b.y0 + oy), cells(b.x1 - b.x0), cells(b.y1 - b.y0)],
      pixels: crop(p.art, b),
    };
    if (p.closed) def.closed = crop(p.closed, b);
    if (p.faces) def.faces = Object.fromEntries(Object.entries(p.faces).map(([k, l]) => [k, crop(l, b)]));
    if (p.pivot) def.pivot = [cells(p.pivot[0] + ox), cells(p.pivot[1] + oy)];
    if (p.sway) def.sway = p.sway;
    if (p.gaze !== undefined) def.gaze = p.gaze;
    if (p.anchored) def.anchored = true;
    return def;
  });

  const skin = {
    id,
    name,
    description,
    ...(category ? { category } : {}),
    grid: [gw, gh],
    render: 'pixel',
    ...(laptop ? { laptop } : {}),
    palette,
    legend,
    ...(actions ? { actions } : {}),
    parts: defs,
  };
  fs.mkdirSync(path.dirname(out), { recursive: true });
  // 数字数组（rect、pivot）压成一行；像素图一行一个字符串，JSON 里也能直接看出画的是什么
  const json = JSON.stringify(skin, null, 2).replace(/\[\s+(-?[\d.]+(?:,\s+-?[\d.]+)*)\s+\]/g, (_, nums) => `[${nums.split(/,\s+/).join(', ')}]`);
  fs.writeFileSync(out, `${json}\n`);
  if (preview) writePreview(preview, skin, gw * SUB, gh * SUB);
  return skin;
}

// ---------- 预览 PNG ----------

function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function png(w, h, rgba) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 把皮肤按静止姿势拼起来，放大 8 倍，左边浅底右边深底，看描边在两种桌面上的效果 */
function writePreview(file, skin, w, h) {
  const S = 8;
  const W = w * 2 + 4;
  const img = Buffer.alloc(W * S * h * S * 4);
  const put = (x, y, hex) => {
    const v = parseInt(hex.slice(1), 16);
    for (let j = 0; j < S; j++) {
      for (let i = 0; i < S; i++) {
        const o = ((y * S + j) * W * S + x * S + i) * 4;
        img[o] = v >> 16;
        img[o + 1] = (v >> 8) & 255;
        img[o + 2] = v & 255;
        img[o + 3] = 255;
      }
    }
  };
  for (let y = 0; y < h; y++) for (let x = 0; x < W; x++) put(x, y, x < w + 2 ? '#e8e4dc' : '#2b2d3a');
  for (const offset of [1, w + 3]) {
    for (const p of skin.parts) {
      const x0 = Math.round(p.rect[0] * SUB);
      const y0 = Math.round(p.rect[1] * SUB);
      p.pixels.forEach((r, y) =>
        [...r].forEach((c, x) => {
          if (c !== '.') put(offset + x0 + x, y0 + y, skin.palette[skin.legend[c]]);
        }),
      );
    }
  }
  fs.writeFileSync(file, png(W * S, h * S, img));
}

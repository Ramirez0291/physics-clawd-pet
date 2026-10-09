// 把皮肤的静止姿态栅格化成 1024×1024 PNG，供 `tauri icon` 生成各尺寸图标。
// 用法: node scripts/make-icon.mjs [skins/clawd/skin.json] [app-icon.png]
import { readFileSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const skinPath = process.argv[2] ?? 'skins/clawd/skin.json';
const outPath = process.argv[3] ?? 'app-icon.png';
const skin = JSON.parse(readFileSync(skinPath, 'utf8'));

const SIZE = 1024;
const [gw, gh] = skin.grid;
const unit = Math.floor((SIZE * 0.9) / Math.max(gw, gh));
const ox = Math.floor((SIZE - gw * unit) / 2);
const oy = Math.floor((SIZE - gh * unit) / 2);

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const pixels = Buffer.alloc(SIZE * SIZE * 4);
for (const part of skin.parts) {
  const [r, g, b] = hex(skin.palette[part.color]);
  const [px, py, pw, ph] = part.rect;
  for (let y = oy + py * unit; y < oy + (py + ph) * unit; y++) {
    for (let x = ox + px * unit; x < ox + (px + pw) * unit; x++) {
      const i = (y * SIZE + x) * 4;
      pixels[i] = r;
      pixels[i + 1] = g;
      pixels[i + 2] = b;
      pixels[i + 3] = 255;
    }
  }
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0; // filter: none
  pixels.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw)),
  chunk('IEND', Buffer.alloc(0)),
]);
writeFileSync(outPath, png);
console.log(`wrote ${outPath}`);

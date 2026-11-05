// 原画贴图骨骼。源坐标按 character.png 标定，40 个源像素 = 一格。
// node scripts/skins/miss-claude.mjs 重新生成配置；原画不做低分辨率重绘。
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ORIGIN = [238, 154];
const UNIT = 40;
const cells = (n) => Math.round(n / UNIT * 100000) / 100000;
const point = ([x, y]) => [cells(x - ORIGIN[0]), cells(y - ORIGIN[1])];
const rect = ([x, y, w, h]) => [...point([x, y]), cells(w), cells(h)];

const ahoge = [[401,249],[428,216],[456,192],[488,170],[574,170],[611,189],[631,223],[632,283],[614,320],[581,318],[592,277],[585,241],[565,234],[511,234],[476,257],[462,285],[481,307],[457,319],[414,303],[397,280]];
const eyeL = [[449,548],[463,533],[481,524],[521,526],[540,539],[545,561],[540,610],[487,619],[466,604],[456,582]];
const eyeR = [[633,546],[646,529],[692,524],[714,535],[727,555],[721,610],[677,619],[649,608],[636,587]];
const armL = [[529,694],[553,694],[554,710],[548,718],[550,731],[554,738],[550,752],[541,764],[533,783],[521,799],[512,819],[509,840],[506,861],[504,881],[490,900],[470,902],[453,890],[448,879],[432,875],[415,864],[409,847],[414,830],[439,819],[462,802],[485,788],[500,767],[510,744],[516,721],[518,701]];
const armR = [[632,694],[654,697],[658,712],[662,729],[675,747],[681,764],[693,781],[709,796],[727,807],[736,821],[755,829],[763,843],[760,860],[748,871],[728,878],[720,893],[706,904],[688,901],[672,889],[667,869],[666,854],[655,837],[650,817],[641,800],[631,777],[625,758],[622,744],[626,731],[633,721],[630,712]];
const legL = [[513,1019],[584,1019],[586,1122],[571,1154],[532,1153],[515,1131]];
const legR = [[594,1019],[668,1019],[669,1126],[651,1154],[608,1154],[592,1132]];

const part = (id, role, crop, polygon, extra = {}) => ({
  id, role, rect: rect(crop),
  image: { src: 'character.png', crop, ...(polygon ? { polygon } : {}) },
  ...extra,
});
// 新动作图集严格为 4×4；裁片保留源图 alpha，不需要去纸色。
const cell = (col, row) => {
  const x = Math.floor(col * 1246 / 4), y = Math.floor(row * 1262 / 4);
  const bottom = row === 2 ? 930 : Math.floor((row + 1) * 1262 / 4);
  return [x, y, Math.floor((col + 1) * 1246 / 4) - x, bottom - y];
};
const atlas = (cells, height, fps = 2, directional = false) => ({
  src: 'motion-atlas.png', height, fps, directional, facing: 1,
  frames: cells.map(([x, y]) => ({ crop: cell(x, y) })),
});
const windows = (cells, height, fps = 2, extra = {}) => ({
  src: 'window-play.png', height, fps,
  frames: cells.map(([x, y]) => ({ crop: [x * 362, y * 362, 362, 362] })),
  ...extra,
});
const skin = {
  id: 'miss-claude',
  name: 'miss.claude',
  category: 'humanoid',
  windowPlay: true,
  description: '按橘发菊花纹参考图制作的原画贴图：白色环状呆毛、橘色长卷发、菊花与黑缎带、米白橘边菊花纹裙装。',
  grid: [17, 25],
  render: 'sprite',
  laptop: 'lap',
  palette: { body: '#f39360', skin: '#fce6d6', outline: '#35221c' },
  actions: ['laptop', 'read', 'write', 'think', 'stocks', 'coin', 'perch', 'peek', 'hop'],
  motions: {
    walk: atlas([[0,0],[1,0],[2,0],[3,0]], 0.98, 8, true),
    love: atlas([[0,1],[1,1]], 1, 1.3),
    read: atlas([[2,1],[3,1]], 0.82, 0.7),
    write: atlas([[0,2],[1,2]], 0.82, 3),
    think: atlas([[2,2],[3,2]], 0.98, 0.7),
    held: atlas([[0,3]], 0.94),
    air: atlas([[0,3]], 0.94),
    roll: atlas([[1,3]], 0.78),
    land: atlas([[2,3]], 0.82),
    hero: atlas([[2,3]], 0.82),
    splat: atlas([[3,3]], 0.55),
    cling: { src: 'motions.png', frames: [{ crop: [820,714,117,81], matte: 'paper' }], height: 0.67, directional: true, facing: -1 },
    stretch: { src: 'stretch.png', frames: [0,1,2,3].map((i) => ({ crop: [i * 543, 0, 543, 724] })), height: 0.98, fps: 1.25, loop: false },
    perch: windows([[0,0],[1,0]], 0.88, 2.2, { anchorY: 0.82 }),
    peek: windows([[2,0],[3,0]], 0.78, 1.2, { directional: true, facing: 1 }),
    balance: windows([[0,1],[1,1]], 0.98, 2.5),
    stumble: windows([[2,1],[3,1]], 0.98, 2.5, { loop: false }),
    hop: windows([[0,2]], 0.74),
    windowLeap: windows([[1,2]], 0.84),
    windowLand: windows([[2,2]], 0.98),
    windowDrop: windows([[3,2]], 0.92),
  },
  parts: [
    part('legL', 'leg', [509,1018,77,136], legL),
    part('legR', 'leg', [591,1018,80,136], legR),
    {
      ...part('body', 'body', [258,280,640,764]),
      image: {
        src: 'character.png', crop: [258,280,640,764],
        cutouts: [ahoge, eyeL, eyeR, legL, legR],
        cutoutImages: [
          { crop: [405,690,154,216], polygon: armL, matte: 'light' },
          { crop: [618,690,150,216], polygon: armR, matte: 'light' },
        ],
        fills: [
          { polygon: eyeL, color: '#fce7d9' },
          { polygon: eyeR, color: '#fce7d9' },
          { polygon: armL, color: '#bd6748', sample: [325,710,140,190] },
          { polygon: armR, color: '#bd6748', sample: [735,710,140,190] },
          { polygon: [[447,843],[508,826],[508,886],[488,903],[457,891]], color: '#38312f' },
          { polygon: [[662,826],[734,844],[720,898],[690,903],[670,884]], color: '#38312f' },
          { polygon: [[522,725],[550,732],[549,771],[515,799],[504,782]], color: '#fff1e1' },
          { polygon: [[632,725],[652,737],[669,785],[652,798],[628,771]], color: '#fff1e1' },
        ],
      },
    },
    part('ahoge', 'body', [395,170,240,152], ahoge, { pivot: point([595,308]), sway: { amp: 2, speed: 0.5 } }),
    { ...part('armL', 'arm', [405,690,154,216], armL, { pivot: point([539,712]) }), image: { src: 'character.png', crop: [405,690,154,216], polygon: armL, matte: 'light' } },
    { ...part('armR', 'arm', [618,690,150,216], armR, { pivot: point([645,712]) }), image: { src: 'character.png', crop: [618,690,150,216], polygon: armR, matte: 'light' } },
    part('eyeL', 'eye', [445,524,102,95], eyeL, { gaze: 0.08 }),
    part('eyeR', 'eye', [631,524,100,95], eyeR, { gaze: 0.08 }),
  ],
};
const out = fileURLToPath(new URL('../../skins/miss-claude/skin.json', import.meta.url));
fs.writeFileSync(out, `${JSON.stringify(skin, null, 2)}\n`);
console.log('Generated skins/miss-claude/skin.json (original-art sprite rig)');

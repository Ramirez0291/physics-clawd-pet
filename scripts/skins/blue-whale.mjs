import fs from 'node:fs';

const src = 'reference.png';
const unit = 0.62;

// 校准用原图坐标。接触点通常在脚底，晃腿时在臀部。采样间距按每帧的头部大小定标。
function frame(crop, contact, sampleStep, hole, polygon) {
  return {
    crop,
    matte: 'paper-outline',
    sampleStep,
    registration: [...contact, unit],
    ...(hole ? { paperHoles: [hole] } : {}),
    ...(polygon ? { polygon } : {}),
  };
}

const neutral = frame([343, 204, 78, 92], [382, 296], 2.45, [363, 210, 20, 11]);
const walk = [
  frame([640, 50, 66, 89], [669, 136], 2.3, [656, 55, 13, 8]),
  frame([706, 50, 66, 89], [733, 136], 2.3, [720, 55, 14, 8]),
  frame([772, 50, 63, 89], [799, 135], 2.3, [785, 54, 14, 8]),
  frame([835, 50, 68, 89], [864, 136], 2.3, [849, 55, 15, 8]),
];
const love = frame([545, 874, 94, 102], [595, 971], 2.45, [577, 893, 17, 8]);
const book = frame([1230, 370, 95, 96], [1269, 463], 2.55, [1252, 376, 19, 11]);
const laptop = frame([1062, 883, 98, 94], [1102, 969], 2.35, [1084, 893, 19, 10]);
const think = frame([1128, 373, 89, 94], [1163, 461], 2.5, [1146, 380, 19, 10],
  [[1128, 373], [1186, 373], [1191, 391], [1217, 401], [1217, 467], [1128, 467]]);
const held = frame([453, 723, 99, 80], [494, 801], 2.4, [484, 729, 17, 9],
  [[453, 723], [508, 723], [509, 741], [515, 752], [527, 764], [550, 768], [552, 803], [453, 803]]);
const jump = frame([1010, 529, 93, 99], [1051, 626], 2.33, [1035, 535, 18, 10]);
const tumble = frame([1220, 737, 101, 63], [1269, 799], 2.35, [1231, 751, 13, 12],
  [[1220, 737], [1264, 737], [1270, 742], [1298, 743], [1321, 746], [1321, 800], [1220, 800]]);
const crouch = frame([578, 706, 98, 94], [626, 797], 2.35, [612, 725, 16, 10]);
const prone = frame([544, 386, 116, 78], [584, 459], 2.4, [565, 394, 19, 12]);
const stretch = frame([901, 366, 96, 101], [948, 463], 2.4, [920, 371, 19, 13],
  [[901, 366], [962, 366], [966, 394], [997, 400], [997, 467], [901, 467]]);
const sit = frame([339, 372, 86, 96], [379, 454], 2.45, [366, 381, 15, 8]);
const swing = frame([432, 370, 102, 98], [482, 448], 2.45, [467, 375, 19, 11]);
const peek = frame([841, 719, 102, 79], [875, 793], 2.33, [861, 725, 17, 8],
  [[841, 719], [943, 719], [943, 788], [917, 788], [905, 791], [888, 791], [888, 793], [847, 793], [847, 789], [841, 789]]);
const surprised = frame([730, 201, 85, 96], [770, 294], 2.45, [751, 205, 20, 13],
  [[730, 201], [785, 201], [789, 221], [815, 229], [815, 297], [730, 297]]);
const cheer = frame([890, 540, 115, 103], [943, 643], 2.4, [933, 559, 18, 10]);

const motion = (frames, extra = {}) => ({ src, height: 1, frames, ...extra });
const facingLeft = { directional: true, facing: -1 };
const { registration: [cx], ...idleImage } = neutral;
const width = Math.round(idleImage.crop[2] / idleImage.sampleStep);
const height = Math.round(idleImage.crop[3] / idleImage.sampleStep);
const idleX = 10 - (cx - idleImage.crop[0]) * width / idleImage.crop[2] * unit;
const skin = {
  id: 'blue-whale',
  name: '蓝色大肥鱼',
  category: 'humanoid',
  description: '深海女仆鲸鱼娘的原图像素帧，保留蓝色长发、环形呆毛、白色女仆头饰、鳍耳、围裙与鲸尾。',
  grid: [20, 24],
  render: 'sprite',
  windowPlay: true,
  palette: { body: '#475eaa' },
  actions: ['laptop', 'read', 'think', 'perch', 'peek', 'hop'],
  parts: [{ id: 'body', role: 'body', rect: [idleX, 24 - height * unit, width * unit, height * unit], image: { src, ...idleImage } }],
  motions: {
    walk: motion(walk, { ...facingLeft, fps: 6 }),
    love: motion([love]),
    read: motion([book]),
    laptop: motion([laptop]),
    think: motion([think]),
    held: motion([held], facingLeft),
    air: motion([jump]),
    roll: motion([tumble]),
    land: motion([crouch]),
    hero: motion([crouch]),
    splat: motion([prone]),
    cling: motion(walk, { ...facingLeft, fps: 3 }),
    stretch: motion([neutral, stretch, stretch, neutral], { fps: 1.25, loop: false }),
    perch: motion([sit, swing], { fps: 2 }),
    peek: motion([peek], facingLeft),
    balance: motion([stretch], { directional: true, facing: 1 }),
    stumble: motion([surprised, crouch], { fps: 2.5, loop: false }),
    hop: motion([crouch]),
    windowLeap: motion([jump]),
    windowLand: motion([cheer]),
    windowDrop: motion([surprised, jump], { fps: 2.6, loop: false }),
  },
};

const out = new URL('../../skins/blue-whale/skin.json', import.meta.url);
fs.writeFileSync(out, JSON.stringify(skin, null, 2) + '\n');

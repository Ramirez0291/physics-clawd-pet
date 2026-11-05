// DeepSeek 娘（鲸鱼女仆）像素小人：node scripts/skins/deepseek.mjs [预览.png]
// 按 Gemini 生成的 Q 版像素设定图（约 49×50 像素）逐格描下来，再拆成能动的部件。
// 一个字符 = 一个精灵像素；坐标是整张图的像素坐标，左右对称轴在 x = 23（第 22、23 列之间）。

import { build, flip, layer, outline, sym } from '../pixel-skin.mjs';

const palette = {
  outline: '#0b1043',
  hair: '#1e2a5c',
  hairMid: '#2c4a86',
  hairLight: '#417fba',
  hairTip: '#6ccff4',
  skin: '#fde2d3',
  skinShade: '#f0c0b2',
  blush: '#f2a1a3',
  white: '#fcfdfe',
  whiteShade: '#b9c2db',
  dress: '#1c2554',
  sleeveShine: '#3a4f96',
  eye: '#13205a',
  eyeShine: '#ffffff',
  eyeLow: '#3d6fc0',
  bow: '#14152c',
  gem: '#4aa3ff',
  ribbon: '#7cc6f6',
  ribbonDark: '#3f86d0',
  tail: '#1f2c66',
  tailLight: '#3d5bb0',
  belly: '#c3c8e2',
  shoe: '#141a48',
  shoeShine: '#4c5ea8',
  whale: '#3d6fd0',
  mouth: '#b65a63',
  mouthSoft: '#d98a8e',
  mouthInner: '#ef8f98',
};
const legend = {
  K: 'outline',
  H: 'hair',
  h: 'hairMid',
  l: 'hairLight',
  L: 'hairTip',
  S: 'skin',
  s: 'skinShade',
  R: 'blush',
  W: 'white',
  w: 'whiteShade',
  N: 'dress',
  n: 'sleeveShine',
  e: 'eye',
  o: 'eyeShine',
  E: 'eyeLow',
  X: 'bow',
  G: 'gem',
  b: 'ribbon',
  B: 'ribbonDark',
  T: 'tail',
  t: 'tailLight',
  U: 'belly',
  O: 'shoe',
  P: 'shoeShine',
  V: 'whale',
  M: 'mouth',
  m: 'mouthSoft',
  r: 'mouthInner',
};

// 背后的长发：深蓝，往下渐变成亮浅蓝的卷发梢
const hairBack = outline(
  layer(
    sym([
      '.............HHHHHHHHHH',
      '............HHHHHHHHHHH',
      '............HHHHHHHHHHH',
      '...........HHHHHHHHHHHH',
      '...........HHHHHHHHHHHH',
      '..........HHHHHHHHHHHHH',
      '..........HHhHHHHHHHHHH',
      '..........HhHHHHHHHHHHH',
      '..........HhHHHHHHHHHHH',
      '.........HHhHHHHHHHHHHH',
      '.........HhHHhHHHHHHHHH',
      '.........HhHHhHHHHHHHHH',
      '........HHhHhhHHHHHHHHH',
      '........HhHHhHHHHHHHHHH',
      '........HhhHhHHHHHHHHHH',
      '........hHhhHhHHHHHHHHH',
      '........hhHlhhHHHHHHHHH',
      '.......hlhhlhHHHHHHHHHH',
      '.......lhlLlhhHHHHHHHHH',
      '.......lLlLLlhHHHHHHHHH',
      '.......LlLLlLlhHHHHHHHH',
      '.......LLlLLLLlhHHHHHHH',
      '......LLLLlLLLLlHHHHHHH',
      '......L.LLLLL.LLhHHHHHH',
      '.........LL.L..LLhHHHHH',
      '...............LLlhHHHH',
      '................LLhHHHH',
    ]),
    0,
    9,
  ),
);

// 鲸鱼尾巴：从裙子右后方拖到地上，尾鳍朝右上翘，肚子是浅色的
const tail = outline(
  layer(
    [
      '...........T...TT',
      '...........TT.TTT',
      '............TTTT.',
      '............TtT..',
      '...........TtT...',
      '..........TtTT...',
      'TTT......TtTT....',
      'TTTT....TtTTT....',
      'TTTTTTTTtTTTU....',
      '.TTTTTTTTTTUU....',
      '..UUTTTTTUUU.....',
      '....UUUUUU.......',
    ],
    31,
    34,
  ),
);

// 鲸鱼鳍耳朵：从鬓发下面往两边伸出来，下面一道白
const EAR = ['.....HHH', '...HHHHH', '.HHHHHHH', 'HHHHHhHH', '.WWWWHHH', '...WW...'];
const earL = outline(layer(EAR, 6, 15));
const earR = outline(layer(flip(EAR), 32, 15));

// 腿：膝盖、白色花边袜、玛丽珍鞋
const LEG = ['SSSs', 'SSSs', 'wWWw', 'WWWw', 'WWWw', 'OPOO', 'OOOO', 'OOOO'];
const legL = outline(layer(LEG, 18, 39));
const legR = outline(layer(flip(LEG), 24, 39));

// 女仆裙：白领子、黑蝴蝶结配蓝宝石、白围裙、藏青短裙、白衬裙花边
const dress = outline(
  layer(
    sym([
      '..................WWWXX',
      '.................NWWXXX',
      '.................NNWXXG',
      '.................NNNXXX',
      '................NNNNWWW',
      '................NNNWWWW',
      '................NNWWWWW',
      '................NWWWWWW',
      '...............NNWWWWWW',
      '..............NNNWWWWWW',
      '.............NNNNwWWWWW',
      '............NNNNNwWWWWW',
      '............NNNNNNwwWwW',
      '...........NNNNNNNNNNNN',
      '...........WwWwWwWwWwWw',
      '............W.W.W.W.W.W',
    ]),
    0,
    23,
  ),
);
// 围裙上的小鲸鱼刺绣（不对称，单独画）
const whale = layer(['...V.', 'VVVVV', '.VVV.'], 22, 30);

// 手臂：泡泡短袖、白袖口、往外斜着垂下来的小胳膊，关节在肩膀
const ARM = ['...NNN', '..NnNN', '..WWWN', '..SSS.', '.SSS..', '.SSs..', 'SSs...', 'Ss....'];
const armL = outline(layer(ARM, 13, 25));
const armR = outline(layer(flip(ARM), 27, 25));

// 头：头顶、刘海（中间一绺垂到眉间）、两侧鬓发、小小的脸
const head = outline(
  layer(
    sym([
      '...............HHHHHHHH',
      '.............HHHHHHHHHH',
      '............HHHhhHHHHHH',
      '............HhhhHHhhhHH',
      '...........HHhllhHHlhhH',
      '...........HhHHhhHHHhHH',
      '...........HhHHHhHHHHHH',
      '...........HhhHHHHSHHHH',
      '...........HhhHHSSSSHHH',
      '...........HhhHHSSSSSSH',
      '...........HhhHHSSSSSSS',
      '...........HhhHHSSSSSSS',
      '...........HlhHHRRSSSSS',
      '............lhHHSSSSSSS',
      '............llH..sSSSSS',
      '.............lL....ssss',
      '.............L.........',
    ]),
    0,
    8,
  ),
);

// 女仆头饰：白色荷叶边弯过头顶，两头扎着浅蓝蝴蝶结
const headdress = outline(
  layer(
    sym([
      '..................WW.WW',
      '................WWWWWWW',
      '..............WWWwWWwWW',
      '.............WWwWWwwwww',
      '...........bbWwwb......',
      '..........bbbWbbb......',
      '..........bbbBbbb......',
      '..........bbb.bbb......',
      '...........B...B.......',
    ]),
    -1,
    4,
  ),
);

// 呆毛：头顶一根卷起来的头发（细线，不再自动描边）
const ahoge = layer(['.KKK..', 'KhhhK.', 'Kh.KhK', 'Kh..K.', '.KhK..', '..Kh..'], 20, -1);

// 表情：眼睛 4×5、嘴巴 4×4 的格子，每种表情一张图（参考设定图的表情栏）
const eyeL = (rows) => layer(rows, 17, 16);
const eyeR = (rows) => layer(rows, 25, 16);
const mouthAt = (rows) => layer(rows, 21, 20);

// 平时：深蓝豆豆眼，左上一点高光、下面一点浅蓝
const EYE = ['....', '.oe.', '.ee.', '.EE.', '....'];
const SHUT = ['....', '....', '.ee.', '....', '....'];
const EYE_FACES = {
  happy: [['....', '.ee.', 'e..e', '....', '....']],
  surprised: [['.ee.', 'eWWe', 'eWWe', '.ee.', '....']],
  wince: [
    ['....', 'ee..', '..ee', 'ee..', '....'],
    ['....', '..ee', 'ee..', '..ee', '....'],
  ],
  cry: [
    ['....', '.oe.', '.ee.', '.EE.', '.b..'],
    ['....', '.oe.', '.ee.', '.EE.', '..b.'],
  ],
  smug: [
    ['....', 'eee.', '.Ee.', '....', '....'],
    ['....', '.eee', '.eE.', '....', '....'],
  ],
  yawn: [
    ['....', '....', 'eee.', '....', '....'],
    ['....', '....', '.eee', '....', '....'],
  ],
};
const eyeFaces = (side) =>
  Object.fromEntries(Object.entries(EYE_FACES).map(([k, v]) => [k, (side ? eyeR : eyeL)(v[side] ?? v[0])]));

// 嘴：平时是下巴上淡淡的一道小弧，跟着表情变
const MOUTH = ['....', '....', '.mm.', '....'];
const MOUTH_FACES = {
  focus: ['....', '....', 'mMMm', '....'],
  happy: ['....', 'MrrM', '.MM.', '....'],
  surprised: ['....', '.MM.', '.MM.', '....'],
  wince: ['....', '.MM.', 'M..M', '....'],
  cry: ['....', '.MM.', 'M..M', '....'],
  smug: ['....', '...M', '.MM.', '....'],
  eat: ['....', 'MMMM', 'MrrM', '.MM.'],
  yawn: ['....', '.MM.', 'MrrM', '.MM.'],
};
const mouthFaces = Object.fromEntries(Object.entries(MOUTH_FACES).map(([k, v]) => [k, mouthAt(v)]));

const out = new URL('../../skins/deepseek/skin.json', import.meta.url);
build({
  id: 'deepseek',
  name: 'DeepSeek-chan',
  category: 'humanoid',
  description: 'DeepSeek 拟人鲸鱼女仆，像素小人（同人皮肤，非官方）',
  palette,
  legend,
  laptop: 'lap',
  out: out.pathname.replace(/^\/(\w:)/, '$1'),
  preview: process.argv[2],
  parts: [
    { id: 'hairBack', role: 'body', art: hairBack },
    // 尾巴拖在地上：坐下、呼吸的时候都不跟着身子动
    { id: 'tail', role: 'body', art: tail, pivot: [33, 43], sway: { amp: 8, speed: 0.6 }, anchored: true },
    // 耳朵藏在鬓发后面，露出外面的一截
    { id: 'earL', role: 'body', art: earL, pivot: [13.5, 17.5], sway: { amp: 6, speed: 0.4 } },
    { id: 'earR', role: 'body', art: earR, pivot: [32.5, 17.5], sway: { amp: 6, speed: 0.4, phase: 0.5 } },
    { id: 'legL', role: 'leg', art: legL },
    { id: 'legR', role: 'leg', art: legR },
    { id: 'dress', role: 'body', art: dress },
    { id: 'whale', role: 'body', art: whale },
    { id: 'head', role: 'body', art: head },
    { id: 'headdress', role: 'body', art: headdress },
    // 手臂画在头上面：垂着的时候碰不到头，举起来时手才不会藏到头发后面
    { id: 'armL', role: 'arm', art: armL, pivot: [17.5, 26] },
    { id: 'armR', role: 'arm', art: armR, pivot: [28.5, 26] },
    { id: 'ahoge', role: 'body', art: ahoge, pivot: [22.5, 5], sway: { amp: 12, speed: 0.7 } },
    { id: 'mouth', role: 'body', art: mouthAt(MOUTH), faces: mouthFaces },
    { id: 'eyeL', role: 'eye', art: eyeL(EYE), closed: eyeL(SHUT), faces: eyeFaces(0), gaze: 0.34 },
    { id: 'eyeR', role: 'eye', art: eyeR(EYE), closed: eyeR(SHUT), faces: eyeFaces(1), gaze: 0.34 },
  ],
});

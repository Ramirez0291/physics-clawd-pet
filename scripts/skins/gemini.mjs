import fs from 'node:fs';

const core = 'core.png';
const physics = 'physics.png';
const expressions = 'expressions.png';
const faces = 'faces.png';
const unit = 0.071;
const grid = [22, 25];

// 接触点取鞋底、蹲姿底边或坐姿臀部。按头部大小微调比例，发尾和特效不参与定标。
function frame(src, [left, top, right, bottom], x, y, scale = 1, polygon) {
  return {
    src,
    crop: [left, top, right - left, bottom - top],
    registration: [x, y, unit * scale],
    ...(polygon ? { polygon } : {}),
  };
}

const stand = frame(core, [44, 10, 324, 350], 186, 350);
const blink = frame(core, [407, 10, 687, 352], 549, 350);
const shy = frame(core, [774, 10, 1043, 352], 909, 350);
const proud = frame(core, [1123, 8, 1399, 352], 1269, 350);
const walk = [
  frame(core, [80, 373, 325, 713], 167, 711),
  frame(core, [447, 373, 684, 714], 535, 712),
  frame(core, [802, 373, 1036, 713], 892, 711),
  frame(core, [1164, 373, 1396, 713], 1258, 711),
];
const walkRight = [
  frame(expressions, [37, 4, 311, 355], 203, 353, 0.98),
  frame(expressions, [403, 4, 663, 354], 565, 352, 0.98),
  frame(expressions, [765, 4, 1022, 355], 928, 353, 0.98),
  frame(expressions, [1128, 4, 1386, 353], 1290, 351, 0.98),
];
const book = frame(core, [34, 743, 334, 1058], 185, 1056);
const bookTurn = frame(expressions, [36, 377, 337, 705], 183, 703, 0.94);
const write = frame(core, [398, 741, 695, 1058], 546, 1056);
const writePause = frame(expressions, [402, 375, 700, 704], 550, 702, 0.94);
const laptop = frame(core, [760, 742, 1058, 1058], 906, 1056);
const laptopTap = frame(expressions, [751, 376, 1060, 700], 903, 698, 0.95);
const think = frame(core, [1119, 737, 1417, 1058], 1266, 1056);
const thinkSmile = frame(expressions, [1123, 375, 1422, 700], 1268, 698, 0.95);
const stockWin = frame(expressions, [1115, 738, 1424, 1076], 1266, 1074, 0.94);
const coin = frame(expressions, [756, 736, 1062, 1077], 908, 1075, 0.94);
const star = frame(expressions, [389, 728, 691, 1083], 542, 1081, 0.96);
const lookLeft = frame(faces, [84, 6, 409, 429], 248, 427, 0.806);
const lookRight = frame(faces, [501, 6, 826, 429], 665, 427, 0.806);
const delighted = frame(faces, [942, 6, 1270, 429], 1107, 427, 0.806);
const pout = frame(faces, [1385, 6, 1711, 429], 1550, 427, 0.806);
const wince = frame(faces, [79, 451, 408, 873], 248, 871, 0.806);
const startle = frame(faces, [500, 449, 826, 873], 663, 871, 0.806);
const glare = frame(faces, [941, 449, 1271, 873], 1107, 871, 0.806);
const wink = frame(faces, [1385, 449, 1717, 873], 1551, 871, 0.806);

const sit = frame(physics, [46, 8, 330, 354], 186, 257);
const swing = frame(physics, [409, 8, 692, 345], 553, 257);
const peek = frame(physics, [753, 89, 1050, 348], 890, 346);
const balance = frame(physics, [1111, 4, 1417, 351], 1268, 349);
const crouch = frame(physics, [45, 406, 345, 677], 173, 675);
const leap = frame(physics, [381, 362, 715, 652], 517, 650);
const victory = frame(physics, [746, 370, 1045, 701], 892, 699);
const drop = frame(physics, [1097, 378, 1424, 664], 1261, 662);
const stretch = frame(physics, [45, 723, 324, 1078], 184, 1076);
const held = frame(physics, [409, 753, 690, 1059], 532, 1057, 1,
  [[409, 753], [527, 753], [540, 764], [567, 771], [690, 753], [690, 1059], [409, 1059]]);
const roll = frame(physics, [750, 769, 1041, 1030], 894, 1028, 0.95);
const splat = frame(physics, [1075, 855, 1439, 1055], 1236, 1053);

function motion(frames, options = {}) {
  const src = frames[0].src;
  return {
    src, height: 1, ...options,
    frames: frames.map(({ src: frameSrc, ...region }) => frameSrc === src ? region : { ...region, src: frameSrc }),
  };
}

const left = { directional: true, facing: -1 };
const right = { directional: true, facing: 1 };
const once = { loop: false };
const { registration: [center, floor], ...body } = stand;
const [x, y, w, h] = body.crop;

const skin = {
  id: 'gemini',
  name: 'Gemini',
  category: 'humanoid',
  description: '蓝紫长卷发、粉金异色瞳、猫耳和四角星发饰。害羞时会抱臂别开脸，跳窗落地会得意地比个 V。',
  windowPlay: true,
  grid,
  render: 'sprite',
  laptop: 'lap',
  palette: { body: '#8373ce' },
  actions: ['laptop', 'read', 'write', 'think', 'stocks', 'coin', 'perch', 'peek', 'hop'],
  parts: [{
    id: 'body', role: 'body', image: body,
    rect: [grid[0] / 2 - (center - x) * unit, grid[1] - (floor - y) * unit, w * unit, h * unit],
  }],
  motions: {
    blink: motion([blink]),
    glanceLeft: motion([lookLeft]),
    glanceRight: motion([lookRight]),
    wince: motion([wince]),
    walk: motion(walk, { ...left, fps: 5.5 }),
    walkRight: motion(walkRight, { ...right, fps: 5.5 }),
    cling: motion(walk, { ...left, fps: 4 }),
    clingRight: motion(walkRight, { ...right, fps: 4 }),
    love: motion([shy, shy, delighted, proud, pout, proud], { fps: 5, ...once }),
    celebrate: motion([wink, star], { fps: 5, ...once }),
    read: motion([book, book, bookTurn], { fps: 1.25 }),
    write: motion([write, writePause], { fps: 1.7 }),
    laptop: motion([laptop, laptopTap], { fps: 2 }),
    stockWin: motion([stockWin]),
    coin: motion([coin]),
    think: motion([think, think, thinkSmile], { fps: 1 }),
    held: motion([held]),
    air: motion([drop]),
    roll: motion([roll]),
    land: motion([crouch, wince], { fps: 4, ...once }),
    hero: motion([crouch, victory], { fps: 5, ...once }),
    splat: motion([splat]),
    stretch: motion([stand, stretch, stretch, stand], { fps: 1.25, ...once }),
    perch: motion([sit, swing], { fps: 1.8 }),
    peek: motion([peek], left),
    balance: motion([balance]),
    stumble: motion([startle, crouch, glare], { fps: 5, ...once }),
    hop: motion([crouch]),
    windowLeap: motion([leap], left),
    windowLand: motion([victory, wink], { fps: 2, ...once }),
    windowDrop: motion([startle, drop], { fps: 5, ...once }),
  },
};

fs.writeFileSync(new URL('../../skins/gemini/skin.json', import.meta.url), JSON.stringify(skin, null, 2) + '\n');

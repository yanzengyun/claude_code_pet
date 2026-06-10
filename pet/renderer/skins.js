'use strict';
/*
 * skins.js — 像素风皮肤（squirtle 小蓝龟，26×24 精细版）。
 * 只画左半边（13 列），程序镜像成 26 列 → 绝对对称；
 * 字符画 → box-shadow 像素网格；每个状态一帧表情差分，
 * 显示/动画由 skin-squirtle.css 按 #pet 的 data-state 驱动，状态机零改动。
 */

const SQUIRTLE_PX = 4; // 每像素边长 px（26×4=104 宽，和 Claude 小人同体格）

// 调色板：自绘配色，. = 透明
const SQUIRTLE_PALETTE = {
  D: '#1f4e6b', // 描边深蓝
  B: '#56c2e8', // 身体蓝
  L: '#9ce0f7', // 头顶高光
  W: '#ffffff', // 眼白
  K: '#1c1c1c', // 瞳孔/嘴
  P: '#f49a8c', // 腮红
  S: '#8a4a22', // 壳沿深棕
  R: '#cd8a4e', // 壳棕
  C: '#f6e8c8', // 肚皮奶油
};

// 左半 13 列 × 24 行；行尾省略的列视为透明（自动补 .）
// 共用身体，仅 5-10 行（眼睛/嘴）做表情差分
const SQUIRTLE_HALF = {
  open: [ // 平时/工作：大圆眼
    '........DDDDD',
    '......DDBBBBB',
    '.....DBBLLBBB',
    '....DBBLLBBBB',
    '...DBBLBBBBBB',
    '...DBBWWWWBBB',
    '...DBBWKKWBBB',
    '...DBBWKKWBBB',
    '...DBBBBBBBBB',
    '...DBPPBBBBBK',
    '....DBBBBBBBB',
    '.....DBBBBBBB',
    '....DDBBBBBBB',
    '....DSSSSSSSS',
    '.DBBDSRCCCCCC',
    '.DBBDSRCCCCCC',
    '.DBBDSRCCCCCC',
    '..DDDSRCCCCCC',
    '....DSRCCCCCC',
    '....DSSRRRRRR',
    '.....DDSSSSSS',
    '......DBBBD..',
    '......DBBBD..',
    '.......DDD...',
  ],
  closed: [ // 打盹/离线：眯眼线
    '........DDDDD',
    '......DDBBBBB',
    '.....DBBLLBBB',
    '....DBBLLBBBB',
    '...DBBLBBBBBB',
    '...DBBBBBBBBB',
    '...DBBKKKKBBB',
    '...DBBBBBBBBB',
    '...DBBBBBBBBB',
    '...DBPPBBBBBK',
    '....DBBBBBBBB',
    '.....DBBBBBBB',
    '....DDBBBBBBB',
    '....DSSSSSSSS',
    '.DBBDSRCCCCCC',
    '.DBBDSRCCCCCC',
    '.DBBDSRCCCCCC',
    '..DDDSRCCCCCC',
    '....DSRCCCCCC',
    '....DSSRRRRRR',
    '.....DDSSSSSS',
    '......DBBBD..',
    '......DBBBD..',
    '.......DDD...',
  ],
  happy: [ // 完成：笑眼 ∧ + 大嘴
    '........DDDDD',
    '......DDBBBBB',
    '.....DBBLLBBB',
    '....DBBLLBBBB',
    '...DBBLBBBBBB',
    '...DBBBKKBBBB',
    '...DBBKBBKBBB',
    '...DBBBBBBBBB',
    '...DBBBBBBBBB',
    '...DBPPBBBKKK',
    '....DBBBBBBBB',
    '.....DBBBBBBB',
    '....DDBBBBBBB',
    '....DSSSSSSSS',
    '.DBBDSRCCCCCC',
    '.DBBDSRCCCCCC',
    '.DBBDSRCCCCCC',
    '..DDDSRCCCCCC',
    '....DSRCCCCCC',
    '....DSSRRRRRR',
    '.....DDSSSSSS',
    '......DBBBD..',
    '......DBBBD..',
    '.......DDD...',
  ],
  surprised: [ // 等你/被拎起：瞪眼 + 张嘴
    '........DDDDD',
    '......DDBBBBB',
    '.....DBBLLBBB',
    '....DBBLLBBBB',
    '...DBBLBBBBBB',
    '...DBBWWWWBBB',
    '...DBBWKKWBBB',
    '...DBBWKKWBBB',
    '...DBBBBBBBBB',
    '...DBPPBBBBKK',
    '....DBBBBBBKK',
    '.....DBBBBBBB',
    '....DDBBBBBBB',
    '....DSSSSSSSS',
    '.DBBDSRCCCCCC',
    '.DBBDSRCCCCCC',
    '.DBBDSRCCCCCC',
    '..DDDSRCCCCCC',
    '....DSRCCCCCC',
    '....DSSRRRRRR',
    '.....DDSSSSSS',
    '......DBBBD..',
    '......DBBBD..',
    '.......DDD...',
  ],
};

const SQUIRTLE_HALF_W = 13;

/** 左半边 → 镜像出完整 26 列（行先右补齐透明） */
function mirrorRows(halfRows) {
  return halfRows.map((r) => {
    const h = r.padEnd(SQUIRTLE_HALF_W, '.');
    return h + [...h].reverse().join('');
  });
}

const SQUIRTLE_FRAMES = {};
for (const [name, half] of Object.entries(SQUIRTLE_HALF)) {
  SQUIRTLE_FRAMES[name] = mirrorRows(half);
}

/** 字符画 → box-shadow 串（每像素一个无模糊投影） */
function pixelShadow(rows, palette, px) {
  const out = [];
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const color = palette[row[x]];
      if (color) out.push(`${x * px}px ${y * px}px 0 0 ${color}`);
    }
  });
  return out.join(',');
}

/** 把四帧注入 #skin-squirtle（浏览器环境调用） */
function buildSquirtleSkin() {
  const host = document.getElementById('skin-squirtle');
  if (!host) return;
  const rows = SQUIRTLE_FRAMES.open.length;
  const cols = SQUIRTLE_FRAMES.open[0].length;
  host.style.width = `${cols * SQUIRTLE_PX}px`;
  host.style.height = `${rows * SQUIRTLE_PX}px`;
  for (const [name, map] of Object.entries(SQUIRTLE_FRAMES)) {
    const f = document.createElement('div');
    f.className = `px f-${name}`;
    f.style.width = `${SQUIRTLE_PX}px`;
    f.style.height = `${SQUIRTLE_PX}px`;
    f.style.boxShadow = pixelShadow(map, SQUIRTLE_PALETTE, SQUIRTLE_PX);
    host.appendChild(f);
  }
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', buildSquirtleSkin);
  else buildSquirtleSkin();
}
if (typeof module !== 'undefined') {
  module.exports = { SQUIRTLE_FRAMES, SQUIRTLE_PALETTE, SQUIRTLE_PX, pixelShadow };
}

'use strict';
/*
 * skins.js — 像素风皮肤（squirtle 小蓝龟）。
 * 字符画 → box-shadow 像素网格；每个状态对应一帧（表情差分），
 * 显示/动画由 skin-squirtle.css 按 #pet 的 data-state 驱动，状态机零改动。
 */

const SQUIRTLE_PX = 6; // 每像素边长 px

// 调色板：自绘配色（蓝龟+棕壳+奶油肚皮），. = 透明
const SQUIRTLE_PALETTE = {
  D: '#2a5d7c', // 描边深蓝
  B: '#5ec8ea', // 身体蓝
  W: '#ffffff', // 眼白
  K: '#1d1d1d', // 瞳孔/嘴
  S: '#9c5a2e', // 壳沿深棕
  R: '#d9a05b', // 壳棕
  C: '#f5e7c8', // 肚皮奶油
};

// 16 列 × 13 行；四帧只差眼睛/嘴
const SQUIRTLE_FRAMES = {
  open: [ // 平时/工作：圆眼
    '....DDDDDD......',
    '..DDBBBBBBDD....',
    '.DBBBBBBBBBBD...',
    '.DBWKBBBBWKBD...',
    '.DBBBBBBBBBBD...',
    '.DBBBDKKDBBBD...',
    '..DBBBBBBBBD....',
    '..DSSRRRRSSD....',
    '.DSRCCCCCCRSD...',
    '.DSRCCCCCCRSD...',
    '..DSSRRRRSSD....',
    '..DBBD..DBBD....',
    '...DD....DD.....',
  ],
  closed: [ // 打盹/离线：眯眼
    '....DDDDDD......',
    '..DDBBBBBBDD....',
    '.DBBBBBBBBBBD...',
    '.DBKKBBBBKKBD...',
    '.DBBBBBBBBBBD...',
    '.DBBBDKKDBBBD...',
    '..DBBBBBBBBD....',
    '..DSSRRRRSSD....',
    '.DSRCCCCCCRSD...',
    '.DSRCCCCCCRSD...',
    '..DSSRRRRSSD....',
    '..DBBD..DBBD....',
    '...DD....DD.....',
  ],
  happy: [ // 完成：笑眼 + 大嘴
    '....DDDDDD......',
    '..DDBBBBBBDD....',
    '.DBBBBBBBBBBD...',
    '.DBKKBBBBKKBD...',
    '.DBBBBBBBBBBD...',
    '.DBDKKKKKKDBD...',
    '..DBBBBBBBBD....',
    '..DSSRRRRSSD....',
    '.DSRCCCCCCRSD...',
    '.DSRCCCCCCRSD...',
    '..DSSRRRRSSD....',
    '..DBBD..DBBD....',
    '...DD....DD.....',
  ],
  surprised: [ // 等你/被拎起：瞪眼 + o 嘴
    '....DDDDDD......',
    '..DDBBBBBBDD....',
    '.DBBBBBBBBBBD...',
    '.DWWKBBBBWWKD...',
    '.DBBBBBBBBBBD...',
    '.DBBDKKKKDBBD...',
    '..DBBBBBBBBD....',
    '..DSSRRRRSSD....',
    '.DSRCCCCCCRSD...',
    '.DSRCCCCCCRSD...',
    '..DSSRRRRSSD....',
    '..DBBD..DBBD....',
    '...DD....DD.....',
  ],
};

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

'use strict';
/* skins.test.js — 像素皮肤帧数据完整性：尺寸一致、只用调色板字符、shadow 可生成。 */
const assert = require('assert');
const { SQUIRTLE_FRAMES, SQUIRTLE_PALETTE, SQUIRTLE_PX, pixelShadow } =
  require('../pet/renderer/skins.js');

let n = 0;
const ok = (cond, msg) => { assert(cond, msg); console.log('  ok  -', msg); n++; };

const names = Object.keys(SQUIRTLE_FRAMES);
ok(names.length >= 4, `至少 4 帧（实际 ${names.length}：${names.join(',')}）`);

const baseRows = SQUIRTLE_FRAMES.open.length;
const baseCols = SQUIRTLE_FRAMES.open[0].length;
for (const [name, map] of Object.entries(SQUIRTLE_FRAMES)) {
  ok(map.length === baseRows, `${name} 行数一致 (${map.length})`);
  ok(map.every((r) => r.length === baseCols), `${name} 每行 ${baseCols} 列`);
  const bad = map.join('').split('').filter((ch) => ch !== '.' && !SQUIRTLE_PALETTE[ch]);
  ok(bad.length === 0, `${name} 无未知字符${bad.length ? '（发现 ' + [...new Set(bad)].join() + '）' : ''}`);
  const shadow = pixelShadow(map, SQUIRTLE_PALETTE, SQUIRTLE_PX);
  ok(shadow.split(',').length > 50, `${name} shadow 像素数合理 (${shadow.split(',').length})`);
}

console.log(`\n${n} assertions passed.`);

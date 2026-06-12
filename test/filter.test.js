'use strict';
/* filter.test.js — 共享 agent 的按订阅 slug 过滤（filterSnapshot 纯函数）。 */
const assert = require('assert');
const { filterSnapshot } = require('../agent/state.js');
const { cwdToSlug } = require('../agent/collector.js');

let n = 0;
const ok = (cond, msg) => { assert(cond, msg); console.log('  ok  -', msg); n++; };

const snap = {
  pet: 'waiting', reason: 'waiting @ other', ts: 1,
  sessions: [
    { sessionId: 'a', cwd: '/home/q/vibe/projects/zengyuny/x', project: 'x', state: 'working' },
    { sessionId: 'b', cwd: '/home/q/vibe/projects/wenfengh', project: 'wenfengh', state: 'waiting' },
    { sessionId: 'c', cwd: '/home/q/vibe/projects/zengyuny', project: 'zengyuny', state: 'idle' },
  ],
};

const mine = filterSnapshot(snap, ['-home-q-vibe-projects-zengyuny'], cwdToSlug);
ok(mine.sessions.length === 2, '只保留匹配 slug 的会话');
ok(mine.sessions.every((s) => s.cwd.includes('zengyuny')), '过滤掉了他人会话');
ok(mine.pet === 'working', '总状态按过滤后子集重算（他人的 waiting 不影响我）');

const none = filterSnapshot(snap, ['-home-q-vibe-projects-nobody'], cwdToSlug);
ok(none.sessions.length === 0 && none.pet === 'idle', '无匹配 → 空列表 + idle');

const all = filterSnapshot(snap, null, cwdToSlug);
ok(all === snap, '不带 slug → 原样全量');

console.log(`\n${n} assertions passed.`);

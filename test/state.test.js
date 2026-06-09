'use strict';
const assert = require('assert');
const { aggregate } = require('../agent/state.js');

let pass = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok  -', name); }
  catch (e) { console.error('  FAIL-', name, '\n   ', e.message); process.exitCode = 1; }
}

const S = (sid, state, extra = {}) => ({
  sessionId: sid, state, project: extra.project || sid, lastTs: extra.lastTs || 1000,
  alive: extra.alive || false, source: 'heuristic', ...extra,
});

console.log('state.aggregate:');

t('empty → idle', () => {
  const r = aggregate({ sessions: [], now: 100 });
  assert.strictEqual(r.pet, 'idle');
});

t('single working → working', () => {
  const r = aggregate({ sessions: [S('a', 'working')], now: 100 });
  assert.strictEqual(r.pet, 'working');
});

t('waiting beats working', () => {
  const r = aggregate({ sessions: [S('a', 'working'), S('b', 'waiting')], now: 100 });
  assert.strictEqual(r.pet, 'waiting');
  assert.strictEqual(r.sessions[0].state, 'waiting'); // 排第一
});

t('hook Notification overrides heuristic idle → waiting', () => {
  const r = aggregate({
    sessions: [S('a', 'idle')],
    hookState: { a: { event: 'Notification', ts: 100, cwd: '/x' } },
    now: 110,
  });
  assert.strictEqual(r.pet, 'waiting');
  assert.strictEqual(r.sessions[0].source, 'hook');
});

t('hook beyond TTL is ignored → falls back to heuristic', () => {
  const r = aggregate({
    sessions: [S('a', 'idle')],
    hookState: { a: { event: 'Notification', ts: 0 } },
    now: 100, opts: { hookTtlMs: 50 },
  });
  assert.strictEqual(r.pet, 'idle');
  assert.strictEqual(r.sessions[0].source, 'heuristic');
});

t('done transition: working→idle shows done, then settles idle', () => {
  // tick1: working
  let r = aggregate({ sessions: [S('a', 'working')], now: 100 });
  assert.strictEqual(r.pet, 'working');
  // tick2: heuristic now idle → should become done
  r = aggregate({ sessions: [S('a', 'idle')], prev: r.prev, now: 200, opts: { doneWindowMs: 100 } });
  assert.strictEqual(r.pet, 'done', 'expected done pulse');
  // tick3: still within window → done
  r = aggregate({ sessions: [S('a', 'idle')], prev: r.prev, now: 250, opts: { doneWindowMs: 100 } });
  assert.strictEqual(r.pet, 'done');
  // tick4: window passed → idle
  r = aggregate({ sessions: [S('a', 'idle')], prev: r.prev, now: 400, opts: { doneWindowMs: 100 } });
  assert.strictEqual(r.pet, 'idle');
});

t('hook Stop ends turn (idle) and triggers done after working', () => {
  let r = aggregate({
    sessions: [S('a', 'working')],
    hookState: { a: { event: 'UserPromptSubmit', ts: 100 } }, now: 100,
  });
  assert.strictEqual(r.pet, 'working');
  r = aggregate({
    sessions: [S('a', 'working')], // heuristic lags, but hook says Stop
    hookState: { a: { event: 'Stop', ts: 200 } },
    prev: r.prev, now: 200, opts: { doneWindowMs: 100 },
  });
  assert.strictEqual(r.pet, 'done');
});

t('SessionEnd hook removes session', () => {
  const r = aggregate({
    sessions: [S('a', 'idle')],
    hookState: { a: { event: 'SessionEnd', ts: 100 } }, now: 110,
  });
  assert.strictEqual(r.sessions.length, 0);
  assert.strictEqual(r.pet, 'idle');
});

t('hook-only session (not in collector list) still surfaces', () => {
  const r = aggregate({
    sessions: [],
    hookState: { z: { event: 'Notification', ts: 100, project: 'proj-z', cwd: '/z' } },
    now: 110,
  });
  assert.strictEqual(r.pet, 'waiting');
  assert.strictEqual(r.sessions[0].project, 'proj-z');
});

console.log(`\n${pass} assertions passed.`);

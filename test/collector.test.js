'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  scanAllSessions,
  scanCodexSessions,
  lastCodexContentEvent,
} = require('../agent/collector.js');

let pass = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok  -', name); }
  catch (e) { console.error('  FAIL-', name, '\n   ', e.stack || e.message); process.exitCode = 1; }
}

function writeJsonl(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

function makeCodexHome() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-pet-codex-'));
  const sid = '019eb51e-802f-78e2-a7b3-91f01bcf1f40';
  const file = path.join(root, 'sessions', '2026', '06', '11', `rollout-2026-06-11T13-18-55-${sid}.jsonl`);
  writeJsonl(file, [
    {
      timestamp: '2026-06-11T05:19:01.249Z',
      type: 'session_meta',
      payload: { id: sid, cwd: '/home/q/vibe/projects/zengyuny', originator: 'codex_vscode' },
    },
    {
      timestamp: '2026-06-11T05:19:08.879Z',
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'add codex support' }] },
    },
    {
      timestamp: '2026-06-11T05:20:07.632Z',
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] },
    },
  ]);
  const mtime = new Date('2026-06-11T05:20:07.632Z');
  fs.utimesSync(file, mtime, mtime);
  writeJsonl(path.join(root, 'session_index.jsonl'), [
    { id: sid, thread_name: 'Add Codex support', updated_at: '2026-06-11T05:20:07.632Z' },
  ]);
  return { root, sid, file };
}

console.log('collector:');

t('lastCodexContentEvent reads response_item message role', () => {
  const { file } = makeCodexHome();
  const ev = lastCodexContentEvent(file);
  assert.strictEqual(ev.role, 'assistant');
  assert.strictEqual(ev.ts, Date.parse('2026-06-11T05:20:07.632Z'));
});

t('scanCodexSessions reads recent codex sessions with title and cwd filter', () => {
  const { root, sid } = makeCodexHome();
  const sessions = scanCodexSessions({
    codexHome: root,
    now: Date.parse('2026-06-11T05:20:10.000Z'),
    recentDoneMs: 10 * 60 * 1000,
    activeMs: 1000,
    slugIncludes: ['-home-q-vibe-projects-zengyuny'],
  });
  assert.strictEqual(sessions.length, 1);
  assert.strictEqual(sessions[0].sessionId, `codex:${sid}`);
  assert.strictEqual(sessions[0].provider, 'codex');
  assert.strictEqual(sessions[0].project, 'zengyuny');
  assert.strictEqual(sessions[0].title, 'Add Codex support');
  assert.strictEqual(sessions[0].state, 'idle');
});

t('scanAllSessions keeps legacy default claude-only behavior', () => {
  const { root } = makeCodexHome();
  const sessions = scanAllSessions({
    claudeHome: path.join(root, 'missing-claude'),
    codexHome: root,
    now: Date.parse('2026-06-11T05:20:10.000Z'),
    recentDoneMs: 10 * 60 * 1000,
    execFn: () => '',
  });
  assert.deepStrictEqual(sessions, []);
});

t('scanAllSessions includes codex only when provider is explicit', () => {
  const { root } = makeCodexHome();
  const sessions = scanAllSessions({
    providers: [{ type: 'codex', codexHome: root, slugIncludes: ['-home-q-vibe-projects-zengyuny'] }],
    now: Date.parse('2026-06-11T05:20:10.000Z'),
    recentDoneMs: 10 * 60 * 1000,
  });
  assert.strictEqual(sessions.length, 1);
  assert.strictEqual(sessions[0].provider, 'codex');
});

console.log(`\n${pass} assertions passed.`);

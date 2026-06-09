'use strict';
/*
 * server.js — cc-pet-agent：采集 Claude Code 状态并经 HTTP/SSE 暴露。
 * 零外部依赖（Node 内置 http），方便在 vibe 直接跑、经 proxy 暴露。
 *
 *   GET  /health            → ok
 *   GET  /status[?token=]   → { pet, reason, sessions, ts }
 *   GET  /events[?token=]   → SSE，状态变化即推 + 心跳
 *   POST /hook[?token=]     → 接收 Claude Code hook 事件（精确态）
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { scanSessions } = require('./collector.js');
const { aggregate } = require('./state.js');

function loadConfig() {
  const def = {
    port: 47600,
    host: '127.0.0.1',
    token: '',                 // 非空则三个端点都要 ?token=
    claudeHome: process.env.CLAUDE_HOME || null, // null → collector 默认 ~/.claude
    slugIncludes: null,        // 例：['-home-q-vibe-projects-zengyuny']；null=全部
    scanIntervalMs: 1500,
    heartbeatMs: 25000,
    activeMs: 4000,
    graceMs: 30000,
    recentDoneMs: 300000,
    hookTtlMs: 900000,
    doneWindowMs: 4000,
  };
  let fileCfg = {};
  const cfgPath = process.env.CC_PET_CONFIG || path.join(__dirname, 'config.json');
  try { fileCfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch { /* use defaults */ }
  const cfg = { ...def, ...fileCfg };
  // 环境变量覆盖（便于命令行临时调）
  if (process.env.CC_PET_PORT) cfg.port = parseInt(process.env.CC_PET_PORT, 10);
  if (process.env.CC_PET_TOKEN) cfg.token = process.env.CC_PET_TOKEN;
  if (process.env.CC_PET_SLUGS) cfg.slugIncludes = process.env.CC_PET_SLUGS.split(',').map(s => s.trim()).filter(Boolean);
  if (process.env.CC_PET_HOST) cfg.host = process.env.CC_PET_HOST;
  return cfg;
}

const cfg = loadConfig();

// ---- 运行态 ----
const cpuCache = {};
let lastScanTs = Date.now();
let prevAgg = { sessionStates: {}, doneUntil: {}, pet: 'idle' };
let snapshot = { pet: 'idle', reason: 'starting', sessions: [], ts: Date.now() };
const hookState = {};            // sid -> { event, ts, cwd, project, toolName }
const clients = new Set();       // SSE 响应对象

function pruneHooks(now) {
  for (const sid of Object.keys(hookState)) {
    if (now - hookState[sid].ts > cfg.hookTtlMs) delete hookState[sid];
  }
}

function sig(snap) {
  return snap.pet + '|' + snap.sessions.map(s => s.sessionId.slice(0, 8) + ':' + s.state).join(',');
}
let lastSig = '';

function tick(force = false) {
  const now = Date.now();
  pruneHooks(now);
  const sessions = scanSessions({
    claudeHome: cfg.claudeHome, slugIncludes: cfg.slugIncludes,
    now, cpuCache, lastScanTs,
    activeMs: cfg.activeMs, graceMs: cfg.graceMs, recentDoneMs: cfg.recentDoneMs,
  });
  lastScanTs = now;
  const agg = aggregate({
    sessions, hookState, prev: prevAgg, now,
    opts: { hookTtlMs: cfg.hookTtlMs, doneWindowMs: cfg.doneWindowMs },
  });
  prevAgg = agg.prev;
  snapshot = { pet: agg.pet, reason: agg.reason, sessions: agg.sessions, ts: agg.ts, changedAt: agg.changedAt };
  const s = sig(snapshot);
  if (force || s !== lastSig) {
    lastSig = s;
    broadcast(snapshot);
  }
}

function broadcast(snap) {
  const payload = `data: ${JSON.stringify(snap)}\n\n`;
  for (const res of clients) {
    try { res.write(payload); } catch { /* drop on next */ }
  }
}

// ---- HTTP ----
function checkToken(url) {
  if (!cfg.token) return true;
  return url.searchParams.get('token') === cfg.token;
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathName = url.pathname.replace(/\/+$/, '') || '/';

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  if (pathName === '/health') return sendJson(res, 200, { ok: true, ts: Date.now() });

  if (pathName === '/status') {
    if (!checkToken(url)) return sendJson(res, 401, { error: 'bad token' });
    return sendJson(res, 200, snapshot);
  }

  if (pathName === '/hook' && req.method === 'POST') {
    if (!checkToken(url)) return sendJson(res, 401, { error: 'bad token' });
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      let d = {};
      try { d = JSON.parse(body || '{}'); } catch { return sendJson(res, 400, { error: 'bad json' }); }
      const sid = d.sessionId || d.session_id;
      const event = d.event || d.hook_event_name;
      if (sid && event) {
        hookState[sid] = {
          event, ts: Date.now(),
          cwd: d.cwd || null,
          project: d.project || (d.cwd ? path.basename(d.cwd) : null),
          toolName: d.toolName || d.tool_name || null,
        };
        tick(true); // 立即反映
      }
      sendJson(res, 200, { ok: true });
    });
    return;
  }

  if (pathName === '/events') {
    if (!checkToken(url)) return sendJson(res, 401, { error: 'bad token' });
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'X-Accel-Buffering': 'no', // 关 nginx 缓冲，保证 SSE 实时
    });
    res.write('retry: 3000\n\n');
    res.write(`data: ${JSON.stringify(snapshot)}\n\n`); // 立即给当前态
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  sendJson(res, 404, { error: 'not found' });
});

// SSE 心跳，防代理/防火墙掐断
setInterval(() => {
  for (const res of clients) { try { res.write(': ping\n\n'); } catch {} }
}, cfg.heartbeatMs);

setInterval(() => tick(false), cfg.scanIntervalMs);

server.listen(cfg.port, cfg.host, () => {
  tick(true);
  console.log(`[cc-pet-agent] listening http://${cfg.host}:${cfg.port}`);
  console.log(`[cc-pet-agent] slugIncludes=${JSON.stringify(cfg.slugIncludes)} token=${cfg.token ? 'set' : 'none'}`);
});

module.exports = { loadConfig };

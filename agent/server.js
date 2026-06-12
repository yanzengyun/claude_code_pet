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
const { scanAllSessions, slugMatches, cwdToSlug } = require('./collector.js');
const { aggregate, filterSnapshot } = require('./state.js');

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
    providers: null,            // null → 兼容旧配置，只扫 Claude；显式配置后可加 codex
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
  if (process.env.CC_PET_PROVIDERS) {
    cfg.providers = process.env.CC_PET_PROVIDERS.split(',').map((s) => s.trim()).filter(Boolean).map((type) => ({ type }));
  }
  if (Array.isArray(cfg.providers)) {
    cfg.providers = cfg.providers.map((p) => ({
      ...p,
      type: p.type || p.name || 'claude',
      slugIncludes: p.slugIncludes ?? cfg.slugIncludes,
    }));
    for (const p of cfg.providers) {
      if (p.type === 'claude' && process.env.CLAUDE_HOME && !p.claudeHome) p.claudeHome = process.env.CLAUDE_HOME;
      if (p.type === 'codex' && process.env.CODEX_HOME && !p.codexHome) p.codexHome = process.env.CODEX_HOME;
    }
  }
  return cfg;
}

const cfg = loadConfig();

// ---- 运行态 ----
const cpuCache = {};
let lastScanTs = Date.now();
let prevAgg = { sessionStates: {}, doneUntil: {}, pet: 'idle' };
let snapshot = { pet: 'idle', reason: 'starting', sessions: [], ts: Date.now() };
let lastHookAt = 0; // 最近一次收到（且通过过滤的）hook 事件时间
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

// 全量扫描结果缓存：hook 事件触发的快速重聚合直接复用，绝不为每个事件扫文件。
// （共享 agent 看全机时，hook 事件频率 × 全机扫描成本曾把事件循环卡死 → accept 积压）
let lastSessions = [];

/** 重聚合 + 推送（轻量，仅内存计算） */
function refresh(force = false) {
  const now = Date.now();
  pruneHooks(now);
  const agg = aggregate({
    sessions: lastSessions, hookState, prev: prevAgg, now,
    opts: { hookTtlMs: cfg.hookTtlMs, doneWindowMs: cfg.doneWindowMs },
  });
  prevAgg = agg.prev;
  snapshot = { pet: agg.pet, reason: agg.reason, sessions: agg.sessions, ts: agg.ts, changedAt: agg.changedAt, lastHookAt: lastHookAt || null };
  const s = sig(snapshot);
  if (force || s !== lastSig) {
    lastSig = s;
    broadcast(snapshot);
  }
}

// ---- 按订阅动态收窄扫描范围（共享 agent：没人看谁就不扫谁，没人连就不扫） ----
// /status 一次性请求用租约保活（硬件轮询等场景），SSE 订阅直接看在线集合
const statusLeases = new Map(); // slug串 → 过期时间
const STATUS_LEASE_MS = 90 * 1000;

/** 计算本拍扫描范围：配置有固定白名单 → 用配置；否则 = 全部订阅者的 slug 并集。
 *  返回 null=扫全部（有无过滤订阅者），[]=没人在看（跳过扫描），数组=并集 */
function scanScope(now) {
  if (cfg.slugIncludes && cfg.slugIncludes.length) return cfg.slugIncludes;
  const slugs = new Set();
  for (const res of clients) {
    if (!res.__slugIncludes) return null; // 有人订阅全量
    for (const s of res.__slugIncludes) slugs.add(s);
  }
  for (const [k, exp] of statusLeases) {
    if (exp <= now) { statusLeases.delete(k); continue; }
    if (k === '*') return null;
    for (const s of k.split(',')) slugs.add(s);
  }
  return [...slugs];
}

/** 全量扫描（重，只按定时器节奏跑；范围随订阅动态收窄） */
function tick(force = false) {
  const now = Date.now();
  const scope = scanScope(now);
  if (Array.isArray(scope) && scope.length === 0) {
    lastSessions = []; // 没有任何订阅者：完全不扫文件，agent 近乎零负载待机
    refresh(force);
    return;
  }
  lastSessions = scanAllSessions({
    claudeHome: cfg.claudeHome, providers: cfg.providers, slugIncludes: scope,
    now, cpuCache, lastScanTs,
    activeMs: cfg.activeMs, graceMs: cfg.graceMs, recentDoneMs: cfg.recentDoneMs,
  });
  lastScanTs = now;
  refresh(force);
}

function broadcast(snap) {
  for (const res of clients) {
    try {
      const view = res.__slugIncludes ? filterSnapshot(snap, res.__slugIncludes, cwdToSlug) : snap;
      res.write(`data: ${JSON.stringify(view)}\n\n`);
    } catch { /* drop on next */ }
  }
}

/** 解析订阅方的 ?slug= 过滤（逗号分隔），无则 null=全量 */
function slugParam(url) {
  const raw = url.searchParams.get('slug');
  if (!raw) return null;
  const list = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return list.length ? list : null;
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
    const includes = slugParam(url);
    // 一次性请求租约 90s：让轮询方（硬件设备等）也能把扫描范围保持住
    statusLeases.set(includes ? includes.join(',') : '*', Date.now() + STATUS_LEASE_MS);
    return sendJson(res, 200, filterSnapshot(snapshot, includes, cwdToSlug));
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
      // hooks 装在共享 settings 里，所有人的会话都会发事件过来；
      // 与 collector 同口径按 slugIncludes 过滤，只收自己项目的（无 cwd 的丢弃）
      const inScope = !cfg.slugIncludes || cfg.slugIncludes.length === 0
        || (d.cwd && slugMatches(cwdToSlug(d.cwd), cfg.slugIncludes));
      if (sid && event && inScope) {
        hookState[sid] = {
          event, ts: Date.now(),
          cwd: d.cwd || null,
          project: d.project || (d.cwd ? path.basename(d.cwd) : null),
          toolName: d.toolName || d.tool_name || null,
        };
        lastHookAt = Date.now(); // 供客户端判断「hooks 实际已生效」（可能由别的账号安装）
        refresh(true); // 立即反映：仅重聚合（复用扫描缓存），hook 高频时绝不触发全机扫描
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
    res.__slugIncludes = slugParam(url); // 共享 agent：每个订阅按自己的 slug 看自己的
    res.write('retry: 3000\n\n');
    res.write(`data: ${JSON.stringify(filterSnapshot(snapshot, res.__slugIncludes, cwdToSlug))}\n\n`); // 立即给当前态
    clients.add(res);
    req.on('close', () => clients.delete(res));
    setImmediate(() => tick(true)); // 新订阅者：立刻按新范围扫一拍，首屏不等下个周期
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
  console.log(`[cc-pet-agent] providers=${JSON.stringify(cfg.providers || [{ type: 'claude' }])}`);
});

module.exports = { loadConfig };

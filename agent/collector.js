'use strict';
/*
 * collector.js — 采集 Claude Code / Codex 各 session 的运行信号，产出每 session 的基线状态。
 *
 * 信号来源（基线，零配置）：
 *   1. 进程扫描：ps 找 `claude ... --resume <id>` 的活进程
 *   2. CPU 增量：相邻两次扫描间 /proc/<pid>/stat 的 utime+stime 差 → 此刻是否在算
 *   3. jsonl 尾：读 <sessionId>.jsonl 最后一条 user/assistant 内容事件 + 文件 mtime
 *
 * 纯数据输出，便于断言。hook 精确态 / done 跃迁 / 聚合 由 state.js 处理。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const CLK_TCK = 100; // Linux 默认 jiffies/秒（getconf CLK_TCK），CPU 增量判活足够

function defaultClaudeHome() {
  return process.env.CLAUDE_HOME || path.join(os.homedir(), '.claude');
}

function defaultCodexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

/** 读文件尾部最多 maxBytes 字节（避免读整文件） */
function readTail(file, maxBytes = 65536) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const { size } = fs.fstatSync(fd);
    const start = Math.max(0, size - maxBytes);
    const len = size - start;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    return buf.toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
  }
}

/** 从 jsonl 尾取最后一条 user/assistant 内容事件的 {role, ts, cwd, gitBranch} */
function lastContentEvent(jsonlPath) {
  const tail = readTail(jsonlPath);
  if (!tail) return null;
  const lines = tail.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line || line[0] !== '{') continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    if (d.type === 'user' || d.type === 'assistant') {
      return {
        role: d.type,
        ts: d.timestamp ? Date.parse(d.timestamp) : null,
        cwd: d.cwd || null,
        gitBranch: d.gitBranch || null,
      };
    }
  }
  return null;
}

function payloadRole(d) {
  const p = d && d.payload;
  if (!p) return null;
  if (p.type === 'message' && (p.role === 'user' || p.role === 'assistant')) return p.role;
  return null;
}

function codexEventTime(d) {
  if (!d || !d.timestamp) return null;
  const t = Date.parse(d.timestamp);
  return Number.isFinite(t) ? t : null;
}

function codexTextFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const part = content.find((b) => b && (b.type === 'input_text' || b.type === 'output_text') && typeof b.text === 'string');
  return part ? part.text : null;
}

/** 从 Codex jsonl 尾取最后一条 user/assistant message。 */
function lastCodexContentEvent(jsonlPath) {
  const tail = readTail(jsonlPath);
  if (!tail) return null;
  const lines = tail.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line || line[0] !== '{') continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    const role = payloadRole(d);
    if (role) return { role, ts: codexEventTime(d), cwd: null, gitBranch: null };
  }
  return null;
}

// session_meta 在文件头、写入后不变 → 按路径永久缓存，避免每拍重读 128KB
const codexMetaCache = new Map(); // path → payload
function codexSessionMeta(jsonlPath) {
  if (codexMetaCache.has(jsonlPath)) return codexMetaCache.get(jsonlPath);
  const head = readHead(jsonlPath, 131072);
  const lines = head.split('\n');
  for (const line of lines) {
    if (!line || line.indexOf('"session_meta"') === -1) continue;
    try {
      const d = JSON.parse(line.trim());
      if (d.type === 'session_meta' && d.payload) {
        if (codexMetaCache.size > 2000) codexMetaCache.clear(); // 粗暴防膨胀
        codexMetaCache.set(jsonlPath, d.payload);
        return d.payload;
      }
    } catch {}
  }
  return null; // 没读到不缓存：文件头可能还没写完
}

/** 读文件头部最多 maxBytes 字节 */
function readHead(file, maxBytes = 131072) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const { size } = fs.fstatSync(fd);
    const len = Math.min(size, maxBytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, 0);
    return buf.toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
  }
}

/** 从一段 jsonl 文本里找 ai-title（reverse=true 取最后一条，否则取第一条） */
function findAiTitle(text, reverse) {
  const lines = text.split('\n');
  const idx = reverse ? lines.map((_, i) => lines.length - 1 - i) : lines.map((_, i) => i);
  for (const i of idx) {
    const line = lines[i];
    if (!line || line.indexOf('"ai-title"') === -1) continue;
    try {
      const d = JSON.parse(line.trim());
      if (d.type === 'ai-title' && d.aiTitle) return String(d.aiTitle);
    } catch {}
  }
  return null;
}

/** 兜底标题：最后一条纯文本用户消息（截断），跳过命令注入/工具结果 */
function lastUserText(text) {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || line.indexOf('"user"') === -1) continue;
    let d;
    try { d = JSON.parse(line.trim()); } catch { continue; }
    if (d.type !== 'user') continue;
    let c = d.message && d.message.content;
    if (Array.isArray(c)) { // content 块数组：取第一个 text 块（跳过 tool_result 等）
      const t = c.find((b) => b && b.type === 'text' && typeof b.text === 'string');
      c = t ? t.text : null;
    }
    if (typeof c !== 'string') continue;
    const s = c.trim();
    if (!s || s[0] === '<') continue; // 跳过 <command-...> 等系统注入
    return s.length > 40 ? s.slice(0, 40) + '…' : s;
  }
  return null;
}

// Codex 注入的非用户输入（环境上下文/历史回放/AGENTS 等），不能当标题
const CODEX_INJECTED_RE = /^(<|The following is|#+\s*AGENTS|Caveat:)/i;
function lastCodexUserText(text) {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || line.indexOf('"response_item"') === -1 || line.indexOf('"user"') === -1) continue;
    let d;
    try { d = JSON.parse(line.trim()); } catch { continue; }
    if (d.type !== 'response_item' || payloadRole(d) !== 'user') continue;
    const s = codexTextFromContent(d.payload && d.payload.content);
    if (!s || !s.trim()) continue;
    const t = s.trim();
    if (CODEX_INJECTED_RE.test(t)) continue;
    return t.length > 40 ? t.slice(0, 40) + '…' : t;
  }
  return null;
}

/** 会话标题：jsonl 中最近一条 ai-title 事件，无则用最后一条用户消息。带 TTL 缓存 */
const titleCache = new Map(); // path → { title, readAt }
const TITLE_TTL_MS = 30000;
function sessionTitle(jsonlPath) {
  if (!jsonlPath) return null;
  const now = Date.now();
  const cached = titleCache.get(jsonlPath);
  if (cached && (now - cached.readAt) < TITLE_TTL_MS) return cached.title;
  const tail = readTail(jsonlPath, 131072);
  const title = findAiTitle(tail, true)
    || findAiTitle(readHead(jsonlPath, 131072), false)
    || lastUserText(tail)
    || (cached ? cached.title : null);
  titleCache.set(jsonlPath, { title, readAt: now });
  return title;
}

const codexIndexCache = { path: null, mtimeMs: 0, readAt: 0, titles: new Map() };
function readCodexTitles(codexHome) {
  const indexPath = path.join(codexHome, 'session_index.jsonl');
  let st;
  try { st = fs.statSync(indexPath); } catch { return new Map(); }
  const now = Date.now();
  if (codexIndexCache.path === indexPath && codexIndexCache.mtimeMs === st.mtimeMs && (now - codexIndexCache.readAt) < TITLE_TTL_MS) {
    return codexIndexCache.titles;
  }
  const titles = new Map();
  const tail = readTail(indexPath, 1024 * 1024);
  for (const line of tail.split('\n')) {
    if (!line || line[0] !== '{') continue;
    try {
      const d = JSON.parse(line);
      if (d.id && d.thread_name) titles.set(String(d.id), String(d.thread_name));
    } catch {}
  }
  codexIndexCache.path = indexPath;
  codexIndexCache.mtimeMs = st.mtimeMs;
  codexIndexCache.readAt = now;
  codexIndexCache.titles = titles;
  return titles;
}

function codexSessionTitle(jsonlPath, codexHome, sessionId) {
  const titles = readCodexTitles(codexHome);
  if (titles.has(sessionId)) return titles.get(sessionId);
  // 索引没有 → 兜底读尾部用户消息，与 Claude 标题共用 TTL 缓存（path 不会撞）
  const now = Date.now();
  const cached = titleCache.get(jsonlPath);
  if (cached && (now - cached.readAt) < TITLE_TTL_MS) return cached.title;
  const title = lastCodexUserText(readTail(jsonlPath, 131072)) || (cached ? cached.title : null);
  titleCache.set(jsonlPath, { title, readAt: now });
  return title;
}

/** 扫描所有 claude CLI 进程，返回 [{pid, sessionId|null, jiffies}] */
function scanProcesses(execFn = execFileSync) {
  let out = '';
  try {
    out = execFn('ps', ['-eo', 'pid=,args='], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  } catch {
    return [];
  }
  const procs = [];
  for (const raw of out.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const sp = line.indexOf(' ');
    if (sp < 0) continue;
    const pid = parseInt(line.slice(0, sp), 10);
    const args = line.slice(sp + 1);
    if (!Number.isFinite(pid)) continue;
    // 只认真正的 claude CLI（排除 code-server / language server / grep 等）
    if (!/(^|\/)claude\b/.test(args) && !/[/]\.local\/bin\/claude\b/.test(args)) continue;
    if (/code-server|language-server|\bgrep\b|cc-pet/.test(args)) continue;
    if (!/\bclaude\b/.test(args)) continue;
    const m = args.match(/--resume\s+([0-9a-f-]{8,})/i);
    procs.push({ pid, sessionId: m ? m[1] : null, jiffies: readJiffies(pid) });
  }
  return procs;
}

function scanCodexProcesses(execFn = execFileSync) {
  let out = '';
  try {
    out = execFn('ps', ['-eo', 'pid=,args='], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  } catch {
    return [];
  }
  const procs = [];
  for (const raw of out.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const sp = line.indexOf(' ');
    if (sp < 0) continue;
    const pid = parseInt(line.slice(0, sp), 10);
    const args = line.slice(sp + 1);
    if (!Number.isFinite(pid)) continue;
    if (!/(^|\/)codex\b/.test(args) && !/[/]codex-[^/\s]+/.test(args)) continue;
    if (/code-server|language-server|\bgrep\b|cc-pet/.test(args)) continue;
    // codex 命令行不带 session id，用进程 cwd 归属到会话（读不到=别人的进程，自然排除）
    procs.push({ pid, cwd: readProcCwd(pid), jiffies: readJiffies(pid) });
  }
  return procs;
}

/** 读 /proc/<pid>/cwd 符号链接；非 Linux / 无权限（他人进程）返回 null */
function readProcCwd(pid) {
  try { return fs.readlinkSync(`/proc/${pid}/cwd`); } catch { return null; }
}

/** 读 /proc/<pid>/stat 的 utime+stime（jiffies）；非 Linux 或失败返回 null */
function readJiffies(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    // 进程名可能含空格/括号，取最后一个 ')' 之后再切字段
    const rp = stat.lastIndexOf(')');
    const fields = stat.slice(rp + 2).split(' ');
    // 切片后字段从原始第 3 个(state)起：utime=原14→idx 11, stime=原15→idx 12
    const utime = parseInt(fields[11], 10);
    const stime = parseInt(fields[12], 10);
    if (!Number.isFinite(utime) || !Number.isFinite(stime)) return null;
    return utime + stime;
  } catch {
    return null;
  }
}

/** slug 是否匹配过滤白名单（includes 为空/未给 → 全部匹配） */
function slugMatches(slug, includes) {
  if (!includes || includes.length === 0) return true;
  return includes.some((inc) => slug.includes(inc));
}

/** cwd 路径 → projects 目录的 slug 形式（/home/q/x → -home-q-x），供 hook 事件按 slugIncludes 过滤 */
function cwdToSlug(cwd) {
  return String(cwd || '').replace(/[^A-Za-z0-9-]/g, '-');
}

/** 在 projects 目录里找 <sessionId>.jsonl，返回 {path, mtimeMs, slug} 或 null */
function findSessionFile(claudeHome, sessionId, includes) {
  const projectsDir = path.join(claudeHome, 'projects');
  let slugs;
  try { slugs = fs.readdirSync(projectsDir); } catch { return null; }
  for (const slug of slugs) {
    if (!slugMatches(slug, includes)) continue;
    const p = path.join(projectsDir, slug, `${sessionId}.jsonl`);
    try {
      const st = fs.statSync(p);
      return { path: p, mtimeMs: st.mtimeMs, slug };
    } catch { /* not here */ }
  }
  return null;
}

/** 列出最近修改过的 session 文件（即使没有活进程，用于兜底/最近完成） */
function recentSessionFiles(claudeHome, lookbackMs, now, includes) {
  const projectsDir = path.join(claudeHome, 'projects');
  const res = [];
  let slugs;
  try { slugs = fs.readdirSync(projectsDir); } catch { return res; }
  for (const slug of slugs) {
    if (!slugMatches(slug, includes)) continue;
    const dir = path.join(projectsDir, slug);
    let files;
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const p = path.join(dir, f);
      let st;
      try { st = fs.statSync(p); } catch { continue; }
      if (now - st.mtimeMs <= lookbackMs) {
        res.push({ sessionId: f.slice(0, -6), slug, path: p, mtimeMs: st.mtimeMs });
      }
    }
  }
  return res;
}

function sessionIdFromCodexFile(file) {
  const base = path.basename(file, '.jsonl');
  const m = base.match(/([0-9a-f]{8}-[0-9a-f-]{27,})$/i);
  return m ? m[1] : base;
}

/** 日期目录（YYYY/MM/DD）是否整体早于回看窗口（多放一天余量抵消时区差） */
function dateDirTooOld(parts, cutoffMs) {
  if (!parts.length || !parts.every((s) => /^\d+$/.test(s))) return false;
  const [y, m = 12, d = 31] = parts.map(Number);
  const dirEndMs = Date.UTC(y, m - 1, d, 23, 59, 59) + 24 * 3600 * 1000;
  return dirEndMs < cutoffMs;
}

function recentCodexSessionFiles(codexHome, lookbackMs, now, includes) {
  const sessionsDir = path.join(codexHome, 'sessions');
  const cutoffMs = now - lookbackMs;
  const res = [];
  function walk(dir, depth, parts) {
    if (depth > 4) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        const nextParts = [...parts, ent.name];
        if (dateDirTooOld(nextParts, cutoffMs)) continue; // 整个早于窗口的年/月/日直接跳过
        walk(p, depth + 1, nextParts);
        continue;
      }
      if (!ent.isFile() || !ent.name.endsWith('.jsonl')) continue;
      let st;
      try { st = fs.statSync(p); } catch { continue; }
      if (now - st.mtimeMs > lookbackMs) continue;
      const meta = codexSessionMeta(p);
      const cwd = meta && meta.cwd ? meta.cwd : null;
      if (includes && includes.length && !slugMatches(cwdToSlug(cwd), includes)) continue;
      res.push({ sessionId: (meta && meta.id) || sessionIdFromCodexFile(p), path: p, mtimeMs: st.mtimeMs, meta });
    }
  }
  walk(sessionsDir, 0, []);
  return res;
}

/**
 * 主入口：采集所有候选 session 的基线状态。
 * opts: { claudeHome, now, cpuCache, lastScanTs, activeMs, graceMs, recentDoneMs, execFn }
 *   cpuCache: { [pid]: jiffies } 上次扫描的快照（本函数会更新它）
 * 返回 Session[]
 */
function scanSessions(opts = {}) {
  const claudeHome = opts.claudeHome || defaultClaudeHome();
  const now = opts.now || Date.now();
  const activeMs = opts.activeMs ?? 4000;        // jsonl 多久内算"刚写过"
  const graceMs = opts.graceMs ?? 30000;         // user 事件后多久仍算 working
  const recentDoneMs = opts.recentDoneMs ?? 300000; // 无进程但 5min 内动过仍展示
  const cpuCache = opts.cpuCache || {};
  const lastScanTs = opts.lastScanTs || now;
  const execFn = opts.execFn || execFileSync;
  const includes = opts.slugIncludes || null; // 例：['-home-q-vibe-projects-zengyuny']

  const procs = scanProcesses(execFn);
  const elapsedMs = Math.max(1, now - lastScanTs);

  // sessionId -> 进程（取第一个匹配）
  const procBySession = new Map();
  for (const p of procs) {
    if (p.sessionId && !procBySession.has(p.sessionId)) procBySession.set(p.sessionId, p);
  }

  // 候选集合：有 sessionId 的活进程 ∪ 最近修改过的 jsonl
  const candidates = new Map(); // sessionId -> { sessionId, slug?, jsonlPath?, mtimeMs? }
  for (const [sid] of procBySession) candidates.set(sid, { sessionId: sid });
  for (const rf of recentSessionFiles(claudeHome, recentDoneMs, now, includes)) {
    const ex = candidates.get(rf.sessionId) || { sessionId: rf.sessionId };
    ex.slug = rf.slug; ex.jsonlPath = rf.path; ex.mtimeMs = rf.mtimeMs;
    candidates.set(rf.sessionId, ex);
  }

  const sessions = [];
  const newCpuCache = {};
  for (const [sid, c] of candidates) {
    const proc = procBySession.get(sid) || null;
    let jsonlPath = c.jsonlPath;
    let mtimeMs = c.mtimeMs;
    let slug = c.slug || null;
    if (!jsonlPath) {
      const f = findSessionFile(claudeHome, sid, includes);
      if (f) { jsonlPath = f.path; mtimeMs = f.mtimeMs; slug = f.slug; }
    }
    // 设了过滤白名单、又找不到匹配的 session 文件 → 跳过（如别的用户的进程）
    if (includes && includes.length && !slug) continue;
    const ev = jsonlPath ? lastContentEvent(jsonlPath) : null;

    // CPU 增量判活
    let cpuActive = false;
    if (proc && proc.jiffies != null) {
      newCpuCache[proc.pid] = proc.jiffies;
      const prev = cpuCache[proc.pid];
      if (prev != null) {
        const dj = proc.jiffies - prev;
        const cpuFrac = dj / CLK_TCK / (elapsedMs / 1000); // 占用核数比例
        if (cpuFrac > 0.15) cpuActive = true;
      }
    }

    const jsonlFresh = mtimeMs != null && (now - mtimeMs) <= activeMs;
    const lastRole = ev ? ev.role : null;
    const lastTs = ev ? ev.ts : (mtimeMs || null);

    // 基线状态判定
    let state;
    if (cpuActive || jsonlFresh) {
      state = 'working';
    } else if (lastRole === 'assistant') {
      state = 'idle';
    } else if (lastRole === 'user') {
      const age = lastTs != null ? now - lastTs : Infinity;
      state = age <= graceMs ? 'working' : 'idle';
    } else {
      state = proc ? 'idle' : 'idle';
    }

    sessions.push({
      sessionId: sid,
      pid: proc ? proc.pid : null,
      alive: !!proc,
      cwd: ev ? ev.cwd : null,
      project: ev && ev.cwd ? path.basename(ev.cwd) : (slug || null),
      title: sessionTitle(jsonlPath),
      gitBranch: ev ? ev.gitBranch : null,
      lastRole,
      lastTs,
      jsonlMtime: mtimeMs || null,
      cpuActive,
      state,
      source: 'heuristic',
    });
  }

  // 回写 cpuCache（原地更新，保留仍存在的 pid）
  for (const k of Object.keys(cpuCache)) delete cpuCache[k];
  Object.assign(cpuCache, newCpuCache);

  // 排序：working > waiting > idle，再按最近活动
  const rank = { working: 0, waiting: 0, done: 1, idle: 2, error: 1 };
  sessions.sort((a, b) => (rank[a.state] - rank[b.state]) || ((b.lastTs || 0) - (a.lastTs || 0)));
  return sessions;
}

// codex 进程的 CPU 快照独立缓存（claude 的 cpuCache 每拍会整体重写，混用会互相清掉）
const codexCpuCache = {};

function scanCodexSessions(opts = {}) {
  const codexHome = opts.codexHome || defaultCodexHome();
  const now = opts.now || Date.now();
  const activeMs = opts.activeMs ?? 4000;
  const graceMs = opts.graceMs ?? 30000;
  const recentDoneMs = opts.recentDoneMs ?? 300000;
  const includes = opts.slugIncludes || null;
  const sourceName = opts.sourceName || 'codex';

  const files = recentCodexSessionFiles(codexHome, recentDoneMs, now, includes);

  // 进程归属：codex 命令行无 session id，用 /proc/<pid>/cwd 对齐到该 cwd 下最新的会话
  const cpuCache = opts.codexCpuCache || codexCpuCache;
  const elapsedMs = Math.max(1, now - (opts.lastScanTs || (now - 1500)));
  const procByCwd = new Map(); // cwd → { pid, cpuActive }
  const newCpu = {};
  for (const pr of scanCodexProcesses(opts.execFn)) {
    if (!pr.cwd) continue;
    let cpuActive = false;
    if (pr.jiffies != null) {
      newCpu[pr.pid] = pr.jiffies;
      const prev = cpuCache[pr.pid];
      if (prev != null && (pr.jiffies - prev) / CLK_TCK / (elapsedMs / 1000) > 0.15) cpuActive = true;
    }
    const cur = procByCwd.get(pr.cwd);
    if (!cur || (cpuActive && !cur.cpuActive)) procByCwd.set(pr.cwd, { pid: pr.pid, cpuActive });
  }
  for (const k of Object.keys(cpuCache)) delete cpuCache[k];
  Object.assign(cpuCache, newCpu);

  const freshestByCwd = new Map(); // cwd → 该目录下 mtime 最新的会话文件
  for (const f of files) {
    const cwd = f.meta && f.meta.cwd;
    if (!cwd) continue;
    const cur = freshestByCwd.get(cwd);
    if (!cur || f.mtimeMs > cur.mtimeMs) freshestByCwd.set(cwd, f);
  }

  const sessions = [];
  for (const f of files) {
    const meta = f.meta || codexSessionMeta(f.path) || {};
    const ev = lastCodexContentEvent(f.path);
    const cwd = meta.cwd || null;
    const proc = (cwd && freshestByCwd.get(cwd) === f) ? procByCwd.get(cwd) : null;
    const cpuActive = !!(proc && proc.cpuActive);
    const jsonlFresh = f.mtimeMs != null && (now - f.mtimeMs) <= activeMs;
    const lastRole = ev ? ev.role : null;
    const lastTs = ev ? ev.ts : (f.mtimeMs || null);
    let state;
    if (cpuActive || jsonlFresh) {
      state = 'working';
    } else if (lastRole === 'assistant') {
      state = 'idle';
    } else if (lastRole === 'user') {
      const age = lastTs != null ? now - lastTs : Infinity;
      state = age <= graceMs ? 'working' : 'idle';
    } else {
      state = 'idle';
    }
    sessions.push({
      sessionId: `${sourceName}:${f.sessionId}`,
      rawSessionId: f.sessionId,
      provider: sourceName,
      pid: proc ? proc.pid : null,
      alive: !!proc,
      cwd,
      project: cwd ? path.basename(cwd) : sourceName,
      title: codexSessionTitle(f.path, codexHome, f.sessionId),
      gitBranch: null,
      lastRole,
      lastTs,
      jsonlMtime: f.mtimeMs || null,
      cpuActive,
      state,
      source: 'heuristic',
    });
  }

  sessions.sort((a, b) => ((b.lastTs || 0) - (a.lastTs || 0)));
  return sessions;
}

function scanAllSessions(opts = {}) {
  const providers = opts.providers || [{
    type: 'claude',
    name: 'claude',
    claudeHome: opts.claudeHome,
    slugIncludes: opts.slugIncludes,
  }];
  const out = [];
  for (const p of providers) {
    const type = p.type || p.name || 'claude';
    const common = { ...opts, slugIncludes: p.slugIncludes ?? opts.slugIncludes };
    if (type === 'codex') {
      out.push(...scanCodexSessions({ ...common, codexHome: p.codexHome, sourceName: p.name || 'codex' }));
    } else {
      out.push(...scanSessions({ ...common, claudeHome: p.claudeHome || opts.claudeHome }));
    }
  }
  return out;
}

module.exports = {
  scanAllSessions,
  scanSessions,
  scanCodexSessions,
  scanProcesses,
  scanCodexProcesses,
  lastContentEvent,
  lastCodexContentEvent,
  findSessionFile,
  recentSessionFiles,
  recentCodexSessionFiles,
  readJiffies,
  defaultClaudeHome,
  defaultCodexHome,
  slugMatches,
  cwdToSlug,
  sessionTitle,
  codexSessionTitle,
};

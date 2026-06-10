'use strict';
/*
 * collector.js — 采集 Claude Code 各 session 的运行信号，产出每 session 的基线状态。
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

module.exports = {
  scanSessions,
  scanProcesses,
  lastContentEvent,
  findSessionFile,
  recentSessionFiles,
  readJiffies,
  defaultClaudeHome,
  slugMatches,
  cwdToSlug,
  sessionTitle,
};

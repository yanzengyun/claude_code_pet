'use strict';
/*
 * connector.js — SSH 自动连接器（跑在 Electron main 进程）。
 *
 * 职责：让「填机器+端口」之后一切自动 ——
 *   1. 自动 SSH 隧道（-N -L localPort:127.0.0.1:remotePort）
 *   2. 远端没有 agent → 自动部署（scp 零依赖 agent 到 ~/.cc-pet-agent）并拉起
 *   3. 掉线/睡眠唤醒自愈（指数退避，封顶 30s）
 *   4. hooks 管理：状态检测自动（只读），安装/卸载必须用户在 UI 上显式确认后才执行
 *
 * 安全边界：
 *   • BatchMode=yes —— 只依赖已有 SSH 免密，绝不提示/存储密码
 *   • 远端只执行固定模板命令（部署目录固定 ~/.cc-pet-agent），不开任意命令口子
 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REMOTE_DIR = '~/.cc-pet-agent';
const AGENT_FILES = ['server.js', 'collector.js', 'state.js', 'start.sh', 'stop.sh'];
const HOOK_FILES = ['cc-pet-notify.sh', 'install-hooks.sh', 'uninstall-hooks.sh'];
const SSH_OPTS = [
  '-o', 'BatchMode=yes',
  '-o', 'ConnectTimeout=6',
  '-o', 'StrictHostKeyChecking=accept-new',
];

let cfg = null;          // { enabled, sshHost, remotePort, localPort, slugIncludes[] }
let sshProc = null;      // 隧道进程
let retryTimer = null;
let retryDelay = 1000;
let ensuring = false;
let phase = 'disabled';  // disabled|probing|tunneling|deploying|starting|connected|failed
let onPhase = () => {};

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** 打包后的 GUI 应用 PATH 不全，优先用系统绝对路径 */
function bin(name) {
  const abs = `/usr/bin/${name}`;
  try { if (fs.existsSync(abs)) return abs; } catch {}
  return name;
}

function setPhase(p, detail) {
  phase = p;
  try { onPhase(p, detail || ''); } catch {}
}

function probeHealth(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 2500 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

/** 在远端执行一条命令（args 拼成 remote shell 命令），20s 超时 */
function runSsh(command, { input, timeoutMs = 20000 } = {}) {
  return new Promise((resolve) => {
    const p = spawn(bin('ssh'), [...SSH_OPTS, cfg.sshHost, command], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    if (input != null) p.stdin.end(input); else p.stdin.end();
    const t = setTimeout(() => { try { p.kill(); } catch {} }, timeoutMs);
    p.on('close', (code) => { clearTimeout(t); resolve({ code, out, err }); });
    p.on('error', (e) => { clearTimeout(t); resolve({ code: -1, out, err: String(e) }); });
  });
}

function runScp(localFiles, remoteRelDir) {
  return new Promise((resolve) => {
    const p = spawn(bin('scp'), ['-q', ...SSH_OPTS, ...localFiles, `${cfg.sshHost}:${remoteRelDir}`],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    const t = setTimeout(() => { try { p.kill(); } catch {} }, 30000);
    p.on('close', (code) => { clearTimeout(t); resolve({ code, err }); });
    p.on('error', (e) => { clearTimeout(t); resolve({ code: -1, err: String(e) }); });
  });
}

// ---------- 部署 ----------
/** 找 agent/hooks 源文件目录（仓库内运行 or 打包后的 extraResources） */
function srcDirs() {
  const bases = [path.join(__dirname, '..'), process.resourcesPath || ''];
  for (const b of bases) {
    if (b && fs.existsSync(path.join(b, 'agent', 'server.js'))) {
      return { agent: path.join(b, 'agent'), hooks: path.join(b, 'hooks') };
    }
  }
  return null;
}

function remoteAgentConfig() {
  return {
    port: cfg.remotePort,
    host: '127.0.0.1',
    token: '',
    slugIncludes: cfg.slugIncludes.length ? cfg.slugIncludes : null,
    providers: [
      { type: 'claude', name: 'claude' },
      { type: 'codex', name: 'codex' },
    ],
  };
}

/** 版本指纹 = 源文件内容 + 远端配置；任一变化都会触发重新部署 */
function localVersion(src) {
  const h = crypto.createHash('sha1');
  for (const f of AGENT_FILES) h.update(fs.readFileSync(path.join(src.agent, f)));
  for (const f of HOOK_FILES) h.update(fs.readFileSync(path.join(src.hooks, f)));
  h.update(JSON.stringify(remoteAgentConfig()));
  return h.digest('hex');
}

async function deployIfNeeded(force = false) {
  const src = srcDirs();
  if (!src) return { ok: false, err: '找不到 agent/hooks 源文件' };
  let ver;
  try { ver = localVersion(src); } catch (e) { return { ok: false, err: `读源文件失败: ${e.message}` }; }

  if (!force) {
    const r = await runSsh(`cat ${REMOTE_DIR}/.version 2>/dev/null || true`);
    if (r.code !== 0) return { ok: false, err: (r.err || 'ssh 连接失败').trim().slice(0, 160) };
    if (r.out.trim() === ver) return { ok: true, skipped: true };
  }

  let r = await runSsh(`mkdir -p ${REMOTE_DIR}/hooks ~/.cc-pet`);
  if (r.code !== 0) return { ok: false, err: r.err.trim().slice(0, 160) };

  r = await runScp(AGENT_FILES.map((f) => path.join(src.agent, f)), '.cc-pet-agent/');
  if (r.code !== 0) return { ok: false, err: `scp agent 失败: ${r.err.trim().slice(0, 120)}` };
  r = await runScp(HOOK_FILES.map((f) => path.join(src.hooks, f)), '.cc-pet-agent/hooks/');
  if (r.code !== 0) return { ok: false, err: `scp hooks 失败: ${r.err.trim().slice(0, 120)}` };

  r = await runSsh(`cat > ${REMOTE_DIR}/config.json`, { input: JSON.stringify(remoteAgentConfig(), null, 2) + '\n' });
  if (r.code !== 0) return { ok: false, err: `写配置失败: ${r.err.trim().slice(0, 120)}` };

  r = await runSsh(`chmod +x ${REMOTE_DIR}/*.sh ${REMOTE_DIR}/hooks/*.sh && printf '%s' '${ver}' > ${REMOTE_DIR}/.version`);
  if (r.code !== 0) return { ok: false, err: r.err.trim().slice(0, 160) };
  return { ok: true };
}

// ---------- 隧道 ----------
function startTunnel() {
  if (sshProc) return;
  setPhase('tunneling');
  sshProc = spawn(bin('ssh'), [
    ...SSH_OPTS,
    '-N',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=2',
    '-L', `${cfg.localPort}:127.0.0.1:${cfg.remotePort}`,
    cfg.sshHost,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  sshProc.stderr.on('data', (d) => { err += d; });
  sshProc.on('exit', () => {
    sshProc = null;
    // 端口被占（已有手动隧道）也会走到这里：下一轮 ensure 探测健康即可正常工作
    if (cfg && cfg.enabled) scheduleEnsure(err.trim().slice(0, 120));
  });
  sshProc.on('error', () => { sshProc = null; });
}

function stopTunnel() {
  if (sshProc) { try { sshProc.kill(); } catch {} sshProc = null; }
}

// ---------- 主状态机 ----------
function scheduleEnsure(why, delay) {
  if (!cfg || !cfg.enabled) return;
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => ensure(why), delay ?? retryDelay);
  retryDelay = Math.min(retryDelay * 2, 30000);
}

async function ensure(why) {
  if (!cfg || !cfg.enabled || ensuring) return;
  ensuring = true;
  try {
    setPhase('probing');
    if (await probeHealth(cfg.localPort)) { ok(); return; }

    startTunnel();
    await sleep(1800);
    if (await probeHealth(cfg.localPort)) { ok(); return; }

    // 隧道有了但 agent 不在（或 ssh 失败 —— 下面的部署/启动会把 stderr 透出来）
    setPhase('deploying');
    const dep = await deployIfNeeded();
    if (!dep.ok) { fail(dep.err); return; }

    setPhase('starting');
    const url = `http://127.0.0.1:${cfg.remotePort}`;
    const st = await runSsh(
      `bash ${REMOTE_DIR}/start.sh; ` +
      `grep -qxF '${url}' ~/.cc-pet/agents.list 2>/dev/null || echo '${url}' >> ~/.cc-pet/agents.list`);
    if (st.code !== 0) { fail(`远端启动失败: ${(st.err || st.out).trim().slice(0, 160)}`); return; }

    for (let i = 0; i < 6; i++) {
      await sleep(1000);
      if (await probeHealth(cfg.localPort)) { ok(); return; }
    }
    fail('agent 启动后健康检查未通过');
  } finally {
    ensuring = false;
  }
}

function ok() { retryDelay = 1000; setPhase('connected'); }
function fail(msg) { setPhase('failed', msg); scheduleEnsure(msg); }

// ---------- hooks 管理（检测只读自动；安装/卸载由 UI 显式确认后调用） ----------
async function hooksStatus() {
  if (!cfg || !cfg.sshHost) return { status: 'disabled' };
  const py = [
    'import json,os',
    "p=os.path.expanduser('~/.claude/settings.json')",
    'try:',
    ' d=json.load(open(p))',
    'except Exception:',
    " print('none'); raise SystemExit",
    "h=d.get('hooks',{})",
    "f=lambda ev:any('cc-pet-notify' in (x.get('command') or '') for e in h.get(ev,[]) for x in (e.get('hooks') or []))",
    "print(('full' if f('PreToolUse') else 'basic') if f('Stop') else 'none')",
  ].join('\n');
  const b64 = Buffer.from(py).toString('base64');
  const r = await runSsh(`echo ${b64} | base64 -d | python3`);
  if (r.code !== 0) return { status: 'error', err: (r.err || '').trim().slice(0, 120) };
  const s = r.out.trim().split('\n').pop();
  return { status: ['none', 'basic', 'full'].includes(s) ? s : 'error' };
}

async function hooksInstall() {
  const dep = await deployIfNeeded();
  if (!dep.ok) return { ok: false, msg: dep.err };
  const r = await runSsh(`bash ${REMOTE_DIR}/hooks/install-hooks.sh --apply --with-tools`, { timeoutMs: 30000 });
  return { ok: r.code === 0, msg: (r.code === 0 ? r.out : r.err || r.out).trim().slice(-300) };
}

async function hooksUninstall() {
  const dep = await deployIfNeeded();
  if (!dep.ok) return { ok: false, msg: dep.err };
  const r = await runSsh(`bash ${REMOTE_DIR}/hooks/uninstall-hooks.sh --apply`, { timeoutMs: 30000 });
  return { ok: r.code === 0, msg: (r.code === 0 ? r.out : r.err || r.out).trim().slice(-300) };
}

/** 托盘「停止远端 agent」 */
async function agentStop() {
  const r = await runSsh(`bash ${REMOTE_DIR}/stop.sh 2>/dev/null || true; bash -c 'f=/tmp/cc-pet-agent-${cfg.remotePort}.pid; [ -f "$f" ] && kill $(cat "$f") 2>/dev/null && rm -f "$f" && echo stopped || true'`);
  return { ok: r.code === 0, msg: (r.out + r.err).trim().slice(0, 160) };
}

// ---------- 对外 ----------
function init(handlers = {}) { if (handlers.onPhase) onPhase = handlers.onPhase; }

function configure(next) {
  clearTimeout(retryTimer);
  stopTunnel();
  cfg = next;
  retryDelay = 1000;
  if (cfg && cfg.enabled) {
    scheduleEnsure('configure', 300);
  } else {
    setPhase('disabled');
  }
}

/** 外部信号（SSE 掉线 / 系统唤醒 / 手动重连）→ 快速重跑状态机 */
function poke() {
  if (!cfg || !cfg.enabled) return;
  clearTimeout(retryTimer);
  retryDelay = 1000;
  retryTimer = setTimeout(() => ensure('poke'), 500);
}

function shutdown() {
  clearTimeout(retryTimer);
  stopTunnel();
}

function getPhase() { return phase; }

module.exports = {
  init, configure, poke, shutdown, getPhase,
  hooksStatus, hooksInstall, hooksUninstall, agentStop,
};

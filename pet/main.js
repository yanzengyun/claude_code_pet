'use strict';
/*
 * main.js — Claude 桌宠 Electron 主进程。
 *  • 透明 / 无边框 / 置顶 / 不占任务栏的小窗，渲染 Claude 小人
 *  • 托盘菜单：显示隐藏 / 登录 vibe / 打开配置 / 退出
 *  • renderer 状态变化 → 系统通知 + 可选提示音（waiting/done）
 */
const { app, BrowserWindow, Tray, Menu, Notification, ipcMain, screen, shell, nativeImage, utilityProcess, powerMonitor, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const cp = require('child_process');
const connector = require('./connector.js');

// ---------- 配置 ----------
const DEFAULT_CFG = {
  primary: { name: 'vibe', url: 'http://127.0.0.1:47600', token: '' },
  sources: null,                 // [{name,url,token,enabled}]；null → 由 primary 生成
  monitor: 'remote',             // 监控目标：'remote'（vibe）| 'local'（本机），二选一
  skin: 'claude',                // 皮肤：'claude'（官方小人）| 'squirtle'（像素小蓝龟）
  // SSH 自动连接：标准模式填机器+端口（可自动部署）；vibe 模式只填用户名 ——
  // 连共享 agent（固定端口，平台侧 cron 保活），订阅时带 slug 服务端按人过滤
  remote: {
    autoConnect: false, mode: 'standard', sshHost: '', remotePort: 47600, localPort: null,
    slugIncludes: '', vibeUser: '', vibeHost: 'l-picservice4.tj.cn5', vibePort: 47888,
  },
  localMonitor: { enabled: false, port: 47601 }, // 内置 agent 监控本机 ~/.claude
  soundOnWaiting: true,
  soundOnDone: false,
  notifyOnWaiting: true,
  notifyOnDone: true,
  ssoOrigin: '',                 // 代理模式需登录的站点，如 https://vibe.corp.tujia.com
  window: { width: 168, height: 210 },
};
function userCfgPath() { return path.join(os.homedir(), '.cc-pet', 'config.json'); }
function loadConfig() {
  let c = { ...DEFAULT_CFG };
  for (const p of [userCfgPath(), path.join(__dirname, 'config.json')]) {
    try { c = { ...DEFAULT_CFG, ...JSON.parse(fs.readFileSync(p, 'utf8')) }; break; } catch {}
  }
  // 归一化：旧版只有 primary → 转成 sources
  if (!Array.isArray(c.sources) || !c.sources.length) {
    c.sources = [{ enabled: true, ...(c.primary || DEFAULT_CFG.primary) }];
  }
  c.sources = c.sources.map((s) => ({ name: 'vibe', url: '', token: '', enabled: true, ...s }));
  c.localMonitor = { ...DEFAULT_CFG.localMonitor, ...(c.localMonitor || {}) };
  // monitor 二选一；旧配置只有 localMonitor.enabled 时按它推断
  if (c.monitor !== 'local' && c.monitor !== 'remote') {
    c.monitor = c.localMonitor.enabled ? 'local' : 'remote';
  }
  c.remote = { ...DEFAULT_CFG.remote, ...(c.remote || {}) };
  return c;
}

/** 给 connector 的配置（vibe 模式只凭用户名：连共享 agent，订阅时按 slug 过滤） */
function connectorCfg() {
  const r = cfg.remote;
  if (r.mode === 'vibe') {
    const u = String(r.vibeUser || '').trim();
    const port = parseInt(r.vibePort, 10) || 47888;
    return {
      enabled: cfg.monitor !== 'local' && !!r.autoConnect && !!u,
      sshHost: `${u}@${String(r.vibeHost || 'l-picservice4.tj.cn5').trim()}`,
      remotePort: port,
      localPort: port,
      slugIncludes: [`-home-q-vibe-projects-${u}`],
      tunnelOnly: true, // 共享 agent 由平台侧 cron 保活，客户端不部署
    };
  }
  const remotePort = parseInt(r.remotePort, 10) || 47600;
  return {
    enabled: cfg.monitor !== 'local' && !!r.autoConnect && !!String(r.sshHost || '').trim(),
    sshHost: String(r.sshHost || '').trim(),
    remotePort,
    localPort: parseInt(r.localPort, 10) || remotePort,
    slugIncludes: String(r.slugIncludes || '').split(',').map((s) => s.trim()).filter(Boolean),
    tunnelOnly: false,
  };
}

/** 自动连接是否生效 */
function autoConnectOn() { return connectorCfg().enabled; }
let cfg = loadConfig();

/** 渲染层实际要订阅的源：按监控目标二选一（vibe 远程 或 本机内置 agent） */
function effectiveSources() {
  if (cfg.monitor === 'local') {
    return [{ name: '本机', url: `http://127.0.0.1:${cfg.localMonitor.port || 47601}`, token: '' }];
  }
  if (autoConnectOn()) {
    const c = connectorCfg();
    const r = cfg.remote;
    const name = r.mode === 'vibe' ? r.vibeUser : (c.sshHost.split('@').pop() || 'remote').split('.')[0];
    // vibe 模式：订阅共享 agent 时带上自己的 slug，服务端按人过滤
    const slug = r.mode === 'vibe' ? `-home-q-vibe-projects-${r.vibeUser}` : '';
    return [{ name, url: `http://127.0.0.1:${c.localPort}`, token: '', slug }];
  }
  return cfg.sources.filter((s) => s.enabled !== false && s.url);
}

/** 读用户配置 → 打补丁 → 写回 → 整体生效 */
function saveUserPatch(patch) {
  let user = {};
  try { user = JSON.parse(fs.readFileSync(userCfgPath(), 'utf8')); } catch {}
  Object.assign(user, patch);
  try {
    fs.mkdirSync(path.dirname(userCfgPath()), { recursive: true });
    fs.writeFileSync(userCfgPath(), JSON.stringify(user, null, 2));
  } catch {}
  applyConfig();
}

/** 切换监控目标并持久化到用户配置 */
function setMonitor(m) {
  let user = {};
  try { user = JSON.parse(fs.readFileSync(userCfgPath(), 'utf8')); } catch {}
  saveUserPatch({ monitor: m, localMonitor: { ...(user.localMonitor || {}), enabled: m === 'local' } });
}

let win = null, tray = null, loginWin = null, settingsWin = null;
let lastPet = null;

// ---------- 内置本地 agent（监控本机 ~/.claude） ----------
let localAgent = null;
function agentServerPath() {
  const candidates = [
    path.join(__dirname, '..', 'agent', 'server.js'),                       // 仓库内运行
    path.join(process.resourcesPath || '', 'agent', 'server.js'),           // 打包后 extraResources
  ];
  return candidates.find((p) => { try { return fs.existsSync(p); } catch { return false; } }) || null;
}
function stopLocalAgent() {
  if (localAgent) { try { localAgent.kill(); } catch {} localAgent = null; }
}
function startLocalAgent() {
  stopLocalAgent();
  if (cfg.monitor !== 'local') return;
  const serverPath = agentServerPath();
  if (!serverPath) { notify('Claude Pet', '未找到内置 agent（agent/server.js），本地监控不可用', true); return; }
  const env = {
    ...process.env,
    CC_PET_PORT: String(cfg.localMonitor.port || 47601),
    CC_PET_HOST: '127.0.0.1',
    // 本地 agent 用独立配置文件（不存在则全默认：监控本机全部项目）
    CC_PET_CONFIG: path.join(os.homedir(), '.cc-pet', 'local-agent.json'),
  };
  try {
    if (utilityProcess && utilityProcess.fork) {
      localAgent = utilityProcess.fork(serverPath, [], { env, stdio: 'ignore' });
    } else {
      localAgent = cp.fork(serverPath, [], { env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'ignore' });
    }
  } catch (e) {
    localAgent = null;
    notify('Claude Pet', `本地 agent 启动失败：${e.message}`, true);
  }
}

// ---------- 主窗口 ----------
function createWindow() {
  const wa = screen.getPrimaryDisplay().workArea;
  const w = cfg.window.width, h = cfg.window.height;
  win = new BrowserWindow({
    width: w, height: h,
    x: wa.x + wa.width - w - 24,
    y: wa.y + wa.height - h - 24,
    transparent: true,
    frame: false,
    resizable: false,
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      additionalArguments: ['--pet-config=' + Buffer.from(JSON.stringify(cfg)).toString('base64')],
    },
  });
  win.setAlwaysOnTop(true, 'floating');
  if (process.platform === 'darwin') win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

// ---------- 托盘 ----------
function trayIcon() {
  const p = path.join(__dirname, 'assets', 'tray.png');
  try {
    const img = nativeImage.createFromPath(p);
    if (!img.isEmpty()) { if (process.platform === 'darwin') img.setTemplateImage(false); return img; }
  } catch {}
  // 兜底：1x1 占位，避免崩
  return nativeImage.createEmpty();
}
const CONN_PHASE_LABEL = {
  disabled: '', probing: '探测中…', tunneling: 'SSH 隧道连接中…',
  deploying: '部署远端 agent…', starting: '启动远端 agent…',
  connected: '✓ 已连接', failed: '✗ 连接失败',
};
let connPhase = 'disabled', connDetail = '';

function makeMenu() {
  const srcLines = effectiveSources().map((s) => ({ label: `源：${s.name} (${s.url})`, enabled: false }));
  if (!srcLines.length) srcLines.push({ label: '源：（未配置）', enabled: false });
  if (autoConnectOn()) {
    srcLines.push({ label: `自动连接：${CONN_PHASE_LABEL[connPhase] || connPhase}${connDetail ? ' · ' + connDetail.slice(0, 40) : ''}`, enabled: false });
    srcLines.push({ label: '立即重连', click: () => connector.poke() });
    srcLines.push({
      label: '停止远端 agent',
      click: async () => {
        const { response } = await dialog.showMessageBox({
          type: 'question', buttons: ['取消', '停止'], defaultId: 0, cancelId: 0,
          message: '停止远端 agent？', detail: '桌宠将离线；下次连接时会自动重新拉起。',
        });
        if (response === 1) { const r = await connector.agentStop(); notify('Claude Pet', r.ok ? '远端 agent 已停止' : `停止失败：${r.msg}`, true); }
      },
    });
  }
  return Menu.buildFromTemplate([
    { label: '显示 / 隐藏', click: () => { if (win.isVisible()) win.hide(); else win.show(); } },
    { type: 'separator' },
    { label: '监控 vibe（远程）', type: 'radio', checked: cfg.monitor !== 'local', click: () => setMonitor('remote') },
    { label: '监控本机（~/.claude）', type: 'radio', checked: cfg.monitor === 'local', click: () => setMonitor('local') },
    { type: 'separator' },
    { label: '皮肤：Claude 小人', type: 'radio', checked: cfg.skin !== 'squirtle', click: () => saveUserPatch({ skin: 'claude' }) },
    { label: '皮肤：像素小蓝龟', type: 'radio', checked: cfg.skin === 'squirtle', click: () => saveUserPatch({ skin: 'squirtle' }) },
    { type: 'separator' },
    ...srcLines,
    { label: '设置…', click: openSettings },
    { label: '登录 vibe（代理连接用）', visible: !!cfg.ssoOrigin, click: openLogin },
    { label: '打开配置文件', click: openConfig },
    { label: '重新加载', click: applyConfig },
    { type: 'separator' },
    { label: '退出', click: () => { app.quit(); } },
  ]);
}
function buildTray() {
  tray = new Tray(trayIcon());
  tray.setToolTip('Claude Pet');
  tray.setContextMenu(makeMenu());
  tray.on('click', () => { if (win) (win.isVisible() ? win.focus() : win.show()); });
}

/** 重读配置并整体生效：本地 agent、自动连接器、托盘菜单、桌宠窗口 */
function applyConfig() {
  cfg = loadConfig();
  startLocalAgent();
  connector.configure(connectorCfg());
  if (tray) tray.setContextMenu(makeMenu());
  if (win) win.reload();
}

// ---------- 设置窗口（图形化配置） ----------
function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.focus(); return; }
  settingsWin = new BrowserWindow({
    width: 460, height: 870, title: 'Claude Pet 设置',
    resizable: false, minimizable: false, maximizable: false, fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, 'settings-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  settingsWin.setMenuBarVisibility(false);
  settingsWin.loadFile(path.join(__dirname, 'renderer', 'settings.html'));
  settingsWin.on('closed', () => { settingsWin = null; });
}
ipcMain.handle('settings-get', () => cfg);
ipcMain.handle('settings-save', (_e, next) => {
  const p = userCfgPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  // 只接受白名单字段，避免写入意外内容
  const clean = {
    sources: (Array.isArray(next.sources) ? next.sources : []).map((s) => ({
      name: String(s.name || 'vibe'), url: String(s.url || ''),
      token: String(s.token || ''), enabled: s.enabled !== false,
    })),
    monitor: next.monitor === 'local' ? 'local' : 'remote',
    skin: next.skin === 'squirtle' ? 'squirtle' : 'claude',
    remote: {
      autoConnect: !!(next.remote && next.remote.autoConnect),
      mode: (next.remote && next.remote.mode) === 'vibe' ? 'vibe' : 'standard',
      sshHost: String((next.remote && next.remote.sshHost) || '').trim(),
      remotePort: parseInt(next.remote && next.remote.remotePort, 10) || 47600,
      localPort: parseInt(next.remote && next.remote.localPort, 10) || null,
      slugIncludes: String((next.remote && next.remote.slugIncludes) || '').trim(),
      vibeUser: String((next.remote && next.remote.vibeUser) || '').trim(),
      vibeHost: String((next.remote && next.remote.vibeHost) || 'l-picservice4.tj.cn5').trim(),
      vibePort: parseInt(next.remote && next.remote.vibePort, 10) || 47888,
    },
    localMonitor: {
      enabled: next.monitor === 'local',
      port: parseInt(next.localMonitor && next.localMonitor.port, 10) || 47601,
    },
    soundOnWaiting: !!next.soundOnWaiting,
    soundOnDone: !!next.soundOnDone,
    notifyOnWaiting: !!next.notifyOnWaiting,
    notifyOnDone: !!next.notifyOnDone,
    ssoOrigin: String(next.ssoOrigin || ''),
    window: cfg.window,
  };
  fs.writeFileSync(p, JSON.stringify(clean, null, 2));
  applyConfig();
  return { ok: true };
});
ipcMain.handle('pet-config-get', () => ({ ...cfg, sources: effectiveSources() }));

// ---------- hooks 管理（检测只读；安装/卸载由设置窗口确认后调用） ----------
ipcMain.handle('hooks-status', () => connector.hooksStatus());
ipcMain.handle('hooks-install', () => connector.hooksInstall());
ipcMain.handle('hooks-uninstall', () => connector.hooksUninstall());

// ---------- 本机 hooks（监控本机模式用；改的是本机 ~/.claude/settings.json） ----------
function localHooksDir() {
  const bases = [path.join(__dirname, '..'), process.resourcesPath || ''];
  for (const b of bases) {
    if (b && fs.existsSync(path.join(b, 'hooks', 'install-hooks.sh'))) return path.join(b, 'hooks');
  }
  return null;
}
function localHooksStatus() {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8'));
    const h = d.hooks || {};
    const has = (ev) => (h[ev] || []).some((e) => (e.hooks || []).some((x) => (x.command || '').includes('cc-pet-notify')));
    return { status: has('Stop') ? (has('PreToolUse') ? 'full' : 'basic') : 'none' };
  } catch {
    return { status: 'none' };
  }
}
/** 把本机 agent 注册进 hook 广播列表（幂等），否则事件会发去 47600 被远端拒收 */
function registerLocalAgentUrl() {
  try {
    const lp = path.join(os.homedir(), '.cc-pet', 'agents.list');
    fs.mkdirSync(path.dirname(lp), { recursive: true });
    const url = `http://127.0.0.1:${cfg.localMonitor.port || 47601}`;
    const cur = fs.existsSync(lp) ? fs.readFileSync(lp, 'utf8') : '';
    if (!cur.split('\n').map((s) => s.trim()).includes(url)) fs.appendFileSync(lp, url + '\n');
  } catch {}
}
function runLocalHooksScript(script) {
  const dir = localHooksDir();
  if (!dir) return Promise.resolve({ ok: false, msg: '找不到 hooks 脚本目录' });
  return new Promise((resolve) => {
    cp.execFile('bash', [path.join(dir, script), '--apply', ...(script.startsWith('install') ? ['--with-tools'] : [])],
      { timeout: 30000 }, (err, out, errout) => {
        resolve({ ok: !err, msg: String(err ? (errout || out || err.message) : out).trim().slice(-300) });
      });
  });
}
ipcMain.handle('local-hooks-status', () => localHooksStatus());
ipcMain.handle('local-hooks-install', async () => {
  const r = await runLocalHooksScript('install-hooks.sh');
  if (r.ok) registerLocalAgentUrl();
  return r;
});
ipcMain.handle('local-hooks-uninstall', () => runLocalHooksScript('uninstall-hooks.sh'));

// ---------- 面板开合：窗口向小人旁边扩展（默认右侧，贴屏幕边时换左侧） ----------
const PANEL_W = 240, PANEL_H_EXTRA = 110;
let panelOpen = false, panelSide = 'right';
ipcMain.handle('pet-panel', (_e, open) => {
  if (!win) return { side: panelSide };
  const w0 = cfg.window.width, h0 = cfg.window.height;
  const b = win.getBounds();
  if (open && !panelOpen) {
    panelOpen = true;
    const wa = screen.getDisplayMatching(b).workArea;
    panelSide = (b.x + w0 + PANEL_W <= wa.x + wa.width) ? 'right' : 'left';
    win.setResizable(true);
    win.setBounds({
      x: panelSide === 'left' ? b.x - PANEL_W : b.x,
      y: Math.max(wa.y, b.y - PANEL_H_EXTRA),
      width: w0 + PANEL_W, height: h0 + PANEL_H_EXTRA,
    });
    win.setResizable(false);
  } else if (!open && panelOpen) {
    panelOpen = false;
    win.setResizable(true);
    win.setBounds({
      x: panelSide === 'left' ? b.x + PANEL_W : b.x,
      y: b.y + PANEL_H_EXTRA,
      width: w0, height: h0,
    });
    win.setResizable(false);
  }
  return { side: panelSide };
});

// ---------- SSO 登录窗（代理模式） ----------
function openLogin() {
  if (!cfg.ssoOrigin) return;
  if (loginWin && !loginWin.isDestroyed()) { loginWin.focus(); return; }
  loginWin = new BrowserWindow({
    width: 980, height: 760, title: '登录 vibe（登录后关闭本窗口即可）',
    webPreferences: { partition: undefined }, // 用默认 session，cookie 与桌宠共享
  });
  loginWin.loadURL(cfg.ssoOrigin);
  loginWin.on('closed', () => { loginWin = null; if (win) win.reload(); });
}

function openConfig() {
  const p = userCfgPath();
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    if (!fs.existsSync(p)) fs.writeFileSync(p, JSON.stringify(DEFAULT_CFG, null, 2));
  } catch {}
  shell.openPath(p);
}

// ---------- 状态 → 通知 / 提示音 ----------
function playSound(name) {
  if (process.platform !== 'darwin') return;
  const file = `/System/Library/Sounds/${name}.aiff`;
  try { cp.spawn('afplay', [file], { stdio: 'ignore', detached: true }).unref(); } catch {}
}
function notify(title, body, silent) {
  if (!Notification.isSupported()) return;
  try { new Notification({ title, body, silent }).show(); } catch {}
}
ipcMain.on('pet-state', (_e, s) => {
  const pet = s && s.pet;
  if (pet === 'offline') connector.poke(); // SSE 掉线 → 触发自动重连
  if (!pet || pet === lastPet) { lastPet = pet; return; }
  const prev = lastPet; lastPet = pet;
  if (pet === 'waiting') {
    if (cfg.notifyOnWaiting) notify('Claude 需要你', s.reason || '正在等待你的操作', !cfg.soundOnWaiting);
    if (cfg.soundOnWaiting) playSound('Glass');
  } else if (pet === 'done' && prev === 'working') {
    if (cfg.notifyOnDone) notify('Claude 完成', s.reason || '任务完成', !cfg.soundOnDone);
    if (cfg.soundOnDone) playSound('Tink');
  }
});
ipcMain.on('pet-ignore-mouse', (_e, ignore) => { if (win) win.setIgnoreMouseEvents(!!ignore, { forward: true }); });
ipcMain.on('pet-move-by', (_e, d) => {
  if (!win || !d) return;
  const [x, y] = win.getPosition();
  win.setPosition(x + (d.dx | 0), y + (d.dy | 0));
});

// ---------- 生命周期 ----------
app.whenReady().then(() => {
  if (process.platform === 'darwin' && app.dock) app.dock.hide(); // 不在 Dock 显示
  startLocalAgent();
  connector.init({
    onPhase: (p, detail) => {
      connPhase = p; connDetail = detail || '';
      if (tray) tray.setContextMenu(makeMenu());
      if (win && !win.isDestroyed()) win.webContents.send('connector-status', { phase: p, detail: connDetail });
    },
  });
  connector.configure(connectorCfg());
  powerMonitor.on('resume', () => connector.poke()); // 睡眠唤醒 → 立即重连
  createWindow();
  buildTray();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', (e) => { e.preventDefault(); }); // 托盘常驻，不随窗口关闭退出
app.on('will-quit', () => { stopLocalAgent(); connector.shutdown(); }); // 隧道随退出回收；远端 agent 保持常驻

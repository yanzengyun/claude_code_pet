'use strict';
/*
 * main.js — Claude 桌宠 Electron 主进程。
 *  • 透明 / 无边框 / 置顶 / 不占任务栏的小窗，渲染 Claude 小人
 *  • 托盘菜单：显示隐藏 / 登录 vibe / 打开配置 / 退出
 *  • renderer 状态变化 → 系统通知 + 可选提示音（waiting/done）
 */
const { app, BrowserWindow, Tray, Menu, Notification, ipcMain, screen, shell, nativeImage, utilityProcess } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const cp = require('child_process');

// ---------- 配置 ----------
const DEFAULT_CFG = {
  primary: { name: 'vibe', url: 'http://127.0.0.1:47600', token: '' },
  sources: null,                 // [{name,url,token,enabled}]；null → 由 primary 生成
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
  return c;
}
let cfg = loadConfig();

/** 渲染层实际要订阅的源：启用的远程源 + （开了本地监控时）内置本地 agent */
function effectiveSources() {
  const list = cfg.sources.filter((s) => s.enabled !== false && s.url);
  if (cfg.localMonitor.enabled) {
    list.push({ name: '本机', url: `http://127.0.0.1:${cfg.localMonitor.port || 47601}`, token: '' });
  }
  return list;
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
  if (!cfg.localMonitor.enabled) return;
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
function makeMenu() {
  const srcLines = effectiveSources().map((s) => ({ label: `源：${s.name} (${s.url})`, enabled: false }));
  if (!srcLines.length) srcLines.push({ label: '源：（未配置）', enabled: false });
  return Menu.buildFromTemplate([
    { label: '显示 / 隐藏', click: () => { if (win.isVisible()) win.hide(); else win.show(); } },
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

/** 重读配置并整体生效：本地 agent、托盘菜单、桌宠窗口 */
function applyConfig() {
  cfg = loadConfig();
  startLocalAgent();
  if (tray) tray.setContextMenu(makeMenu());
  if (win) win.reload();
}

// ---------- 设置窗口（图形化配置） ----------
function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.focus(); return; }
  settingsWin = new BrowserWindow({
    width: 440, height: 640, title: 'Claude Pet 设置',
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
    localMonitor: {
      enabled: !!(next.localMonitor && next.localMonitor.enabled),
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
  createWindow();
  buildTray();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', (e) => { e.preventDefault(); }); // 托盘常驻，不随窗口关闭退出
app.on('will-quit', stopLocalAgent);

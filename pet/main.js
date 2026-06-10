'use strict';
/*
 * main.js — Claude 桌宠 Electron 主进程。
 *  • 透明 / 无边框 / 置顶 / 不占任务栏的小窗，渲染 Claude 小人
 *  • 托盘菜单：显示隐藏 / 登录 vibe / 打开配置 / 退出
 *  • renderer 状态变化 → 系统通知 + 可选提示音（waiting/done）
 */
const { app, BrowserWindow, Tray, Menu, Notification, ipcMain, screen, shell, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const cp = require('child_process');

// ---------- 配置 ----------
const DEFAULT_CFG = {
  primary: { name: 'local', url: 'http://127.0.0.1:47600', token: '' },
  soundOnWaiting: true,
  soundOnDone: false,
  notifyOnWaiting: true,
  notifyOnDone: true,
  ssoOrigin: '',                 // 代理模式需登录的站点，如 https://vibe.corp.tujia.com
  window: { width: 168, height: 210 },
};
function userCfgPath() { return path.join(os.homedir(), '.cc-pet', 'config.json'); }
function loadConfig() {
  for (const p of [userCfgPath(), path.join(__dirname, 'config.json')]) {
    try { return { ...DEFAULT_CFG, ...JSON.parse(fs.readFileSync(p, 'utf8')) }; } catch {}
  }
  return { ...DEFAULT_CFG };
}
let cfg = loadConfig();

let win = null, tray = null, loginWin = null;
let lastPet = null;

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
function buildTray() {
  tray = new Tray(trayIcon());
  tray.setToolTip('Claude Pet');
  const menu = Menu.buildFromTemplate([
    { label: '显示 / 隐藏', click: () => { if (win.isVisible()) win.hide(); else win.show(); } },
    { type: 'separator' },
    { label: `连接：${cfg.primary.name} (${cfg.primary.url})`, enabled: false },
    { label: '登录 vibe（代理连接用）', visible: !!cfg.ssoOrigin, click: openLogin },
    { label: '打开配置文件', click: openConfig },
    { label: '重新加载', click: () => { cfg = loadConfig(); if (win) win.reload(); } },
    { type: 'separator' },
    { label: '退出', click: () => { app.quit(); } },
  ]);
  tray.setContextMenu(menu);
  tray.on('click', () => { if (win) (win.isVisible() ? win.focus() : win.show()); });
}

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
  createWindow();
  buildTray();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', (e) => { e.preventDefault(); }); // 托盘常驻，不随窗口关闭退出

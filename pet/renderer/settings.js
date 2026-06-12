'use strict';
/* settings.js — 设置窗口逻辑：读取当前配置回填表单，保存后立即生效。 */

const $ = (id) => document.getElementById(id);

let cfg = null;

async function load() {
  cfg = await window.settingsBridge.get();
  const src = (cfg.sources && cfg.sources[0]) || { name: 'vibe', url: '', token: '', enabled: true };
  $('monRemote').checked = cfg.monitor !== 'local';
  $('monLocal').checked = cfg.monitor === 'local';
  $('skinClaude').checked = cfg.skin !== 'squirtle';
  $('skinSquirtle').checked = cfg.skin === 'squirtle';
  const rc = cfg.remote || {};
  $('rcEnabled').checked = !!rc.autoConnect;
  $('rcHost').value = rc.sshHost || '';
  $('rcPort').value = rc.remotePort || 47600;
  $('rcSlugs').value = rc.slugIncludes || '';
  if (rc.autoConnect && rc.sshHost) checkHooks(); // 打开设置时自动检测（只读）
  $('srcName').value = src.name || 'vibe';
  $('srcUrl').value = src.url || '';
  $('srcToken').value = src.token || '';
  $('ssoOrigin').value = cfg.ssoOrigin || '';
  $('localPort').value = (cfg.localMonitor && cfg.localMonitor.port) || 47601;
  $('notifyOnWaiting').checked = !!cfg.notifyOnWaiting;
  $('soundOnWaiting').checked = !!cfg.soundOnWaiting;
  $('notifyOnDone').checked = !!cfg.notifyOnDone;
  $('soundOnDone').checked = !!cfg.soundOnDone;
}

async function save() {
  const next = {
    monitor: $('monLocal').checked ? 'local' : 'remote',
    skin: $('skinSquirtle').checked ? 'squirtle' : 'claude',
    remote: {
      autoConnect: $('rcEnabled').checked,
      sshHost: $('rcHost').value.trim(),
      remotePort: parseInt($('rcPort').value, 10) || 47600,
      slugIncludes: $('rcSlugs').value.trim(),
    },
    sources: [{
      name: $('srcName').value.trim() || 'vibe',
      url: $('srcUrl').value.trim(),
      token: $('srcToken').value.trim(),
      enabled: true,
    }],
    localMonitor: {
      port: parseInt($('localPort').value, 10) || 47601,
    },
    notifyOnWaiting: $('notifyOnWaiting').checked,
    soundOnWaiting: $('soundOnWaiting').checked,
    notifyOnDone: $('notifyOnDone').checked,
    soundOnDone: $('soundOnDone').checked,
    ssoOrigin: $('ssoOrigin').value.trim(),
  };
  await window.settingsBridge.save(next);
  const saved = $('saved');
  saved.classList.add('show');
  setTimeout(() => saved.classList.remove('show'), 2000);
}

// ---------- hooks 管理（检测只读自动；安装/卸载弹确认） ----------
const HOOKS_LABEL = {
  none: '未安装（启发式可用，缺等权限提醒/工具气泡）',
  basic: '✅ 已安装（基础版，可升级工具事件）',
  full: '✅ 已安装（完整版）',
  error: '检测失败（SSH 不通？）',
  disabled: '先启用 SSH 自动连接并保存',
};
function setHooksUi(status) {
  $('hooksState').textContent = HOOKS_LABEL[status] || status;
  $('hooksInstall').hidden = status === 'full';
  $('hooksInstall').textContent = status === 'basic' ? '升级' : '安装';
  $('hooksUninstall').hidden = !(status === 'basic' || status === 'full');
}
async function checkHooks() {
  $('hooksState').textContent = '检测中…';
  const r = await window.settingsBridge.hooksStatus();
  setHooksUi(r.status);
  if (r.err) $('hooksState').textContent += `：${r.err}`;
}
async function runHooks(action, confirmText) {
  if (!window.confirm(confirmText)) return;
  const btns = [$('hooksCheck'), $('hooksInstall'), $('hooksUninstall')];
  btns.forEach((b) => { b.disabled = true; });
  $('hooksState').textContent = '执行中…（修改前自动备份）';
  const r = action === 'install'
    ? await window.settingsBridge.hooksInstall()
    : await window.settingsBridge.hooksUninstall();
  btns.forEach((b) => { b.disabled = false; });
  if (!r.ok) { $('hooksState').textContent = `失败：${r.msg}`; return; }
  await checkHooks();
  $('hooksState').textContent += '（对新开的会话生效）';
}
$('hooksCheck').addEventListener('click', checkHooks);
$('hooksInstall').addEventListener('click', () => runHooks('install',
  '将修改远端 ~/.claude/settings.json 注册 cc-pet 钩子（含工具事件）。\n自动备份、只增不改，不影响已有配置。继续？'));
$('hooksUninstall').addEventListener('click', () => runHooks('uninstall',
  '将从远端 ~/.claude/settings.json 移除 cc-pet 钩子（自动备份）。继续？'));

$('save').addEventListener('click', save);
$('cancel').addEventListener('click', () => window.close());
load();

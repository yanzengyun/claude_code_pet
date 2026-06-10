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

$('save').addEventListener('click', save);
$('cancel').addEventListener('click', () => window.close());
load();

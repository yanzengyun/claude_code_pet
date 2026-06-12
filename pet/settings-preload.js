'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('settingsBridge', {
  get: () => ipcRenderer.invoke('settings-get'),
  save: (cfg) => ipcRenderer.invoke('settings-save', cfg),
  // hooks 管理：检测只读；安装/卸载需用户在界面确认后才会触发
  hooksStatus: () => ipcRenderer.invoke('hooks-status'),
  hooksInstall: () => ipcRenderer.invoke('hooks-install'),
  hooksUninstall: () => ipcRenderer.invoke('hooks-uninstall'),
  // 本机 hooks（监控本机模式）
  localHooksStatus: () => ipcRenderer.invoke('local-hooks-status'),
  localHooksInstall: () => ipcRenderer.invoke('local-hooks-install'),
  localHooksUninstall: () => ipcRenderer.invoke('local-hooks-uninstall'),
});

'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('settingsBridge', {
  get: () => ipcRenderer.invoke('settings-get'),
  save: (cfg) => ipcRenderer.invoke('settings-save', cfg),
});

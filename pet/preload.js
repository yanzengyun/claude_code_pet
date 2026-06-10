'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// 从 main 经 additionalArguments 注入的配置
let cfg = {};
for (const a of process.argv) {
  if (a.startsWith('--pet-config=')) {
    try { cfg = JSON.parse(Buffer.from(a.slice('--pet-config='.length), 'base64').toString('utf8')); } catch {}
  }
}

// 暴露给 renderer
contextBridge.exposeInMainWorld('PET_CONFIG', cfg);
contextBridge.exposeInMainWorld('petBridge', {
  // renderer 状态变化 → 通知 main 做系统通知/提示音/托盘
  onState: (s) => ipcRenderer.send('pet-state', s),
  // renderer 请求开合点击穿透（可选）
  setIgnoreMouse: (ignore) => ipcRenderer.send('pet-ignore-mouse', ignore),
  // 手动拖拽：renderer 报告位移，main 移动窗口
  moveWindowBy: (dx, dy) => ipcRenderer.send('pet-move-by', { dx, dy }),
});

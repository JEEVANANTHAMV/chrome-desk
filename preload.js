const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  startTunnel: () => ipcRenderer.invoke('start-tunnel'),
  stopTunnel: () => ipcRenderer.invoke('stop-tunnel'),
  getStatus: () => ipcRenderer.invoke('get-status'),
  onLog: (callback) => ipcRenderer.on('log', callback)
});
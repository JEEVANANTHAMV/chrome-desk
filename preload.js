const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  startTunnel: () => ipcRenderer.invoke('start-tunnel'),
  stopTunnel: () => ipcRenderer.invoke('stop-tunnel'),
  getStatus: () => ipcRenderer.invoke('get-status'),
  setNgrokToken: (token) => ipcRenderer.invoke('set-ngrok-token', token),
  checkNgrokAuth: () => ipcRenderer.invoke('check-ngrok-auth'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  onLog: (cb) => ipcRenderer.on('log', cb)
});

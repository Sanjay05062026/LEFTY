const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lefty', {
  // Main window
  setLoggedIn: (loggedIn) => ipcRenderer.invoke('auth:changed', loggedIn),
  summon: () => ipcRenderer.send('lefty:summon'),
  // Overlay window
  onShow: (callback) => ipcRenderer.on('lefty:show', (_event, data) => callback(data)),
  onHide: (callback) => ipcRenderer.on('lefty:hide', () => callback()),
  onContext: (callback) => ipcRenderer.on('lefty:context', (_event, data) => callback(data)),
  onClick: (callback) => ipcRenderer.on('lefty:click', (_event, data) => callback(data)),
  onKey: (callback) => ipcRenderer.on('lefty:key', (_event, data) => callback(data)),
  setTarget: (rect) => ipcRenderer.send('overlay:target', rect),
  rescan: (options) => ipcRenderer.invoke('lefty:rescan', options),
  focusApp: () => ipcRenderer.send('lefty:focus-app'),
  raise: () => ipcRenderer.send('overlay:raise'),
  log: (message) => ipcRenderer.send('overlay:log', String(message)),
  requestHide: () => ipcRenderer.send('lefty:request-hide'),
  setInteractive: (interactive) => ipcRenderer.send('overlay:set-interactive', interactive),
});

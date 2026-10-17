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
  setTarget: (rect) => ipcRenderer.send('overlay:target', rect),
  rescan: () => ipcRenderer.invoke('lefty:rescan'),
  focusApp: () => ipcRenderer.send('lefty:focus-app'),
  log: (message) => ipcRenderer.send('overlay:log', String(message)),
  requestHide: () => ipcRenderer.send('lefty:request-hide'),
  setInteractive: (interactive) => ipcRenderer.send('overlay:set-interactive', interactive),
});

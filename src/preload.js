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
  brainReady: () => ipcRenderer.invoke('lefty:brain-ready'),
  think: (request) => ipcRenderer.invoke('lefty:think', request),
  openApp: (name) => ipcRenderer.invoke('lefty:open-app', name),
  launchApp: (app) => ipcRenderer.invoke('lefty:launch-app', app),
  focusApp: () => ipcRenderer.send('lefty:focus-app'),
  ghostStart: () => ipcRenderer.send('ghost:start'),
  ghostStop: () => ipcRenderer.send('ghost:stop'),
  onCaret: (callback) => ipcRenderer.on('lefty:caret', (_event, data) => callback(data)),
  editorFont: (process) => ipcRenderer.invoke('lefty:editor-font', process),
  doctorRead: () => ipcRenderer.invoke('doctor:read'),
  doctorCheck: (request) => ipcRenderer.invoke('doctor:check', request),
  doctorGoto: (where) => ipcRenderer.invoke('doctor:goto', where),
  doctorFix: (fix) => ipcRenderer.invoke('doctor:fix', fix),
  raise: () => ipcRenderer.send('overlay:raise'),
  log: (message) => ipcRenderer.send('overlay:log', String(message)),
  requestHide: () => ipcRenderer.send('lefty:request-hide'),
  setInteractive: (interactive) => ipcRenderer.send('overlay:set-interactive', interactive),
});

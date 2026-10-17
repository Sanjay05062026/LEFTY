const { app, BrowserWindow, globalShortcut, ipcMain, screen } = require('electron');
const path = require('path');
const { uIOhook, UiohookKey } = require('uiohook-napi');

const SHORTCUT = 'Control+Space';
const SHORTCUT_LABEL = 'Ctrl+Space';
const PRELOAD = path.join(__dirname, 'preload.js');

let mainWindow = null;
let overlayWindow = null;
let overlayVisible = false;
let hideTimer = null;
let shortcutEnabled = false;
let useHookFallback = false;

/* ---------- Ctrl + Space ----------
   The normal path is Electron's globalShortcut. Windows sometimes reserves Ctrl+Space
   (keyboard language / IME switching), and then registration fails. In that case a
   low-level keyboard hook watches for Ctrl+Space instead, so Lefty still pops up. */
function onShortcut() {
  console.log('[lefty] Ctrl+Space pressed');
  if (shortcutEnabled) toggleLefty();
}

function enableShortcut() {
  shortcutEnabled = true;
  if (globalShortcut.isRegistered(SHORTCUT)) return;
  useHookFallback = !globalShortcut.register(SHORTCUT, onShortcut);
  console.log(`[lefty] shortcut ready via ${useHookFallback ? 'keyboard hook (Ctrl+Space was reserved)' : 'globalShortcut'}`);
}

function disableShortcut() {
  shortcutEnabled = false;
  globalShortcut.unregister(SHORTCUT);
  useHookFallback = false;
}

uIOhook.on('keydown', (event) => {
  if (!useHookFallback) return;
  if (event.keycode === UiohookKey.Space && event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey) {
    onShortcut();
  }
});

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 900,
    minHeight: 600,
    title: 'Lefty',
    backgroundColor: '#FFF9F2',
    autoHideMenuBar: true,
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // The overlay window keeps the app alive, so quit explicitly when the main window closes.
  mainWindow.on('closed', () => app.quit());
}

function createOverlayWindow() {
  const { bounds } = screen.getPrimaryDisplay();
  overlayWindow = new BrowserWindow({
    ...bounds,
    show: false,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false },
  });
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  // Clicks pass through to the apps underneath unless the mouse is over Lefty or his bubble.
  overlayWindow.setIgnoreMouseEvents(true, { forward: true });
  overlayWindow.loadFile(path.join(__dirname, 'overlay', 'overlay.html'));
  // Surface overlay errors in the terminal: the overlay has no visible devtools.
  overlayWindow.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2) console.log('[overlay error]', message);
  });
}

function showLefty() {
  clearTimeout(hideTimer);
  const point = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(point);
  overlayWindow.setBounds(display.bounds);
  overlayWindow.show();
  overlayWindow.focus();
  overlayWindow.webContents.send('lefty:show', {
    x: point.x - display.bounds.x,
    y: point.y - display.bounds.y,
    width: display.bounds.width,
    height: display.bounds.height,
  });
  overlayVisible = true;
  console.log(`[lefty] shown at ${point.x},${point.y}`);
}

function hideLefty() {
  if (!overlayVisible) return;
  overlayVisible = false;
  overlayWindow.webContents.send('lefty:hide');
  overlayWindow.setIgnoreMouseEvents(true, { forward: true });
  hideTimer = setTimeout(() => overlayWindow.hide(), 220); // let the exit animation play
}

function toggleLefty() {
  if (overlayVisible) hideLefty();
  else showLefty();
}

// The shortcut only works while someone is logged in.
ipcMain.handle('auth:changed', (_event, loggedIn) => {
  if (loggedIn) {
    enableShortcut();
  } else {
    disableShortcut();
    hideLefty();
  }
  return { ok: true, accelerator: SHORTCUT_LABEL };
});

ipcMain.on('lefty:summon', showLefty);
ipcMain.on('lefty:request-hide', hideLefty);
ipcMain.on('overlay:set-interactive', (_event, interactive) => {
  overlayWindow.setIgnoreMouseEvents(!interactive, { forward: true });
});

app.whenReady().then(() => {
  createMainWindow();
  createOverlayWindow();
  uIOhook.start();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  uIOhook.stop();
});

const { app, BrowserWindow, globalShortcut, ipcMain, screen } = require('electron');
const path = require('path');
const { uIOhook, UiohookKey } = require('uiohook-napi');
const eyes = require('./eyes');

const SELFTEST = Boolean(process.env.LEFTY_SELFTEST);
const SHORTCUT = 'Control+Space';
const SHORTCUT_LABEL = 'Ctrl+Space';
const PRELOAD = path.join(__dirname, 'preload.js');

let mainWindow = null;
let overlayWindow = null;
let overlayVisible = false;
let hideTimer = null;
let shortcutEnabled = false;
let useHookFallback = false;
let showCount = 0; // each summon gets a number so a slow screen read never lands on a newer one

// Two copies of Lefty would both react to Ctrl+Space and cancel each other out.
const hasLock = SELFTEST || app.requestSingleInstanceLock();
if (!hasLock) app.quit();
app.on('second-instance', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

/* ---------- Ctrl + Space ----------
   The normal path is Electron's globalShortcut. Windows sometimes reserves Ctrl+Space
   (keyboard language / IME switching), and then registration fails. In that case a
   low-level keyboard hook watches for Ctrl+Space instead, so Lefty still pops up. */
function onShortcut() {
  console.log('[lefty] Ctrl+Space pressed');
  if (shortcutEnabled) toggleLefty();
}

function enableShortcut() {
  if (SELFTEST) return; // never grab the user's keyboard during a background check
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
    show: !SELFTEST,
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
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
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

// silent + hwnd are only used by the self-test: no window is shown and a known window is read.
function showLefty({ silent = false, hwnd } = {}) {
  clearTimeout(hideTimer);
  const point = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(point);
  const seq = ++showCount;
  overlayWindow.setBounds(display.bounds);
  if (!silent) {
    overlayWindow.show();
    overlayWindow.focus();
  }
  overlayWindow.webContents.send('lefty:show', {
    seq,
    x: point.x - display.bounds.x,
    y: point.y - display.bounds.y,
    width: display.bounds.width,
    height: display.bounds.height,
    originX: display.bounds.x,
    originY: display.bounds.y,
  });
  overlayVisible = true;
  console.log(`[lefty] shown at ${point.x},${point.y}`);
  readUserApp(seq, hwnd);
}

// UI Automation reports physical pixels; Electron windows are laid out in DIPs (they differ at 125%/150% scaling).
function toDip(rect) {
  const dip = screen.screenToDipRect(null, { x: rect.x, y: rect.y, width: rect.w, height: rect.h });
  return { x: dip.x, y: dip.y, w: dip.width, h: dip.height };
}

// Reads the app the user was in when they pressed the shortcut and hands its buttons to the overlay.
async function readUserApp(seq, hwnd) {
  try {
    const shot = await eyes.snapshot(hwnd);
    if (seq !== showCount) return;
    const appLabel = eyes.appName(shot.window);
    const elements = shot.elements.map((el) => ({ name: el.name, type: el.type, enabled: el.enabled, rect: toDip(el.rect) }));
    overlayWindow.webContents.send('lefty:context', { seq, ok: true, app: appLabel, elements });
    console.log(`[lefty] sees ${elements.length} clickable things in ${appLabel} (${shot.ms} ms)`);
  } catch (error) {
    if (seq !== showCount) return;
    overlayWindow.webContents.send('lefty:context', { seq, ok: false, error: error.message });
    console.log('[lefty] could not read the app:', error.message);
  }
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

ipcMain.on('lefty:summon', () => showLefty());
ipcMain.on('lefty:request-hide', hideLefty);
ipcMain.on('overlay:set-interactive', (_event, interactive) => {
  overlayWindow.setIgnoreMouseEvents(!interactive, { forward: true });
});
ipcMain.on('overlay:log', (_event, message) => console.log(`[overlay] ${message}`));

app.whenReady().then(() => {
  if (!hasLock) return;
  createMainWindow();
  createOverlayWindow();
  // Start the screen reader early so the first Ctrl+Space is fast and it already knows the user's app.
  eyes.start(process.pid).catch((error) => console.log('[lefty] screen reader failed to start:', error.message));
  if (SELFTEST) {
    require('../scripts/selftest').run({ app, overlayWindow, showLefty, toDip });
    return;
  }
  uIOhook.start();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (!SELFTEST) uIOhook.stop();
  eyes.stop();
});

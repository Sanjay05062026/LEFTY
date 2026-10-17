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
let overlayInteractive = false; // true while the mouse is over Lefty's bubble
let pointTarget = null;         // what Lefty is pointing at right now (global DIP rect), for click checking
let readHwnd;                   // self-test only: read this window instead of the user's app

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

/* ---------- Step checking ----------
   While Lefty points at something, every left click is checked: on the target means the step is done,
   anywhere else means Lefty takes another look. The cursor position is read from Electron (DIPs),
   the same units as the target, so scaled screens need no extra maths. */
uIOhook.on('mousedown', (event) => {
  if (event.button === 1) handleClick(screen.getCursorScreenPoint());
});

function handleClick(point) {
  if (!overlayVisible || overlayInteractive) return; // clicks in Lefty's own bubble don't count
  if (!pointTarget) {
    overlayWindow.webContents.send('lefty:click', { free: true }); // the screen probably changed: the guard re-reads it
    return;
  }
  const slack = 4;
  const r = pointTarget;
  const hit = point.x >= r.x - slack && point.x <= r.x + r.w + slack && point.y >= r.y - slack && point.y <= r.y + r.h + slack;
  console.log(`[lefty] click ${hit ? 'on' : 'off'} target at ${point.x},${point.y}`);
  if (hit) pointTarget = null; // a double-click must not count as two finished steps
  overlayWindow.webContents.send('lefty:click', { hit });
}

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
  readHwnd = hwnd;
  pointTarget = null;
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

// What the user's app shows right now, in the overlay's units. Never throws: failures come back as ok: false.
async function readApp(hwnd) {
  try {
    const shot = await eyes.snapshot(hwnd);
    const appLabel = eyes.appName(shot.window);
    const elements = shot.elements.map((el) => ({ name: el.name, type: el.type, enabled: el.enabled, rect: toDip(el.rect) }));
    return { ok: true, app: appLabel, elements, ms: shot.ms, windows: shot.windows, skipped: shot.skipped, skipError: shot.skipError };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function describe(seen) {
  if (!seen.ok) return `nothing, could not read the app: ${seen.error}`;
  const unreadable = seen.skipped ? `, ${seen.skipped} unreadable: ${seen.skipError}` : '';
  return `${seen.elements.length} clickable things in ${seen.app} (${seen.windows} window${seen.windows === 1 ? '' : 's'}${unreadable}, ${seen.ms} ms)`;
}

// Reads the app the user was in when they pressed the shortcut and hands its buttons to the overlay.
async function readUserApp(seq, hwnd) {
  const seen = await readApp(hwnd);
  if (seq !== showCount) return;
  overlayWindow.webContents.send('lefty:context', { seq, ...seen });
  console.log(`[lefty] sees ${describe(seen)}`);
}

function hideLefty() {
  if (!overlayVisible) return;
  overlayVisible = false;
  pointTarget = null;
  overlayInteractive = false;
  overlayWindow.webContents.send('lefty:hide');
  overlayWindow.setIgnoreMouseEvents(true, { forward: true });
  console.log('[lefty] hidden');
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
  overlayInteractive = Boolean(interactive);
  overlayWindow.setIgnoreMouseEvents(!interactive, { forward: true });
});
ipcMain.on('overlay:target', (_event, rect) => { pointTarget = rect || null; });
// Once Lefty points, the user's next move is a click in their app, so the app gets the keyboard back.
ipcMain.on('lefty:focus-app', () => {
  if (SELFTEST) return; // never move the user's focus during a background check
  eyes.focusApp(readHwnd)
    .then((result) => console.log(`[lefty] handed focus back to the app (${result.focused ? 'ok' : `Windows refused, attached=${result.attached}`})`))
    .catch((error) => console.log('[lefty] could not hand focus back:', error.message));
});
// After a step, the screen changes (a menu opens, a dialog appears): look again.
ipcMain.handle('lefty:rescan', async () => {
  const seen = await readApp(readHwnd);
  console.log(`[lefty] looked again: ${describe(seen)}`);
  return seen;
});
ipcMain.on('overlay:log', (_event, message) => console.log(`[overlay] ${message}`));

app.whenReady().then(() => {
  if (!hasLock) return;
  createMainWindow();
  createOverlayWindow();
  // Start the screen reader early so the first Ctrl+Space is fast and it already knows the user's app.
  eyes.start(process.pid).catch((error) => console.log('[lefty] screen reader failed to start:', error.message));
  if (SELFTEST) {
    require('../scripts/selftest').run({ app, overlayWindow, showLefty, toDip, handleClick, getTarget: () => pointTarget });
    return;
  }
  uIOhook.start();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (!SELFTEST) uIOhook.stop();
  eyes.stop();
});

const { app, BrowserWindow, Menu, Tray, clipboard, desktopCapturer, globalShortcut, ipcMain, screen, session } = require('electron');
const fs = require('fs');
const path = require('path');
const { uIOhook, UiohookKey } = require('uiohook-napi');
const eyes = require('./eyes');
const brain = require('./brain');
const remoteBrain = require('./brain-remote');
const apps = require('./apps');
const snap = require('./snap');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const { createGate } = require('./shortcut-gate');

const SELFTEST = Boolean(process.env.LEFTY_SELFTEST);
const SHORTCUT = 'Control+Space';
const SHORTCUT_LABEL = 'Ctrl+Space';
const SUMMON_DELAY_MS = 350; // the minimize animation, plus a beat for the screen reader to see the new app in front
const PRELOAD = path.join(__dirname, 'preload.js');
const ICON = path.join(__dirname, '..', 'assets', 'lefty-icon.png');

let mainWindow = null;
let overlayWindow = null;
let overlayVisible = false;
let hideTimer = null;
let shortcutEnabled = false;  // someone is logged in
let fullscreenApp = null;      // name of the fullscreen app in front (a game), while there is one
let useHookFallback = false;
let showCount = 0; // each summon gets a number so a slow screen read never lands on a newer one
let overlayInteractive = false; // true while the mouse is over Lefty's bubble
let pointTarget = null;         // what Lefty is pointing at right now (global DIP rect), for click checking
let readHwnd;                   // self-test only: read this window instead of the user's app
let tray = null;
let quitting = false;           // true once the user really quits; until then closing the window only hides it
let trayHintShown = false;
let injectingUntil = 0;         // while Lefty presses keys himself (code doctor), the key hooks ignore them

// The self-test gets its own data folder: it never touches the user's login data or a running Lefty's cache.
if (SELFTEST) app.setPath('userData', path.join(app.getPath('temp'), 'lefty-selftest'));

// Two copies of Lefty would both react to Ctrl+Space and cancel each other out.
const hasLock = SELFTEST || app.requestSingleInstanceLock();
if (!hasLock) app.quit();
app.on('second-instance', () => {
  if (mainWindow) openHome();
});
app.on('before-quit', () => { quitting = true; });

/* ---------- Ctrl + Space ----------
   The normal path is Electron's globalShortcut. Windows sometimes reserves Ctrl+Space
   (keyboard language / IME switching), and then registration fails. In that case a
   low-level keyboard hook watches for Ctrl+Space instead, so Lefty still pops up.
   While a fullscreen app (a game) is in front, Lefty lets go of Ctrl+Space completely: in many games it
   is crouch + jump, and the game must get it. */
const shortcutGate = createGate();

function onShortcut() {
  if (!shortcutGate.press()) return; // a held key repeats: one press, one toggle
  console.log('[lefty] Ctrl+Space pressed');
  if (shortcutEnabled && !fullscreenApp) toggleLefty();
}

// Holds Ctrl+Space exactly while someone is logged in and no fullscreen app is in front.
function syncShortcut() {
  if (SELFTEST) return; // never grab the user's keyboard during a background check
  const want = shortcutEnabled && !fullscreenApp;
  if (want && !globalShortcut.isRegistered(SHORTCUT) && !useHookFallback) {
    useHookFallback = !globalShortcut.register(SHORTCUT, onShortcut);
    console.log(`[lefty] shortcut ready via ${useHookFallback ? 'keyboard hook (Ctrl+Space was reserved)' : 'globalShortcut'}`);
  } else if (!want) {
    globalShortcut.unregister(SHORTCUT);
    useHookFallback = false;
  }
}

function enableShortcut() {
  shortcutEnabled = true;
  syncShortcut();
}

function disableShortcut() {
  shortcutEnabled = false;
  syncShortcut();
}

eyes.onScreenMode(({ fullscreen, process: name }) => {
  if (SELFTEST) return; // the self-test checks detection itself and must not react to the user's screen
  if (fullscreen) {
    fullscreenApp = name || 'a fullscreen app';
    hideLefty();
    console.log(`[lefty] ${fullscreenApp} is fullscreen: Ctrl+Space paused so it goes to the app`);
  } else if (fullscreenApp) {
    console.log(`[lefty] ${fullscreenApp} left fullscreen: Ctrl+Space is Lefty's again`);
    fullscreenApp = null;
  }
  syncShortcut();
});

uIOhook.on('keydown', (event) => {
  if (!useHookFallback || Date.now() < injectingUntil) return;
  if (event.keycode === UiohookKey.Space && event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey) {
    onShortcut();
  }
});
uIOhook.on('keyup', (event) => {
  if ([UiohookKey.Space, UiohookKey.Ctrl, UiohookKey.CtrlRight].includes(event.keycode)) shortcutGate.release();
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
    overlayWindow.webContents.send('lefty:click', { free: true, x: point.x, y: point.y }); // the screen probably changed: the guard re-reads it
    return;
  }
  const slack = 4;
  const r = pointTarget;
  const hit = point.x >= r.x - slack && point.x <= r.x + r.w + slack && point.y >= r.y - slack && point.y <= r.y + r.h + slack;
  console.log(`[lefty] click ${hit ? 'on' : 'off'} target at ${point.x},${point.y}`);
  if (hit) pointTarget = null; // a double-click must not count as two finished steps
  overlayWindow.webContents.send('lefty:click', { hit, x: point.x, y: point.y });
}

// Keys matter to a guide too: Ctrl+S saves, Enter confirms a dialog, typing names a file. Only these three
// keys are ever named; for everything else the overlay just hears "typing happened", never which keys.
let lastTypingSent = 0;
const MODIFIER_KEYS = [UiohookKey.Ctrl, UiohookKey.CtrlRight, UiohookKey.Alt, UiohookKey.AltRight, UiohookKey.Shift, UiohookKey.ShiftRight, UiohookKey.Meta, UiohookKey.MetaRight];
// Keys that move the text cursor without typing: ghost code keeps following the cursor while these are pressed.
const NAV_KEYS = [UiohookKey.ArrowLeft, UiohookKey.ArrowRight, UiohookKey.ArrowUp, UiohookKey.ArrowDown, UiohookKey.Home, UiohookKey.End, UiohookKey.PageUp, UiohookKey.PageDown];
uIOhook.on('keydown', (event) => {
  if (!overlayVisible || overlayInteractive || Date.now() < injectingUntil) return; // Lefty's own key presses aren't the user's
  if (ghostTimer) setTimeout(pollCaret, CARET_AFTER_KEY_MS); // ghost code keeps up with every key
  let message = null;
  if (event.ctrlKey && event.keycode === UiohookKey.S) message = { combo: event.shiftKey ? 'Ctrl+Shift+S' : 'Ctrl+S' };
  else if (event.keycode === UiohookKey.Enter) message = { combo: 'Enter' };
  else if (event.keycode === UiohookKey.Escape) message = { combo: 'Escape' };
  else if ((event.ctrlKey || event.altKey) && !MODIFIER_KEYS.includes(event.keycode)) message = { combo: 'shortcut' }; // which one is never said
  else if (NAV_KEYS.includes(event.keycode)) message = { combo: 'nav' };
  else if (!event.ctrlKey && !event.altKey && !event.metaKey && Date.now() - lastTypingSent > 300) {
    lastTypingSent = Date.now();
    message = { typing: true };
  }
  if (message) overlayWindow.webContents.send('lefty:key', message);
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
    icon: ICON,
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // Closing the window only hides it: Lefty keeps answering Ctrl+Space from the tray until the user quits there.
  mainWindow.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    mainWindow.hide();
    console.log('[lefty] home window closed: still running in the tray');
    if (!trayHintShown && tray && !SELFTEST) {
      trayHintShown = true;
      tray.displayBalloon({
        iconType: 'none', icon: ICON, title: 'Lefty is still here',
        content: `Press ${SHORTCUT_LABEL} anytime. To quit, right-click Lefty here and choose Quit.`,
      });
    }
  });
}

function openHome() {
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createTray() {
  tray = new Tray(ICON);
  tray.setToolTip(`Lefty: press ${SHORTCUT_LABEL}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Lefty', click: openHome },
    { type: 'separator' },
    { label: 'Quit Lefty', click: () => app.quit() },
  ]));
  tray.on('click', openHome);
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
  if (!SELFTEST) thinker().warmUp().catch(() => {}); // so the first answer is fast too
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
    // Plus search boxes Windows can't see (VS Code's Extensions box), worked out from the buttons around them.
    const elements = snap.addHiddenBoxes(shot.elements.map((el) => ({ name: el.name, type: el.type, enabled: el.enabled, rect: toDip(el.rect) })));
    return {
      ok: true, app: appLabel, title: shot.window.title, elements,
      ms: shot.ms, windows: shot.windows, skipped: shot.skipped, skipError: shot.skipError,
    };
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
  stopGhost();
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
  // Electron writes saved page data to disk lazily: after a crash or a hard shutdown the login and permissions
  // were lost and Lefty came back on the login screen. Write them now.
  session.defaultSession.flushStorageData();
  return { ok: true, accelerator: SHORTCUT_LABEL };
});

// From the home screen's buttons: step the home window aside first, so Lefty reads (and points into)
// the app that is then in front, not an app hidden behind his own window.
ipcMain.on('lefty:summon', () => {
  if (!mainWindow.isVisible() || mainWindow.isMinimized()) { showLefty(); return; }
  mainWindow.minimize();
  setTimeout(() => showLefty(), SUMMON_DELAY_MS);
});
ipcMain.on('lefty:request-hide', hideLefty);
ipcMain.on('overlay:set-interactive', (_event, interactive) => {
  overlayInteractive = Boolean(interactive);
  overlayWindow.setIgnoreMouseEvents(!interactive, { forward: true });
});
ipcMain.on('overlay:target', (_event, rect) => { pointTarget = rect || null; });
// Menus and dropdowns are always-on-top windows too, and the newest one is drawn above Lefty.
// Whenever Lefty points or warns, he steps back on top (without taking focus, so the menu stays open).
ipcMain.on('overlay:raise', () => {
  if (overlayVisible) overlayWindow.moveTop();
});
// Once Lefty points, the user's next move is a click in their app, so the app gets the keyboard back.
ipcMain.on('lefty:focus-app', () => {
  if (SELFTEST) return; // never move the user's focus during a background check
  eyes.focusApp(readHwnd)
    .then((result) => console.log(`[lefty] handed focus back to the app (${result.focused ? `ok via ${result.method}` : `Windows refused, attached=${result.attached}`})`))
    .catch((error) => console.log('[lefty] could not hand focus back:', error.message));
});
// After a step, the screen changes (a menu opens, a dialog appears): look again.
ipcMain.handle('lefty:rescan', async (_event, options) => {
  const seen = await readApp(readHwnd);
  if (!(options && options.quiet)) console.log(`[lefty] looked again: ${describe(seen)}`); // background re-checks stay out of the log
  return seen;
});
ipcMain.on('overlay:log', (_event, message) => console.log(`[overlay] ${message}`));

/* ---------- Ghost code ----------
   While Lefty shows code at the text cursor for the user to type over, the overlay needs to know where that
   cursor is: it's read 20 times a second (about 3 ms each) and again right after every key, and the overlay only
   hears about changes. The editor window is the one the user was in when the code appeared. */
const CARET_EVERY_MS = 50;
const CARET_AFTER_KEY_MS = 25; // the editor needs a moment to move its cursor after a key
let ghostTimer = null;
let ghostHwnd = null;
let caretBusy = false;
let lastCaret = '';
let caretFailed = false;

async function pollCaret() {
  if (!ghostTimer || caretBusy) return;
  caretBusy = true;
  try {
    const caret = await eyes.caret(ghostHwnd || readHwnd);
    if (!ghostTimer) return;
    if (caret.inFront) ghostHwnd = ghostHwnd || caret.hwnd;
    const message = {
      inFront: caret.inFront, process: caret.process, ln: caret.ln, col: caret.col,
      line: caret.line ? toDip(caret.line) : null, area: caret.area ? toDip(caret.area) : null,
      popup: caret.popup ? toDip(caret.popup) : null,
    };
    const key = JSON.stringify(message);
    if (key !== lastCaret) {
      lastCaret = key;
      overlayWindow.webContents.send('lefty:caret', message);
    }
    caretFailed = false;
  } catch (error) {
    if (!caretFailed) console.log(`[lefty] can't read the text cursor: ${error.message}`); // once, not 20 times a second
    caretFailed = true;
  } finally {
    caretBusy = false;
  }
}

function stopGhost() {
  clearInterval(ghostTimer);
  ghostTimer = null;
}

ipcMain.on('ghost:start', () => {
  stopGhost();
  ghostHwnd = null;
  lastCaret = '';
  ghostTimer = setInterval(pollCaret, CARET_EVERY_MS);
  pollCaret();
});
ipcMain.on('ghost:stop', stopGhost);

// The editor's font, so ghost code lines up with the real text: VS Code's defaults unless the user's settings say
// otherwise (VS Code's cousins keep the same settings file in their own folder).
const EDITOR_FOLDERS = { code: 'Code', 'code - insiders': 'Code - Insiders', cursor: 'Cursor', windsurf: 'Windsurf', vscodium: 'VSCodium' };

// settings.json allows comments and trailing commas; plain JSON doesn't.
function readJsonc(file) {
  const text = fs.readFileSync(file, 'utf8');
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === '"') { // a string, copied whole (it may contain // or /*)
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
    } else if (c === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2);
      if (i < 0) break;
      i += 1;
    } else {
      out += c;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

function editorFont(processName) {
  const folder = EDITOR_FOLDERS[String(processName || '').toLowerCase()];
  let settings = {};
  try {
    if (folder) settings = readJsonc(path.join(process.env.APPDATA || '', folder, 'User', 'settings.json'));
  } catch { /* no settings file, or one that can't be read: the editor's defaults */ }
  const number = (value, fallback) => (Number.isFinite(value) ? value : fallback);
  const fontSize = number(settings['editor.fontSize'], 14);
  const setLine = number(settings['editor.lineHeight'], 0);
  // VS Code's rule: 0 means 1.35 x the font size (on Windows), below 8 is a multiple of the font size.
  const lineHeight = Math.round(setLine === 0 ? fontSize * 1.35 : setLine < 8 ? setLine * fontSize : setLine);
  const zoom = 1.2 ** number(settings['window.zoomLevel'], 0);
  return {
    fontFamily: settings['editor.fontFamily'] || "Consolas, 'Courier New', monospace",
    fontSize: fontSize * zoom,
    lineHeight: lineHeight * zoom,
    letterSpacing: number(settings['editor.letterSpacing'], 0) * zoom,
    light: /light/i.test(settings['workbench.colorTheme'] || ''),
  };
}

ipcMain.handle('lefty:editor-font', (_event, processName) => editorFont(processName));

/* ---------- Code doctor ----------
   "Find the error": Lefty reads the whole file in VS Code (it hides its text from the screen reader, so he selects
   all and copies, then puts the user's clipboard and cursor back), the AI finds the errors, and Lefty jumps to each
   one with VS Code's own Go to Line (Ctrl+G), which scrolls long files there. "Fix it for me" pastes the fix over
   the wrong lines. Every key press needs the user's request first, and goes only to the editor window in front. */
const SECRET_FILE = /\.env\b|secret|credential|password|\.pem\b|\.key\b|id_rsa/i;
const CLIPBOARD_WAIT_MS = 1500;
let doctorHwnd = null;

async function press(hwnd, keys) {
  injectingUntil = Date.now() + 30000;
  try {
    await eyes.keys(hwnd, keys);
  } finally {
    injectingUntil = Date.now() + 300; // the hooks may see the last keys a moment later
  }
}

function saveClipboard() {
  return { text: clipboard.readText(), html: clipboard.readHTML(), rtf: clipboard.readRTF(), image: clipboard.readImage() };
}

function restoreClipboard(saved) {
  const data = {};
  if (saved.text) data.text = saved.text;
  if (saved.html) data.html = saved.html;
  if (saved.rtf) data.rtf = saved.rtf;
  if (!saved.image.isEmpty()) data.image = saved.image;
  if (Object.keys(data).length) clipboard.write(data);
  else clipboard.clear();
}

// Puts the editor in front with its text cursor in the code. Returns { hwnd, caret } or { error }.
async function editorInFront() {
  const first = await eyes.caret(doctorHwnd || readHwnd);
  const hwnd = first.hwnd;
  if (!EDITOR_FOLDERS[String(first.process || '').toLowerCase()] && first.process) return { error: 'not-editor', process: first.process };
  await eyes.focusApp(hwnd).catch(() => {});
  await sleep(120);
  let caret = await eyes.caret(hwnd);
  if (!caret.inFront) return { error: 'not-front' };
  if (!EDITOR_FOLDERS[String(caret.process || '').toLowerCase()]) return { error: 'not-editor', process: caret.process };
  if (!caret.line) { // focus is in a side panel: Ctrl+1 goes back to the code
    await press(hwnd, ['ctrl+1', 'wait:200']);
    caret = await eyes.caret(hwnd);
  }
  if (!caret.line || !caret.ln) return { error: 'no-cursor' };
  doctorHwnd = hwnd;
  return { hwnd, caret };
}

const goToKeys = (line, col) => ['ctrl+g', 'wait:150', `text:${line}:${col}`, 'wait:80', 'enter', 'wait:150'];

ipcMain.handle('doctor:read', async () => {
  if (SELFTEST) return { ok: false, error: 'self-test' };
  try {
    doctorHwnd = null;
    const at = await editorInFront();
    if (at.error) return { ok: false, error: at.error };
    const title = ((await eyes.windows()).find((w) => w.hwnd === at.hwnd) || {}).title || '';
    // "● add.py - folder - Visual Studio Code" -> add.py; an unsaved tab is "● a = 2 • Untitled-1 - ..." -> Untitled-1.
    const fileName = title.replace(/^[●•*]\s*/, '').split(/\s[-–—]\s/)[0].split(' • ').pop().trim();
    if (SECRET_FILE.test(fileName)) return { ok: false, error: 'secret', fileName };
    const saved = saveClipboard();
    const marker = `lefty-${Date.now()}-${Math.random()}`;
    clipboard.writeText(marker);
    let code = null;
    try {
      await press(at.hwnd, ['ctrl+a', 'wait:60', 'ctrl+c']);
      const end = Date.now() + CLIPBOARD_WAIT_MS;
      while (Date.now() < end && clipboard.readText() === marker) await sleep(30);
      code = clipboard.readText();
    } finally {
      restoreClipboard(saved);
      await press(at.hwnd, goToKeys(at.caret.ln, at.caret.col)).catch(() => {}); // back where the user was, selection gone
    }
    if (code === marker) return { ok: false, error: 'no-copy' };
    // The editor's own problem count, as a hint for the AI ("Errors: 1, Warnings: 2").
    const seen = await readApp(at.hwnd);
    const hint = seen.ok ? seen.elements.map((el) => el.name).filter((n) => /^(Errors?|Warnings?): \d/.test(n)).join(', ') : '';
    console.log(`[lefty] doctor read ${code.split('\n').length} lines of ${fileName || 'an unsaved file'}${hint ? ` (${hint})` : ''}`);
    return { ok: true, code: code.replace(/\r\n?/g, '\n'), fileName, hint, process: at.caret.process };
  } catch (error) {
    console.log(`[lefty] doctor could not read the code: ${error.message}`);
    return { ok: false, error: 'failed' };
  }
});

ipcMain.handle('doctor:check', async (_event, request) => {
  if (SELFTEST || !thinker().ready()) return { ok: false, error: friendlyBrainError({ message: 'no API key' }) };
  const started = Date.now();
  try {
    const result = await thinker().checkCode(request);
    const usage = result.usage || {};
    console.log(`[lefty] doctor (${thinker().label()}, ${Date.now() - started} ms, ${usage.input} in / ${usage.output} out): ${result.problems.length} problem(s)${result.problems.map((p) => ` | line ${p.line}${p.endLine > p.line ? `-${p.endLine}` : ''}: ${p.message}`).join('')}`);
    if (process.env.LEFTY_LOG_CODE) result.problems.forEach((p) => console.log(`[lefty] fix for line ${p.line}: ${JSON.stringify(p.fixed)}`)); // for live tests
    delete result.usage;
    return { ok: true, ...result };
  } catch (error) {
    console.log(`[lefty] doctor check failed after ${Date.now() - started} ms: ${error.status || ''} ${error.message}`);
    return { ok: false, error: friendlyBrainError(error) };
  }
});

// Jumps to a line (VS Code scrolls it into view) and says where it is on screen, in DIPs, for the highlight.
ipcMain.handle('doctor:goto', async (_event, { line, col = 1 }) => {
  try {
    const at = await editorInFront();
    if (at.error) return { ok: false, error: at.error };
    await press(at.hwnd, goToKeys(line, col));
    await sleep(120);
    const caret = await eyes.caret(at.hwnd);
    if (!caret.line || caret.ln !== line) return { ok: false, error: 'not-there' };
    return {
      ok: true, process: caret.process, ln: caret.ln, col: caret.col,
      line: toDip(caret.line), area: caret.area ? toDip(caret.area) : null,
    };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

// Selects lines line..endLine whole (from column 1 to the end of the last one).
const selectKeys = (line, endLine) => [...goToKeys(line, 1), ...Array(Math.max(0, endLine - line)).fill('shift+down'), 'shift+end', 'wait:60'];

// Pastes text over lines line..endLine: "Fix it for me", or the indent that's left when the user retypes a line.
async function replaceLines({ line, endLine, text }) {
  const at = await editorInFront();
  if (at.error) return { ok: false, error: at.error };
  const saved = saveClipboard();
  try {
    if (text) {
      clipboard.writeText(text);
      await press(at.hwnd, [...selectKeys(line, endLine), 'ctrl+v', 'wait:200']);
    } else {
      await press(at.hwnd, [...selectKeys(line, endLine), 'delete', 'wait:100']);
    }
  } finally {
    restoreClipboard(saved);
  }
  return { ok: true };
}

ipcMain.handle('doctor:fix', async (_event, fix) => {
  try {
    const result = await replaceLines(fix);
    console.log(`[lefty] doctor ${result.ok ? 'fixed' : 'could not fix'} line ${fix.line}${fix.endLine > fix.line ? `-${fix.endLine}` : ''}`);
    return result;
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

/* ---------- The brain ----------
   For goals Lefty can't do on his own, the overlay asks for the next step: a screenshot of the screen Lefty is
   on plus a fresh read of the app's clickable things go to the AI (brain.js), or to Lefty's backend when
   LEFTY_SERVER is set (brain-remote.js: the server holds the AI key). Lefty hides himself from the screenshot, so
   the AI sees only the user's screen. Never in the self-test: it must not spend money. */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const thinker = () => (remoteBrain.ready() ? remoteBrain : brain);

// A random id for this install, sent to Lefty's backend so it can share its limits fairly. Nothing personal.
function deviceId() {
  const file = path.join(app.getPath('userData'), 'device-id');
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    const id = crypto.randomUUID();
    try { fs.writeFileSync(file, id); } catch { /* read-only profile: a new id next time is fine */ }
    return id;
  }
}

const SCREENSHOT_WIDTH = 1024; // plenty to read a screen, and a small upload is a faster answer

async function captureScreen(display) {
  overlayWindow.setContentProtection(true); // keeps Lefty's own window out of the picture (not the user's view)
  try {
    await sleep(50); // the next frame without him
    const width = Math.min(SCREENSHOT_WIDTH, display.size.width);
    const size = { width, height: Math.round((display.size.height * width) / display.size.width) };
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size });
    const source = sources.find((s) => s.display_id === String(display.id)) || sources[0];
    if (!source) throw new Error('no screen to capture');
    return { jpeg: source.thumbnail.toJPEG(70), imageSize: source.thumbnail.getSize() };
  } finally {
    overlayWindow.setContentProtection(false);
  }
}

function friendlyBrainError(error) {
  const status = error && error.status;
  if (error && error.message === 'no API key') return "My brain isn't connected: there's no API key. 🧠";
  if (error && error.remote) { // Lefty's backend answered with a problem
    if (status === 401) return "My brain server didn't accept this copy of Lefty. 🔑 Check LEFTY_APP_TOKEN in the .env file.";
    if (status === 429) return "I'm being asked to slow down. ⏳ Give me a few seconds and ask again.";
    if (status === 503) return "My brain server has no AI key yet. 🧠";
    return 'My brain server is busy right now. 😵 Try again in a moment.';
  }
  if (status === 401 || status === 403) return 'My API key was refused. 🔑 Check the key in the .env file.';
  if (status === 429) return 'Google asked me to slow down. ⏳ Give me a few seconds and ask again.';
  if (status === 529 || status >= 500) return 'My brain is busy right now. 😵 Try again in a moment.';
  if (error && /timed? ?out|ETIMEDOUT|ECONN|ENOTFOUND|fetch failed/i.test(error.message)) return "I couldn't reach my brain. 🌐 Check your internet and try again.";
  return 'My brain had a hiccup. 😵 Try again in a moment.';
}

ipcMain.handle('lefty:brain-ready', () => !SELFTEST && thinker().ready());
ipcMain.handle('lefty:think', async (_event, request) => {
  if (SELFTEST || !thinker().ready()) return { ok: false, error: friendlyBrainError({ message: 'no API key' }) };
  const started = Date.now();
  try {
    const display = screen.getDisplayMatching(overlayWindow.getBounds());
    const [seen, shot, windows] = await Promise.all([readApp(readHwnd), captureScreen(display), openWindows()]);
    // The screenshot is enough to see the screen: when the button list can't be read, the AI points from the
    // picture alone (less exact, but Lefty never gives up just because an app won't share its buttons).
    if (!seen.ok) console.log(`[lefty] brain gets the screenshot only (buttons unreadable: ${seen.error})`);
    const openApps = windows.filter((w) => !seen.ok || w.title !== seen.title).map((w) => ({ app: eyes.appName(w), title: w.title }));
    const step = await thinker().nextStep({
      goal: String(request.goal || ''), history: request.history || [], note: request.note || '',
      app: seen.ok ? seen.app : 'the app in the screenshot', title: seen.ok ? seen.title : '',
      elements: seen.ok ? seen.elements : [], display, jpeg: shot.jpeg, imageSize: shot.imageSize, openApps,
    });
    const usage = step.usage || {};
    const where = step.target ? ` -> ${step.target.type} "${step.target.name}"${step.target.snappedFrom ? ` (snapped from ${step.target.snappedFrom})` : ''}` : step.app ? ` -> app "${step.app}"`
      : step.code ? ` -> ${step.code.split('\n').length} lines of code` : '';
    console.log(`[lefty] brain (${thinker().label()}, ${Date.now() - started} ms, ${usage.input} in / ${usage.output} out): ${step.status} ${step.action} "${step.instruction || step.message}"${where}`);
    if (step.code && process.env.LEFTY_LOG_CODE) console.log(`[lefty] code: ${JSON.stringify(step.code)}`); // for live tests that type it
    delete step.usage;
    return { ok: true, ...step };
  } catch (error) {
    console.log(`[lefty] brain failed after ${Date.now() - started} ms: ${error.status || ''} ${error.message}`);
    return { ok: false, error: friendlyBrainError(error) };
  }
});

/* ---------- The app a goal is about ----------
   "Download the Python extension in VS Code" asked from the desktop: Lefty switches to VS Code if it's open
   (restoring it if minimized), or finds it in the Start menu so the overlay can ask "Open it?" and launch it. */
const LAUNCH_WAIT_MS = 20000;
let startApps = null; // Get-StartApps: [{ Name, AppID }], loaded once in the background

function loadStartApps() {
  if (startApps) return Promise.resolve(startApps);
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-StartApps | Select-Object Name, AppID | ConvertTo-Json -Compress'],
      { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
        try {
          const list = JSON.parse(stdout);
          startApps = Array.isArray(list) ? list : [list];
        } catch { startApps = null; }
        resolve(startApps || []);
      });
  });
}

async function openWindows() {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const list = await eyes.windows();
      if (list.length || attempt === 2) return list;
    } catch (error) {
      console.log(`[lefty] could not list open windows (try ${attempt}): ${error.message}`);
    }
    await sleep(300);
  }
  return [];
}

ipcMain.handle('lefty:open-app', async (_event, name) => {
  const windows = await openWindows();
  console.log(`[lefty] looking for ${name} among ${windows.length} open windows: ${windows.map((w) => eyes.appName(w)).join(', ')}`);
  const found = apps.findWindow(name, windows, eyes.appName);
  if (found) {
    if (!SELFTEST) await eyes.focusApp(found.hwnd).catch(() => {});
    console.log(`[lefty] switched to ${eyes.appName(found)} ("${found.title}")`);
    return { ok: true, switched: true, app: eyes.appName(found) };
  }
  const entry = apps.findStartApp(name, await loadStartApps());
  console.log(`[lefty] ${name} is not open; ${entry ? `found "${entry.Name}" in the Start menu` : 'not in the Start menu either'}`);
  return entry ? { ok: false, launchable: true, app: entry.Name, appId: entry.AppID } : { ok: false, launchable: false, app: name };
});

ipcMain.handle('lefty:launch-app', async (_event, { app: name, appId }) => {
  if (SELFTEST || !appId) return { ok: false };
  spawn('explorer.exe', [`shell:AppsFolder\\${appId}`], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  console.log(`[lefty] opening ${name}`);
  const end = Date.now() + LAUNCH_WAIT_MS;
  while (Date.now() < end) {
    await sleep(500);
    const found = apps.findWindow(name, await openWindows(), eyes.appName);
    if (found) {
      await sleep(1000); // let the app draw its window before Lefty looks at it
      await eyes.focusApp(found.hwnd).catch(() => {});
      console.log(`[lefty] ${name} is open ("${found.title}")`);
      return { ok: true, app: eyes.appName(found) };
    }
  }
  console.log(`[lefty] ${name} did not open within ${LAUNCH_WAIT_MS / 1000} s`);
  return { ok: false };
});

app.whenReady().then(() => {
  if (!hasLock) return;
  if (!SELFTEST) setTimeout(() => loadStartApps(), 3000); // ready before anyone asks, without slowing the start
  remoteBrain.setDevice(deviceId());
  createMainWindow();
  createOverlayWindow();
  if (!SELFTEST) createTray();
  if (!SELFTEST) console.log(`[lefty] brain: ${thinker().ready() ? `connected (${thinker().label()})` : 'no API key yet (add GEMINI_API_KEY to .env)'}`);
  // Start the screen reader early so the first Ctrl+Space is fast and it already knows the user's app.
  eyes.start(process.pid).catch((error) => console.log('[lefty] screen reader failed to start:', error.message));
  if (SELFTEST) {
    require('../scripts/selftest').run({ app, mainWindow, overlayWindow, showLefty, toDip, handleClick, getTarget: () => pointTarget });
    return;
  }
  uIOhook.start();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (!SELFTEST) uIOhook.stop();
  eyes.stop();
});

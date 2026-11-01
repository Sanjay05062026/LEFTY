const { app, BrowserWindow, Menu, Tray, clipboard, desktopCapturer, dialog, globalShortcut, ipcMain, screen, session, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { uIOhook, UiohookKey } = require('uiohook-napi');
const eyes = require('./eyes');
const Focus = require('./overlay/focus');
const brain = require('./brain');
const remoteBrain = require('./brain-remote');
const apps = require('./apps');
const editors = require('./editors');
const snap = require('./snap');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const { createGate } = require('./shortcut-gate');
const { createSettings } = require('./settings');
const history = require('./history');

const SELFTEST = Boolean(process.env.LEFTY_SELFTEST);
const STARTED_HIDDEN = process.argv.includes('--hidden'); // started with Windows: straight to the tray, no window
const SHORTCUT = 'Control+Space';
const SHORTCUT_LABEL = 'Ctrl+Space';
const SUMMON_DELAY_MS = 350; // the minimize animation, plus a beat for the screen reader to see the new app in front
const PRELOAD = path.join(__dirname, 'preload.js');
// Windows takes the size it wants out of an .ico: 16 px in the tray, 32 in the taskbar. Handed a single png
// it squashes that one image into all of them, and handed nothing it shows Electron's own icon instead.
const ICON = path.join(__dirname, '..', 'assets', process.platform === 'win32' ? 'lefty-tray.ico' : 'lefty-icon.png');

let mainWindow = null;
let overlayWindow = null;
let overlayVisible = false;
let autoWorking = false;        // Lefty is clicking and typing his way through a task right now
let hideTimer = null;
let shortcutEnabled = false;  // someone is logged in
let fullscreenApp = null;      // name of the fullscreen app in front (a game), while there is one
let useHookFallback = false;
let showCount = 0; // each summon gets a number so a slow screen read never lands on a newer one
let overlayInteractive = false; // true while the mouse is over Lefty's bubble (or body, or Stop chip): it takes clicks
let pointTarget = null;         // what Lefty is pointing at right now (global DIP rect), for click checking
let readHwnd;                   // self-test only: read this window instead of the user's app
let tray = null;
let quitting = false;           // true once the user really quits; until then closing the window only hides it
let trayHintShown = false;
let injectingUntil = 0;         // while Lefty presses keys or clicks himself (code doctor, Do it mode), the hooks ignore them
let settings = null;            // Learn or Do it mode, Lefty's size, speaking, private apps (settings.js)
let lastAppHwnd = 0;            // the app window of the latest screen read: the one Do it mode may act in
let lastAppProcess = null;      // ...and its process, for the private apps list (null: not read yet)
let picking = false;            // "What's this?": the next click anywhere picks a control to explain

// The self-test gets its own data folder: it never touches the user's login data or a running Lefty's cache.
if (SELFTEST) app.setPath('userData', path.join(app.getPath('temp'), 'lefty-selftest'));
history.init(app.getPath('userData'));

// Two copies of Lefty would both react to Ctrl+Space and cancel each other out, so only the first runs and
// any later one quits. An update is a later one: without the version check below, a freshly installed Lefty
// quit on startup and the old copy opened its window instead, so every new build looked like it had changed
// nothing. A copy that says it is a different build gets the machine: this one steps aside and starts it.
const hasLock = SELFTEST || app.requestSingleInstanceLock({ version: app.getVersion() });
if (!hasLock) app.quit();
app.on('second-instance', (_event, argv, _cwd, extra) => {
  const theirs = extra && extra.version;
  const exe = Array.isArray(argv) ? argv[0] : '';
  if (theirs && theirs !== app.getVersion() && exe && exe !== process.execPath && /\.exe$/i.test(exe)) {
    console.log(`handing over to ${theirs} (this is ${app.getVersion()})`);
    app.releaseSingleInstanceLock(); // the new one needs it the moment it starts
    try {
      spawn(exe, [], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } catch (error) {
      console.log(`could not start the new build: ${error.message}`);
    }
    app.quit();
    return;
  }
  if (mainWindow) openHome();
});
app.on('before-quit', () => { quitting = true; });

/* ---------- Being uninstalled ----------
   Windows will not let an installer or uninstaller close a program running as administrator, and Lefty runs
   that way on purpose. Rather than leave the user to kill him by hand, he watches for the note the uninstaller
   leaves in his own folder and closes himself. He also goes when his program file has been deleted, which is
   what is left of him when the folder is simply thrown away. */
const UNINSTALL_NOTE = path.join(app.getPath('userData'), 'uninstalling');
const LEAVING_EVERY_MS = 2000;
const EXE_EVERY = 10; // the program file is a slower thing to check, and a rarer way to go: every 20 seconds

function watchForUninstall() {
  // A note from an uninstall that was cancelled would otherwise close him the moment he started.
  try { fs.unlinkSync(UNINSTALL_NOTE); } catch (error) { /* there was none, which is the normal case */ }
  let ticks = 0;
  const timer = setInterval(() => {
    ticks += 1;
    let leaving = fs.existsSync(UNINSTALL_NOTE);
    if (!leaving && app.isPackaged && ticks % EXE_EVERY === 0) leaving = !fs.existsSync(process.execPath);
    if (!leaving) return;
    clearInterval(timer);
    console.log('[lefty] being uninstalled: closing myself');
    try { app.setLoginItemSettings({ openAtLogin: false }); } catch (error) { /* nothing to undo */ }
    try { if (tray) tray.destroy(); } catch (error) { /* already gone */ }
    app.exit(0);
  }, LEAVING_EVERY_MS);
  if (timer.unref) timer.unref();
}

/* ---------- Ctrl + Space ----------
   The normal path is Electron's globalShortcut. Windows sometimes reserves Ctrl+Space
   (keyboard language / IME switching), and then registration fails. In that case a
   low-level keyboard hook watches for Ctrl+Space instead, so Lefty still pops up.
   While a fullscreen app (a game) is in front, Lefty lets go of Ctrl+Space completely: in many games it
   is crouch + jump, and the game must get it.
   A tap shows or hides Lefty. Holding it shows him and he listens while it is held (voice): the release sends what
   was said. So a tap on an open Lefty hides him when the keys come back up, not when they go down. */
const shortcutGate = createGate();
const HOLD_TO_TALK_MS = 450;
const HOOK_CATCH_UP_MS = 40; // the keyboard hook's own key events may land just after the shortcut's
let shortcutHeld = null; // { opened, talking, timer } while Ctrl+Space is down
let comboDown = false;   // Ctrl+Space is down, as the keyboard hook sees it

function onShortcut() {
  if (!shortcutGate.press()) return; // a held key repeats: one press, one toggle
  console.log('[lefty] Ctrl+Space pressed');
  if (!shortcutEnabled || fullscreenApp) return;
  const opened = !overlayVisible;
  if (opened) showLefty();
  clearTimeout(shortcutHeld && shortcutHeld.timer);
  const held = { opened, talking: false, timer: null };
  shortcutHeld = held;
  // A quick tap can be over (both keys up) before the shortcut itself arrives: a moment later, keys that are already up
  // mean a tap, not a hold.
  setTimeout(() => {
    if (shortcutHeld !== held) return;
    if (!comboDown) { releaseShortcut(); return; }
    held.timer = setTimeout(() => {
      if (shortcutHeld !== held || !overlayVisible) return;
      held.talking = true;
      console.log('[lefty] Ctrl+Space held: listening');
      overlayWindow.webContents.send('voice:hold', { on: true });
    }, HOLD_TO_TALK_MS - HOOK_CATCH_UP_MS);
  }, HOOK_CATCH_UP_MS);
}

function releaseShortcut() {
  shortcutGate.release();
  const held = shortcutHeld;
  shortcutHeld = null;
  if (!held) return;
  clearTimeout(held.timer);
  if (held.talking) { overlayWindow.webContents.send('voice:hold', { on: false }); return; }
  if (held.opened) return;
  // While Lefty is working on his own, Ctrl+Space is the one way to stop him, so a tap brings his chat back
  // with the Stop button on it instead of hiding him. Hiding would leave the task running with nothing to press.
  if (autoWorking) {
    overlayWindow.webContents.send('lefty:reveal');
    overlayWindow.moveTop();
    console.log('[lefty] Ctrl+Space while working: showing the Stop button');
    return;
  }
  hideLefty(); // a tap on an open Lefty closes him
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
  const combo = event.keycode === UiohookKey.Space && event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey;
  if (combo) comboDown = true;
  if (!useHookFallback || Date.now() < injectingUntil) return;
  if (combo) onShortcut();
});
uIOhook.on('keyup', (event) => {
  if (![UiohookKey.Space, UiohookKey.Ctrl, UiohookKey.CtrlRight].includes(event.keycode)) return;
  comboDown = false;
  releaseShortcut();
});

/* ---------- Step checking ----------
   While Lefty points at something, every left click is checked: on the target means the step is done,
   anywhere else means Lefty takes another look. The cursor position is read from Electron (DIPs),
   the same units as the target, so scaled screens need no extra maths. */
uIOhook.on('mousedown', (event) => {
  if (Date.now() < injectingUntil) return; // Lefty's own click in Do it mode
  const point = screen.getCursorScreenPoint();
  if (!onLefty(point)) userInput('mouse');
  if (event.button === 1) handleClick(point);
});

/* ---------- Stopping Do it mode ----------
   While Lefty clicks and types for the user, anything the user does (a click with any button, a turn of the wheel, a
   key) means "I'm taking over" and stops him; moving the mouse doesn't. Main only says that input happened (never
   which key, except Esc); the overlay decides whether Lefty was working. Clicks and keys on Lefty's own bubble and
   his own clicks and key presses don't count. */
let lastWheelSent = 0;
function userInput(kind, extra = {}) {
  if (!overlayVisible || Date.now() < injectingUntil) return;
  overlayWindow.webContents.send('lefty:input', { kind, ...extra });
}
uIOhook.on('wheel', () => {
  if (overlayInteractive || Date.now() - lastWheelSent < 250) return; // one wheel turn sends many events
  lastWheelSent = Date.now();
  userInput('wheel');
});

function handleClick(point) {
  if (!overlayVisible || onLefty(point)) return; // clicks in Lefty's own bubble don't count
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

// Keys matter while Lefty guides: Ctrl+S saves, Enter confirms a dialog, typing names a file. Only these three
// keys are ever named; for everything else the overlay just hears "typing happened", never which keys.
let lastTypingSent = 0;
const MODIFIER_KEYS = [UiohookKey.Ctrl, UiohookKey.CtrlRight, UiohookKey.Alt, UiohookKey.AltRight, UiohookKey.Shift, UiohookKey.ShiftRight, UiohookKey.Meta, UiohookKey.MetaRight];
// Keys that move the text cursor without typing: ghost code keeps following the cursor while these are pressed.
const NAV_KEYS = [UiohookKey.ArrowLeft, UiohookKey.ArrowRight, UiohookKey.ArrowUp, UiohookKey.ArrowDown, UiohookKey.Home, UiohookKey.End, UiohookKey.PageUp, UiohookKey.PageDown];
uIOhook.on('keydown', (event) => {
  if (!overlayVisible || overlayInteractive || Date.now() < injectingUntil) return; // Lefty's own key presses aren't the user's
  userInput('key', event.keycode === UiohookKey.Escape ? { escape: true } : {});
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
    show: !SELFTEST && !STARTED_HIDDEN,
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
    // Only the installed app can start with Windows (from the code, it would start a bare Electron).
    ...(app.isPackaged ? [{
      label: 'Start with Windows', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked, args: ['--hidden'] }),
    }] : []),
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
    grabExplainKey(true);
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
  clearInterval(regionTimer);
  if (!SELFTEST) regionTimer = setInterval(syncInteractive, REGION_POLL_MS); // the self-test never shows the window
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
    lastAppHwnd = shot.window.hwnd;
    lastAppProcess = shot.window.process || '';
    // The window's own Close / Minimize / Maximize buttons are marked: pointing never moves onto them, and Do it mode
    // asks before closing the whole app.
    const win = shot.window.rect ? toDip(shot.window.rect) : null;
    // Some apps add their own name: Calculator's are "Close Calculator", "Minimize Calculator".
    const titleBar = (el, rect) => Boolean(win) && el.type === 'Button' && /^(close|minimi[sz]e|maximi[sz]e|restore( down)?)(\s|$)/i.test(String(el.name).trim())
      && rect.y < win.y + 60 && rect.x > win.x + win.w - 280;
    // Plus search boxes Windows can't see (VS Code's Extensions box), worked out from the buttons around them.
    const elements = snap.addHiddenBoxes(shot.elements.map((el) => {
      const rect = toDip(el.rect);
      return { name: el.name, type: el.type, enabled: el.enabled, rect, ...(titleBar(el, rect) ? { titleBar: true } : {}) };
    }));
    return {
      ok: true, app: appLabel, title: shot.window.title, elements, process: lastAppProcess,
      private: settings.isPrivate(lastAppProcess), windowRect: win,
      ms: shot.ms, windows: shot.windows, skipped: shot.skipped, skipError: shot.skipError,
    };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

// No screenshot (or code) leaves the PC for this read's app. When the app couldn't be read, nobody knows which app it
// is, so with any app on the private list the answer is no, to be safe.
const keepPrivate = (seen) => (seen && seen.ok ? Boolean(seen.private) : settings.get().privateApps.length > 0);

function describe(seen) {
  if (!seen.ok) return `nothing, could not read the app: ${seen.error}`;
  const unreadable = seen.skipped ? `, ${seen.skipped} unreadable: ${seen.skipError}` : '';
  return `${seen.elements.length} clickable things in ${seen.app}${seen.private ? ' (a private app)' : ''} (${seen.windows} window${seen.windows === 1 ? '' : 's'}${unreadable}, ${seen.ms} ms)`;
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
  picking = false;
  clickRegions = [];
  clearInterval(regionTimer);
  stopGhost();
  grabExplainKey(false);
  overlayWindow.webContents.send('lefty:hide');
  overlayWindow.setIgnoreMouseEvents(true, { forward: true });
  console.log('[lefty] hidden');
  hideTimer = setTimeout(() => overlayWindow.hide(), 220); // let the exit animation play
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

// From the home screen's chat: the home window steps aside and Lefty takes the goal to the app in front, in the
// same chat (so the AI sees the earlier messages and a project built in it is changed, not made again).
ipcMain.handle('home:ask', (_event, { goal, chatId } = {}) => {
  const text = String(goal || '').trim().slice(0, 2000);
  if (!text) return { ok: false };
  const go = () => {
    showLefty();
    setTimeout(() => { if (!overlayWindow.isDestroyed()) overlayWindow.webContents.send('lefty:ask', { goal: text, chatId: chatId || null }); }, 120);
  };
  if (SELFTEST || !mainWindow.isVisible() || mainWindow.isMinimized()) go();
  else { mainWindow.minimize(); setTimeout(go, SUMMON_DELAY_MS); }
  return { ok: true };
});

/* ---------- Chat history (history.js): Supabase or this PC. Only the chat text, and never logged. ---------- */
function historyChanged() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('history:changed');
}
ipcMain.handle('history:list', () => history.list());
ipcMain.handle('history:get', (_event, id) => history.get(id));
ipcMain.handle('history:usage', () => history.usage());
ipcMain.handle('history:create', async (_event, title) => { const r = await history.create(title); if (r.ok) historyChanged(); else console.log(`[lefty] history: ${r.error}`); return r; });
ipcMain.handle('history:add', async (_event, { chatId, role, text } = {}) => { const r = await history.add(chatId, role, text); if (r.ok) historyChanged(); return r; });
ipcMain.handle('history:project', async (_event, { chatId, folder } = {}) => history.setProject(chatId, folder));
ipcMain.handle('history:remove', async (_event, id) => { const r = await history.remove(id); if (r.ok) historyChanged(); return r; });
/* ---------- Lefty's clickable parts ----------
   The overlay covers the whole screen and lets clicks through to the apps below, except over Lefty's bubble, his
   body and the Stop chip. Chromium's own "mouse entered" events over a click-through window are not reliable on
   Windows (now and then one is lost, and a click meant for the bubble landed in the app below it), so main watches
   the mouse itself: the overlay says where its clickable parts are, and whenever the mouse is over one of them the
   window takes clicks. */
const REGION_POLL_MS = 30;
let clickRegions = [];   // global DIP rects, from the overlay
let regionTimer = null;

const insideAny = (point, rects) => rects.some((r) => point.x >= r.x && point.x <= r.x + r.w && point.y >= r.y && point.y <= r.y + r.h);
const onLefty = (point) => overlayInteractive || picking || (overlayVisible && !SELFTEST && insideAny(point, clickRegions));

function syncInteractive() {
  if (picking) return; // the whole screen is Lefty's until the pick
  const inside = overlayVisible && insideAny(screen.getCursorScreenPoint(), clickRegions);
  if (inside === overlayInteractive) return;
  overlayInteractive = inside;
  overlayWindow.setIgnoreMouseEvents(!inside, { forward: true });
}

ipcMain.on('overlay:regions', (_event, rects) => {
  clickRegions = Array.isArray(rects) ? rects.filter((r) => r && [r.x, r.y, r.w, r.h].every(Number.isFinite)) : [];
  if (!SELFTEST) syncInteractive();
});
// "What's this?" from the bubble: the next click anywhere goes to Lefty (it picks the control to explain) instead of
// the app under it.
ipcMain.on('overlay:pick', (_event, on) => {
  picking = Boolean(on) && overlayVisible;
  if (SELFTEST) return;
  overlayInteractive = picking;
  overlayWindow.setIgnoreMouseEvents(!picking, { forward: true });
  if (picking) overlayWindow.focus(); // so Esc reaches Lefty
  else syncInteractive();
});
ipcMain.on('overlay:target', (_event, rect) => { pointTarget = rect || null; });
// True while Lefty is carrying a task out himself, so Ctrl+Space shows the Stop button instead of hiding him.
ipcMain.on('auto:working', (_event, working) => { autoWorking = Boolean(working); });
// Menus and dropdowns are always-on-top windows too, and the newest one is drawn above Lefty.
// Whenever Lefty points or warns, he steps back on top (without taking focus, so the menu stays open).
ipcMain.on('overlay:raise', () => {
  if (overlayVisible) overlayWindow.moveTop();
});
ipcMain.on('overlay:focus', () => {
  if (overlayVisible && !SELFTEST) overlayWindow.focus();
});
// Once Lefty points, the user's next move is a click in their app, so the app gets the keyboard back.
ipcMain.on('lefty:focus-app', () => {
  if (SELFTEST) return; // never move the user's focus during a background check
  focusApp(readHwnd)
    .then((result) => console.log(`[lefty] handed focus back to the app (${result.focused ? `ok via ${result.method}` : `Windows refused, attached=${result.attached}`})`))
    .catch((error) => console.log('[lefty] could not hand focus back:', error.message));
});
// The same, but waited for: used when a step failed because the app had slipped behind something, so Lefty can
// put it back in front and carry on rather than giving the task up.
ipcMain.handle('lefty:focus-goal-app', async () => {
  if (SELFTEST) return { ok: false };
  try {
    const result = await focusApp(readHwnd);
    console.log(`[lefty] brought the app back to the front (${result.focused ? `ok via ${result.method}` : 'Windows refused'})`);
    return { ok: Boolean(result.focused) };
  } catch (error) {
    console.log('[lefty] could not bring the app back:', error.message);
    return { ok: false };
  }
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
// Which editor is which, and what each one needs, lives in src/editors.js.

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
  const folder = editors.settingsFolder(processName);
  let settings = {};
  try {
    if (folder) settings = readJsonc(path.join(process.env.APPDATA || '', folder, 'User', 'settings.json'));
  } catch { /* no settings file, or one that can't be read: the editor's defaults */ }
  return editors.fontOf(processName, settings);
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
  await inject(() => eyes.keys(hwnd, keys));
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
  if (first.process && !editors.isKnown(first.process) && !(first.line && first.ln)) return { error: 'not-editor', process: first.process };
  await focusApp(hwnd).catch(() => {});
  await sleep(120);
  let caret = await eyes.caret(hwnd);
  if (!caret.inFront) return { error: 'not-front' };
  const knownEditor = editors.isKnown(caret.process);
  if (!caret.line && knownEditor) { // focus is in a side panel: Ctrl+1 goes back to the code
    await press(hwnd, ['ctrl+1', 'wait:200']);
    caret = await eyes.caret(hwnd);
  }
  // An editor Lefty has no entry for is still worked in, as long as it says where the cursor is - that is the
  // one thing only a real text editor reports, so he can never paste into something that merely looks like one.
  if (!caret.line || !caret.ln) return { error: knownEditor ? 'no-cursor' : 'not-editor', process: caret.process };
  doctorHwnd = hwnd;
  return { hwnd, caret };
}

const goToKeys = (process, line, col) => editors.gotoKeys(process, line, col);

ipcMain.handle('doctor:read', async () => {
  if (SELFTEST) return { ok: false, error: 'self-test' };
  try {
    doctorHwnd = null;
    const at = await editorInFront();
    if (at.error) return { ok: false, error: at.error };
    if (settings.isPrivate(at.caret.process)) return { ok: false, error: 'private' }; // its code never leaves the PC
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
      await press(at.hwnd, goToKeys(at.caret.process, at.caret.ln, at.caret.col)).catch(() => {}); // back where the user was, selection gone
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
    await press(at.hwnd, goToKeys(at.caret.process, line, col));
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
const selectKeys = (process, line, endLine) => [...goToKeys(process, line, 1), ...Array(Math.max(0, endLine - line)).fill('shift+down'), 'shift+end', 'wait:60'];

// Pastes text over lines line..endLine: "Fix it for me", or the indent that's left when the user retypes a line.
async function replaceLines({ line, endLine, text }) {
  const at = await editorInFront();
  if (at.error) return { ok: false, error: at.error };
  const saved = saveClipboard();
  try {
    if (text) {
      clipboard.writeText(text);
      await press(at.hwnd, [...selectKeys(at.caret.process, line, endLine), 'ctrl+v', 'wait:200']);
    } else {
      await press(at.hwnd, [...selectKeys(at.caret.process, line, endLine), 'delete', 'wait:100']);
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

/* ---------- Do it mode ----------
   Lefty clicks, types, presses keys and scrolls for the user, with real mouse and keyboard input, only in the app
   the goal is about (the window of the latest screen read, or its menus and dialogs). The helper refuses when
   another window is in the way, the thing under the point isn't the one expected, or a box is a password box.
   In the self-test nothing is pressed: the actions are only recorded, so a background check never moves the mouse. */
const autoActions = []; // self-test only
const AUTO_ERRORS = ['covered', 'lefty', 'not-front', 'moved', 'password', 'no-window'];

// While Lefty's own input is on its way the hooks ignore input; it may nest (a focus switch inside a key press).
let injecting = 0;
async function inject(work) {
  injecting += 1;
  injectingUntil = Date.now() + 30000;
  try {
    return await work();
  } finally {
    injecting -= 1;
    // The hooks see Lefty's last input a moment later; kept short, since the user's own input in this gap is missed.
    if (!injecting) injectingUntil = Date.now() + 150;
  }
}

// Bringing an app forward may take a bare Alt tap from the helper (Windows only lets the app that sent the last input
// change the foreground window): that tap is Lefty's, not the user's, so it must not stop Do it mode.
const focusApp = (hwnd) => inject(() => eyes.focusApp(hwnd));

// The result of a helper action as the overlay wants it: { ok } or { ok: false, error } (one of AUTO_ERRORS, or 'failed').
async function autoDo(what, work) {
  try {
    const reply = await inject(work);
    console.log(`[lefty] do it: ${what}${reply && reply.found ? ` (on "${reply.found}")` : ''}`);
    return { ok: true };
  } catch (error) {
    const code = AUTO_ERRORS.includes(error.message) ? error.message : 'failed';
    const found = error.reply && error.reply.found ? `, found "${error.reply.found}"` : '';
    console.log(`[lefty] do it: could not ${what}: ${error.message}${found}`);
    return { ok: false, error: code };
  }
}

const centreOf = (rect) => screen.dipToScreenPoint({ x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 });

/* A plain left click is tried first through UI Automation, which presses the control the way a screen reader
   does: the pointer stays where the user left it, and the window does not have to be in front - so Lefty can
   work in a window behind the one they are typing in. Not everything can be pressed that way (canvases, custom
   toolbars, most of a Java app), and a right-click or a double-click is a mouse gesture by definition, so those
   and anything that comes back "no-pattern" fall through to the real click, exactly as before. */
ipcMain.handle('auto:click', async (_event, { rect, button = 'left', count = 1, expect = '' }) => {
  if (SELFTEST) { autoActions.push({ act: 'click', rect, button, count, expect }); return { ok: true }; }
  const point = centreOf(rect);
  const how = count === 2 ? 'double-click' : button === 'right' ? 'right-click' : 'click';
  const what = `${how} ${expect ? `"${expect}"` : 'a spot'} at ${point.x},${point.y}`;
  if (button === 'left' && count === 1) {
    try {
      const pressed = await eyes.press(lastAppHwnd, { ...point, expect });
      if (pressed && pressed.ok) {
        console.log(`[lefty] pressed ${expect ? `"${pressed.name || expect}"` : 'a spot'} without the mouse (${pressed.how})`);
        return { ok: true, quiet: true };
      }
    } catch (error) {
      if (!/no-pattern/.test(error.message)) console.log(`[lefty] could not press quietly: ${error.message}`);
    }
  }
  return autoDo(what, () => eyes.click(lastAppHwnd, { ...point, button, count, expect }));
});

// What's under the middle of a rect, before Lefty clicks a spot the AI guessed: { name, type } or null.
ipcMain.handle('auto:peek', async (_event, { rect }) => {
  if (SELFTEST) return null;
  try {
    const { name, type } = await eyes.peek(centreOf(rect));
    return { name, type };
  } catch {
    return null;
  }
});

ipcMain.handle('auto:type', async (_event, { text }) => {
  if (SELFTEST) { autoActions.push({ act: 'type', text }); return { ok: true }; }
  return autoDo(`type ${String(text).length} characters`, () => eyes.type(lastAppHwnd, text)); // never the text itself
});

ipcMain.handle('auto:keys', async (_event, { keys }) => {
  if (SELFTEST) { autoActions.push({ act: 'keys', keys }); return { ok: true }; }
  return autoDo(`press ${keys.join(' ')}`, async () => {
    try {
      return await eyes.keys(lastAppHwnd, keys, { anyAppWindow: true });
    } catch (error) {
      if (!/not in front/.test(error.message)) throw error;
      await focusApp(lastAppHwnd); // Lefty's own bubble had the keyboard (the user pressed Continue)
      await sleep(80);
      return eyes.keys(lastAppHwnd, keys, { anyAppWindow: true });
    }
  });
});

ipcMain.handle('auto:scroll', async (_event, { rect, notches }) => {
  if (SELFTEST) { autoActions.push({ act: 'scroll', rect, notches }); return { ok: true }; }
  return autoDo(`scroll ${notches > 0 ? 'up' : 'down'}`, () => eyes.scroll(lastAppHwnd, { ...centreOf(rect), notches }));
});

// Code Lefty writes himself (Do it mode instead of ghost code): pasted on a new line below the text cursor in VS Code,
// so nothing already there is touched. The user's clipboard is put back afterwards.
// Code Lefty writes goes in a file of its own. The file the user has open is theirs, and whatever is in it has
// nothing to do with what he was asked for: he once put a Python function into 800 lines of someone's SQL schema
// because that was the window in front. Returns true once the editor is showing a blank file.
async function blankFile(hwnd, process) {
  const keys = editors.newFileKeys(process);
  if (!keys) return false;
  await press(hwnd, keys);
  const after = await eyes.caret(hwnd);
  // A blank file puts the cursor at the very start. If it isn't there, the keys did something else and the
  // code must not be pasted: the user's own file is still in front.
  return after.ln === 1 && after.col === 1;
}

// Gives the new file a name, so it is a real .py and not an unsaved tab. Ctrl+S on a file that has never been
// saved opens the app's Save dialog, which is a window of its own: if no such window appears, nothing is typed.
async function saveAs(hwnd, name) {
  if (!name) return false;
  await press(hwnd, ['ctrl+s', 'wait:900']);
  const front = await eyes.front().catch(() => null);
  if (!front || !front.hwnd || Number(front.hwnd) === Number(hwnd)) return false; // no dialog: leave it unsaved
  await inject(() => eyes.keys(hwnd, [`text:${name}`, 'wait:150', 'enter', 'wait:700'], { anyAppWindow: true }));
  const back = await eyes.front().catch(() => null);
  return Boolean(back && Number(back.hwnd) === Number(hwnd)); // the dialog closed: it saved
}

ipcMain.handle('auto:code', async (_event, { code, file }) => {
  const lines = String(code).split('\n').length;
  if (SELFTEST) { autoActions.push({ act: 'code', lines, file }); return { ok: true, file }; }
  try {
    doctorHwnd = null;
    const at = await editorInFront();
    if (at.error) return { ok: false, error: at.error };
    if (!editors.canNewFile(at.caret.process)) {
      return { ok: false, error: 'no-new-file', editor: editors.describe(at.caret.process) };
    }
    if (!await blankFile(at.hwnd, at.caret.process)) {
      return { ok: false, error: 'no-new-file', editor: editors.describe(at.caret.process) };
    }
    const saved = saveClipboard();
    try {
      clipboard.writeText(code);
      await press(at.hwnd, ['ctrl+v', 'wait:250']); // the file is empty: the code goes in as it is
    } finally {
      restoreClipboard(saved);
    }
    const named = await saveAs(at.hwnd, file).catch(() => false);
    console.log(`[lefty] do it: wrote ${lines} lines into a new file${named ? ` (${file})` : ' (unsaved)'}`);
    return { ok: true, file, named };
  } catch (error) {
    console.log(`[lefty] do it: could not write the code: ${error.message}`);
    return { ok: false, error: 'failed' };
  }
});

/* ---------- Settings ----------
   Learn or Do it mode, Lefty's size, speaking and the private apps: changed from the chat bubble or the home screen,
   saved, and sent to both. */
ipcMain.handle('settings:get', () => settings.get());
ipcMain.handle('settings:set', (_event, changes) => {
  const now = settings.set(changes || {});
  console.log(`[lefty] settings: mode ${now.mode}, size ${now.size}, speak ${now.speak}, ${now.privateApps.length} private app(s)`);
  for (const win of [mainWindow, overlayWindow]) if (win && !win.isDestroyed()) win.webContents.send('settings:changed', now);
  return now;
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
  if (error && error.message === 'no API key') return "The AI isn't connected: there's no API key.";
  if (error && error.remote) { // Lefty's backend answered with a problem
    if (status === 401) return "The AI server didn't accept this copy of Lefty. Check LEFTY_APP_TOKEN in the .env file.";
    if (status === 429) return "I'm being asked to slow down. Give me a few seconds and ask again.";
    if (status === 503) return "The AI server has no AI key yet.";
    return 'The AI server is busy right now. Try again in a moment.';
  }
  if (status === 401 || status === 403) return 'My API key was refused. Check the key in the .env file.';
  if (status === 429) return 'Google asked me to slow down. Give me a few seconds and ask again.';
  if (status === 529 || status >= 500) return "The AI's free servers are busy right now. Please try again in a moment.";
  if (error && (error.timeout || /timed? ?out/i.test(error.message))) return "The AI's free servers are very busy and didn't answer in time. Please try again in a moment.";
  if (error && /ETIMEDOUT|ECONN|ENOTFOUND|EAI_AGAIN|fetch failed/i.test(error.message)) return "I couldn't reach the AI. Check your internet and try again.";
  return 'The AI ran into a problem. Try again in a moment.';
}

// A spoken goal from the overlay: a short recording, { mime, data } in base64. Anything else is dropped.
const MAX_AUDIO_CHARS = 6 * 1024 * 1024;
function audioOf(audio) {
  if (!audio || !/^audio\/(wav|webm|ogg|mpeg|mp3|flac)$/.test(String(audio.mime || ''))) return null;
  return typeof audio.data === 'string' && audio.data && audio.data.length <= MAX_AUDIO_CHARS ? { mime: audio.mime, data: audio.data } : null;
}

// Which build is running. Shown in the sidebar so a stale install is obvious at a glance
// (an old build's messages live on in saved chats, which is confusing without this).
ipcMain.handle('lefty:version', () => app.getVersion());

ipcMain.handle('lefty:brain-ready', () => !SELFTEST && thinker().ready());
ipcMain.handle('lefty:think', async (_event, request) => {
  if (SELFTEST || !thinker().ready()) return { ok: false, error: friendlyBrainError({ message: 'no API key' }) };
  const started = Date.now();
  try {
    const display = screen.getDisplayMatching(overlayWindow.getBounds());
    const [seen, windows] = await Promise.all([readApp(readHwnd), openWindows()]);
    // Apps on the user's private list never get a screenshot taken: the AI works from their buttons alone.
    const hidden = keepPrivate(seen);
    if (!seen.ok && hidden) return { ok: false, error: "I couldn't read this app's buttons, and I don't take screenshots while you have private apps. Click into the app and ask me again." };
    const shot = hidden ? null : await captureScreen(display);
    // The screenshot is enough to see the screen: when the button list can't be read, the AI points from the
    // picture alone (less exact, but Lefty never gives up just because an app won't share its buttons).
    if (!seen.ok) console.log(`[lefty] brain gets the screenshot only (buttons unreadable: ${seen.error})`);
    if (hidden) console.log(`[lefty] brain gets the button list only (${seen.app} is a private app: no screenshot)`);
    const audio = audioOf(request.audio);
    if (audio) console.log(`[lefty] brain gets a spoken goal (${Math.round((audio.data.length * 3) / 4 / 1024)} KB of audio)`); // never what was said
    const openApps = windows.filter((w) => !seen.ok || w.title !== seen.title).map((w) => ({ app: eyes.appName(w), title: w.title }));
    const step = await thinker().nextStep({
      goal: String(request.goal || ''), history: request.history || [], note: request.note || '', auto: Boolean(request.auto),
      earlier: Array.isArray(request.earlier) ? request.earlier.slice(-12).map((m) => String(m).slice(0, 600)) : [],
      app: seen.ok ? seen.app : 'the app in the screenshot', title: seen.ok ? seen.title : '',
      elements: seen.ok ? seen.elements : [], display, jpeg: shot ? shot.jpeg : null, imageSize: shot ? shot.imageSize : display.size, openApps, audio,
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

/* ---------- "What does this do?" ----------
   With Lefty on screen, F1 (or "What's this?" in the bubble, then a click) asks about the control under the mouse.
   The AI gets its name and type, the controls around it and a small picture of the area around it (never in a
   private app), and explains it in a sentence or two. F1 is only Lefty's while he is on screen. */
const EXPLAIN_KEY = 'F1';
const EXPLAIN_PAD = { x: 170, y: 90 }; // DIPs of the screen kept around the control in the picture
const EXPLAIN_WIDTH = 720;

function grabExplainKey(on) {
  if (SELFTEST) return;
  if (on && !globalShortcut.isRegistered(EXPLAIN_KEY)) {
    const ok = globalShortcut.register(EXPLAIN_KEY, () => {
      if (overlayVisible) overlayWindow.webContents.send('lefty:explain', screen.getCursorScreenPoint());
    });
    if (!ok) console.log(`[lefty] ${EXPLAIN_KEY} is taken by another app: "What's this?" still works from the bubble`);
  } else if (!on && globalShortcut.isRegistered(EXPLAIN_KEY)) {
    globalShortcut.unregister(EXPLAIN_KEY);
  }
}

// A picture of the screen around rect (global DIPs) with the control in the middle, and where the control is in it.
async function captureAround(rect) {
  const display = screen.getDisplayNearestPoint({ x: Math.round(rect.x + rect.w / 2), y: Math.round(rect.y + rect.h / 2) });
  overlayWindow.setContentProtection(true);
  try {
    await sleep(50);
    const k = display.scaleFactor || 1;
    const size = { width: Math.round(display.size.width * k), height: Math.round(display.size.height * k) };
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size });
    const source = sources.find((s) => s.display_id === String(display.id)) || sources[0];
    if (!source) throw new Error('no screen to capture');
    const image = source.thumbnail;
    const px = image.getSize().width / display.size.width; // image pixels per DIP
    const left = Math.max(0, rect.x - display.bounds.x - EXPLAIN_PAD.x);
    const top = Math.max(0, rect.y - display.bounds.y - EXPLAIN_PAD.y);
    const right = Math.min(display.size.width, rect.x - display.bounds.x + rect.w + EXPLAIN_PAD.x);
    const bottom = Math.min(display.size.height, rect.y - display.bounds.y + rect.h + EXPLAIN_PAD.y);
    let crop = image.crop({ x: Math.round(left * px), y: Math.round(top * px), width: Math.max(1, Math.round((right - left) * px)), height: Math.max(1, Math.round((bottom - top) * px)) });
    if (crop.getSize().width > EXPLAIN_WIDTH) crop = crop.resize({ width: EXPLAIN_WIDTH });
    const out = crop.getSize().width / (right - left); // picture pixels per DIP
    const spot = { x: (rect.x - display.bounds.x - left) * out, y: (rect.y - display.bounds.y - top) * out, w: rect.w * out, h: rect.h * out };
    return { jpeg: crop.toJPEG(80), spot };
  } finally {
    overlayWindow.setContentProtection(false);
  }
}

ipcMain.handle('lefty:explain', async (_event, request) => {
  const element = request && request.element;
  if (!element || !element.rect || ![element.rect.x, element.rect.y, element.rect.w, element.rect.h].every(Number.isFinite)) return { ok: false, error: 'nothing' };
  if (SELFTEST || !thinker().ready()) return { ok: false, error: 'no-brain' };
  const started = Date.now();
  const hidden = lastAppProcess == null ? settings.get().privateApps.length > 0 : settings.isPrivate(lastAppProcess);
  try {
    const shot = hidden ? null : await captureAround(element.rect);
    const nearby = Array.isArray(request.nearby) ? request.nearby.map(String) : [];
    const result = await thinker().explain({
      app: String(request.app || ''), title: String(request.title || ''), element: { name: String(element.name || ''), type: String(element.type || '') },
      nearby, jpeg: shot && shot.jpeg, spot: shot && shot.spot, lang: String(request.lang || ''),
    });
    console.log(`[lefty] explained ${element.type} "${element.name}" (${thinker().label()}, ${Date.now() - started} ms${hidden ? ', no picture: a private app' : ''})`);
    return { ok: true, text: result.text, risky: Boolean(result.risky) };
  } catch (error) {
    console.log(`[lefty] could not explain "${element.name}" after ${Date.now() - started} ms: ${error.status || ''} ${error.message}`);
    return { ok: false, error: friendlyBrainError(error) };
  }
});

// The apps open right now, for adding one to the private list: [{ process, app }].
ipcMain.handle('apps:running', async () => {
  const seen = new Map();
  for (const w of await openWindows()) {
    const process = String(w.process || '').toLowerCase();
    if (process && !seen.has(process) && process !== 'electron') seen.set(process, { process, app: eyes.appName(w) || process });
  }
  return [...seen.values()];
});

/* ---------- Focus mode ----------
   "Focus 30 minutes on Chrome and physics": until the time is up, the window in front is checked every moment, and
   anything that isn't the user's work (focus.js allowed) is closed: a browser tab with Ctrl+W, any other window as its
   X button would (so an app can still ask to save). A window that is still there after that is minimized instead, so
   a save prompt never loops. Lefty doesn't open his chat for it: he glides to the tab's close button (or the window's
   X), presses it, and a small tag beside him says why, then he goes again. Only the app's name is logged, never a
   window title. */
const FOCUS_CHECK_MS = 1500;
const FOCUS_GRACE_MS = 4000;  // a moment to switch to the work after starting
const FOCUS_GLIDE_MS = 900;   // Lefty reaches the close button before it is pressed
const FOCUS_TAG_MS = 4500;    // how long the tag stays after closing
let focus = null;             // { until, allow, startedAt, minutes, timer, tried: Map<root, time> }
let focusChecking = false;

const focusState = () => (focus ? { on: true, until: focus.until, allow: focus.allow, minutes: focus.minutes } : { on: false });
function focusChanged() {
  for (const win of [mainWindow, overlayWindow]) if (win && !win.isDestroyed()) win.webContents.send('focus:changed', focusState());
}

// Lefty comes up and says it, in place of his greeting.
function focusSay(kind, data = {}) {
  if (SELFTEST) return;
  if (!overlayVisible) showLefty();
  setTimeout(() => overlayWindow.webContents.send('focus:notice', { kind, ...data }), overlayVisible ? 0 : SUMMON_DELAY_MS);
}

// Where the close button is, in DIPs: the tab's own close button in a browser (the tab whose name starts the window
// title), the window's X otherwise. null if it can't be found (Lefty then stays where he is).
async function focusCloseButton(win, browser) {
  const shot = await eyes.snapshot(win.root);
  const els = (shot && shot.elements) || [];
  const inside = (a, b) => a.x >= b.x - 2 && a.y >= b.y - 2 && a.x + a.w <= b.x + b.w + 2 && a.y + a.h <= b.y + b.h + 2;
  let hit = null;
  if (browser) {
    const closers = els.filter((e) => e.type === 'Button' && /^close( tab)?$/i.test(e.name || '') && e.rect && e.rect.w < 40);
    const title = String(win.title || '').toLowerCase();
    const tab = els.find((e) => e.type === 'TabItem' && e.name && e.rect && title.startsWith(e.name.toLowerCase().slice(0, 40)));
    hit = tab ? closers.find((c) => inside(c.rect, tab.rect)) : (closers.length === 1 ? closers[0] : null);
  } else {
    const xs = els.filter((e) => e.type === 'Button' && /^close$/i.test(e.name || '') && e.rect);
    hit = xs.sort((a, b) => (a.rect.y - b.rect.y) || (b.rect.x - a.rect.x))[0] || null; // the top-right one
  }
  return hit ? toDip(hit.rect) : null;
}

// Lefty without his chat: shown without taking the keyboard (the key press that closes a tab needs the browser in
// front), on the screen of the window being closed. Returns how to end it.
function focusBlockShow({ rect, app, left }) {
  const quiet = !overlayVisible;
  const seq = showCount;
  const cursor = screen.getCursorScreenPoint();
  const display = rect ? screen.getDisplayMatching({ x: rect.x, y: rect.y, width: rect.w, height: rect.h }) : screen.getDisplayNearestPoint(cursor);
  if (quiet) {
    clearTimeout(hideTimer);
    overlayWindow.setBounds(display.bounds);
    overlayWindow.setIgnoreMouseEvents(true, { forward: true });
    overlayWindow.showInactive();
  }
  const b = quiet ? display.bounds : overlayWindow.getBounds();
  overlayWindow.webContents.send('focus:block', {
    quiet, app, left, rect,
    area: { width: b.width, height: b.height, originX: b.x, originY: b.y },
    cursor: { x: cursor.x - b.x, y: cursor.y - b.y },
  });
  return () => {
    if (overlayWindow.isDestroyed()) return;
    if (showCount !== seq) return; // the user called Lefty meanwhile: his chat is in charge now
    overlayWindow.webContents.send('focus:block-end', { quiet });
    if (quiet && !overlayVisible) hideTimer = setTimeout(() => { if (!overlayVisible) overlayWindow.hide(); }, 220);
  };
}

function stopFocus(reason) {
  if (!focus) return;
  clearInterval(focus.timer);
  const { minutes } = focus;
  focus = null;
  console.log(`[lefty] focus mode ended (${reason})`);
  focusChanged();
  if (reason === 'time') focusSay('done', { minutes });
}

async function checkFocus() {
  if (!focus || focusChecking) return;
  if (Date.now() >= focus.until) { stopFocus('time'); return; }
  if (Date.now() - focus.startedAt < FOCUS_GRACE_MS) return;
  focusChecking = true;
  try {
    const win = await eyes.front();
    if (!focus || Focus.allowed(win, focus.allow)) return;
    const name = eyes.appName({ process: win.process, title: win.title });
    const browser = Focus.isBrowser(win.process);
    const triedAt = focus.tried.get(win.root);
    if (triedAt && Date.now() - triedAt < FOCUS_CHECK_MS * 2) return; // give it a moment to close
    const minimizing = Boolean(triedAt && !browser);
    const rect = SELFTEST || minimizing ? null : await focusCloseButton(win, browser).catch(() => null);
    const end = SELFTEST ? () => {} : focusBlockShow({ rect, app: name, left: focus.until - Date.now() });
    if (!SELFTEST) await new Promise((resolve) => setTimeout(resolve, rect ? FOCUS_GLIDE_MS : 300));
    if (!focus) { end(); return; }
    const now = await eyes.front().catch(() => null); // still the same window in front? (the user may have left it)
    if (!now || now.root !== win.root) { end(); return; }
    if (minimizing) {
      await eyes.closeWindow(win.root, { minimize: true }); // asked to close, still here (a save prompt): out of the way
      console.log(`[lefty] focus: minimized ${name}`);
    } else if (browser) {
      injectingUntil = Date.now() + 400; // Lefty's own keys, not the user's
      await eyes.keys(win.hwnd, ['ctrl+w']);
      console.log(`[lefty] focus: closed a tab in ${name}`);
    } else {
      await eyes.closeWindow(win.root);
      console.log(`[lefty] focus: closed ${name}`);
    }
    focus.tried.set(win.root, Date.now());
    setTimeout(end, FOCUS_TAG_MS);
  } catch (error) {
    console.log(`[lefty] focus check failed: ${error.message}`);
  } finally {
    focusChecking = false;
  }
}

ipcMain.handle('focus:start', (_event, request = {}) => {
  const minutes = Math.round(Number(request.minutes));
  if (!(minutes >= 1 && minutes <= Focus.MAX_MINUTES)) return { ok: false, error: `Pick between 1 and ${Focus.MAX_MINUTES} minutes.` };
  const allow = (Array.isArray(request.allow) ? request.allow : []).map((a) => String(a).trim().slice(0, 60)).filter(Boolean).slice(0, 10);
  if (!allow.length) return { ok: false, error: 'Tell me which apps or tabs are for your work.' };
  if (focus) clearInterval(focus.timer);
  focus = { until: Date.now() + minutes * 60000, allow, minutes, startedAt: Date.now(), tried: new Map(), timer: null };
  if (!SELFTEST) focus.timer = setInterval(checkFocus, FOCUS_CHECK_MS);
  console.log(`[lefty] focus mode on: ${minutes} min, ${allow.length} allowed`);
  focusChanged();
  return { ok: true, ...focusState() };
});
ipcMain.handle('focus:stop', () => { stopFocus('stopped'); return { ok: true }; });
ipcMain.handle('focus:get', () => focusState());

/* ---------- Building a project ----------
   "Build me a portfolio website": the user says which folder (typed, or picked in Windows' folder dialog), Lefty reads
   the text files already there, the AI writes whole files, and they are saved into that folder only: every path is
   checked to stay inside it. A file that is replaced is copied to .lefty-backup first, so nothing is lost. Only counts
   are logged, never file names or code. */
const MAX_READ_FILES = 150;
const MAX_READ_BYTES = 200 * 1024;
const SKIP_DIRS = new Set(['node_modules', '.git', '.lefty-backup', 'dist', 'build', '.next', '__pycache__', '.venv', 'venv', 'bin', 'obj']);
const TEXT_FILE = /\.(html?|css|scss|less|js|mjs|cjs|jsx|ts|tsx|json|md|txt|py|java|c|h|cpp|hpp|cs|go|rs|rb|php|kt|swift|sql|sh|bat|ps1|yml|yaml|toml|ini|xml|svg|vue|svelte|dart|lua|r)$/i;

// A folder Lefty may build in: a full path, not a drive's root and not inside Windows or Program Files.
function projectFolder(value) {
  const raw = String(value || '').trim().replace(/^"(.*)"$/, '$1');
  if (!raw || !path.isAbsolute(raw) || /[<>|?*"&^%]/.test(raw)) return null; // & ^ % mean something to cmd (opening VS Code)
  const folder = path.resolve(raw);
  if (folder === path.parse(folder).root) return null;
  const banned = [process.env.WINDIR, process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.ProgramData]
    .filter(Boolean).map((p) => path.resolve(p).toLowerCase());
  if (banned.some((b) => folder.toLowerCase() === b || folder.toLowerCase().startsWith(b + path.sep))) return null;
  return folder;
}

// The text files already in the folder, for the AI to change: [{ path (with /), content }].
function readProject(folder) {
  const files = [];
  const walk = (dir, rel) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (files.length >= MAX_READ_FILES) return;
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) walk(path.join(dir, entry.name), relPath); continue; }
      if (!entry.isFile() || !TEXT_FILE.test(entry.name) || /^\.env/i.test(entry.name)) continue;
      const full = path.join(dir, entry.name);
      try {
        if (fs.statSync(full).size > MAX_READ_BYTES) continue;
        files.push({ path: relPath, content: fs.readFileSync(full, 'utf8') });
      } catch { /* unreadable: left out */ }
    }
  };
  walk(folder, '');
  return files;
}

ipcMain.handle('build:suggest', (_event, name) => {
  const slug = String(name || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'my-project';
  // A new project gets a folder of its own: "website", then "website-2", never one that already has files in it.
  const base = path.join(app.getPath('documents'), 'Lefty Projects', slug);
  const taken = (folder) => { try { return fs.readdirSync(folder).length > 0; } catch { return false; } };
  for (let n = 1; n < 100; n += 1) {
    const folder = n === 1 ? base : `${base}-${n}`;
    if (!taken(folder)) return folder;
  }
  return `${base}-${Date.now()}`;
});

ipcMain.handle('build:pick', async (_event, current) => {
  if (SELFTEST) return { ok: false };
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: 'Where should Lefty build it?', defaultPath: projectFolder(current) || app.getPath('documents'),
    properties: ['openDirectory', 'createDirectory', 'promptToCreate'],
  });
  if (canceled || !filePaths.length) return { ok: false, canceled: true };
  return { ok: true, folder: filePaths[0] };
});

ipcMain.handle('build:run', async (_event, { folder: wanted, request, lang } = {}) => {
  const folder = projectFolder(wanted);
  if (!folder) return { ok: false, error: "I can't build there. Pick a full folder path like C:\\Users\\you\\Documents\\my-site (not a drive or Windows folder)." };
  if (!String(request || '').trim()) return { ok: false, error: 'Tell me what to build.' };
  if (!thinker().ready()) return { ok: false, error: 'no-brain' };
  const started = Date.now();
  try {
    fs.mkdirSync(folder, { recursive: true });
    const existing = readProject(folder);
    const result = await thinker().buildProject({ request: String(request).slice(0, 4000), files: existing, lang: String(lang || '') });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const written = [];
    let changed = 0;
    for (const file of result.files || []) {
      const rel = brain.safePath(file.path);
      const full = rel && path.resolve(folder, rel);
      if (!full || !full.startsWith(folder + path.sep) || typeof file.content !== 'string') continue;
      if (fs.existsSync(full)) {
        if (!fs.statSync(full).isFile()) continue;
        if (fs.readFileSync(full, 'utf8') === file.content) continue; // the same: nothing to do
        const backup = path.join(folder, '.lefty-backup', stamp, rel);
        fs.mkdirSync(path.dirname(backup), { recursive: true });
        fs.copyFileSync(full, backup);
        changed += 1;
      }
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, file.content);
      written.push(rel);
    }
    console.log(`[lefty] built a project (${thinker().label()}, ${Date.now() - started} ms): ${written.length} file(s), ${changed} replaced, ${existing.length} read`);
    if (!written.length) return { ok: false, error: 'Nothing needed to change.' };
    return { ok: true, folder, files: written, changed, summary: result.summary || '', run: result.run || '', hasIndex: written.includes('index.html') || fs.existsSync(path.join(folder, 'index.html')) };
  } catch (error) {
    console.log(`[lefty] could not build after ${Date.now() - started} ms: ${error.status || ''} ${error.message}`);
    return { ok: false, error: friendlyBrainError(error) };
  }
});

// Opens the finished project: its folder in VS Code (or File Explorer when VS Code isn't there), or index.html in
// the browser.
ipcMain.handle('build:open', async (_event, { folder: wanted, how } = {}) => {
  const folder = projectFolder(wanted);
  if (!folder || !fs.existsSync(folder) || SELFTEST) return { ok: false };
  if (how === 'browser') {
    const index = path.join(folder, 'index.html');
    return { ok: fs.existsSync(index) && !(await shell.openPath(index)) };
  }
  if (how === 'code') {
    const opened = await new Promise((resolve) => {
      execFile('cmd.exe', ['/d', '/c', 'code', folder], { windowsHide: true }, (error) => resolve(!error));
    });
    if (opened) return { ok: true };
  }
  return { ok: !(await shell.openPath(folder)) };
});

/* ---------- The app a goal is about ----------
   "Download the Python extension in VS Code" asked from the desktop: Lefty switches to VS Code if it's open
   (restoring it if minimized), or finds it in the Start menu so the overlay can ask "Open it?" and launch it. */
/* How long to wait for an app to open. A light app is up in a second; PyCharm, Visual Studio or Photoshop on a
   cold start can take a minute, and giving up on them was Lefty's own impatience, not the app's fault. So the
   wait is long, and it is based on progress: as soon as the app puts anything on screen (a splash, a loading
   window) the clock is given more room, because something is clearly happening. */
const LAUNCH_WAIT_MS = 90000;
const LAUNCH_AFTER_SIGN_MS = 45000; // more time once the app has shown something
const SETTLE_TRIES = 12;            // how many looks to give a window that is still drawing itself
const SETTLE_EVERY_MS = 400;
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
    if (!SELFTEST) {
      await focusApp(found.hwnd).catch(() => {});
      // A window coming back from the taskbar needs a moment to redraw; reading it mid-restore shows almost
      // nothing, and Lefty would plan the next step from an empty screen.
      if (found.minimized) await settle(found.hwnd, eyes.appName(found));
    }
    console.log(`[lefty] switched to ${eyes.appName(found)} ("${found.title}")`);
    return { ok: true, switched: true, app: eyes.appName(found) };
  }
  const entry = apps.findStartApp(name, await loadStartApps());
  console.log(`[lefty] ${name} is not open; ${entry ? `found "${entry.Name}" in the Start menu` : 'not in the Start menu either'}`);
  return entry ? { ok: false, launchable: true, app: entry.Name, appId: entry.AppID } : { ok: false, launchable: false, app: name };
});

// A window that is still drawing itself (a splash, an empty frame, a project loading) is no use to Lefty: he
// would read three buttons and plan from them. So after an app opens he keeps looking until what it shows stops
// changing, and only then says it is ready.
async function settle(hwnd, label) {
  let last = -1;
  let same = 0;
  for (let i = 0; i < SETTLE_TRIES; i += 1) {
    await sleep(SETTLE_EVERY_MS);
    const seen = await readApp(hwnd);
    const count = seen.ok ? seen.elements.length : -1;
    if (count > 0 && count === last) {
      same += 1;
      if (same >= 2) { // the same screen three looks running: it has finished drawing
        console.log(`[lefty] ${label} has settled (${count} things on screen)`);
        return;
      }
    } else {
      same = 0;
    }
    last = count;
  }
  console.log(`[lefty] ${label} is still changing; carrying on anyway`);
}

ipcMain.handle('lefty:launch-app', async (_event, { app: name, appId, want }) => {
  if (SELFTEST || !appId) return { ok: false };
  spawn('explorer.exe', [`shell:AppsFolder\\${appId}`], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  console.log(`[lefty] opening ${name}`);
  // The name the user (or the brain) used is the one a window is likely to carry: the Start menu's own name
  // often has a version in it that no window title ever shows.
  const names = [...new Set([want, name, apps.baseName(name)].filter(Boolean))];
  const before = (await openWindows()).length;
  let end = Date.now() + LAUNCH_WAIT_MS;
  let noticed = false;
  while (Date.now() < end) {
    await sleep(500);
    const windows = await openWindows();
    const found = names.map((n) => apps.findWindow(n, windows, eyes.appName)).find(Boolean);
    if (found) {
      await focusApp(found.hwnd).catch(() => {});
      await settle(found.hwnd, eyes.appName(found));
      console.log(`[lefty] ${name} is open ("${found.title}")`);
      return { ok: true, app: eyes.appName(found) };
    }
    // Something new appeared (a splash screen, a loading window): the app is coming, so give it longer.
    if (!noticed && windows.length > before) {
      noticed = true;
      end = Math.max(end, Date.now() + LAUNCH_AFTER_SIGN_MS);
      console.log(`[lefty] ${name} is starting up; waiting longer`);
    }
  }
  console.log(`[lefty] ${name} did not open within ${Math.round(LAUNCH_WAIT_MS / 1000)} s`);
  return { ok: false };
});

app.whenReady().then(() => {
  if (!hasLock) return;
  if (!SELFTEST) setTimeout(() => loadStartApps(), 3000); // ready before anyone asks, without slowing the start
  remoteBrain.setDevice(deviceId());
  settings = createSettings(path.join(app.getPath('userData'), 'settings.json'));
  createMainWindow();
  createOverlayWindow();
  if (!SELFTEST) createTray();
  if (!SELFTEST) watchForUninstall();
  if (!SELFTEST) console.log(`[lefty] brain: ${thinker().ready() ? `connected (${thinker().label()})` : 'no API key yet (add GEMINI_API_KEY to .env)'}`);
  // Start the screen reader early so the first Ctrl+Space is fast and it already knows the user's app.
  eyes.start(process.pid).catch((error) => console.log('[lefty] screen reader failed to start:', error.message));
  if (SELFTEST) {
    require('../scripts/selftest').run({ app, mainWindow, overlayWindow, showLefty, toDip, handleClick, getTarget: () => pointTarget, autoActions, userInput });
    return;
  }
  uIOhook.start();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (!SELFTEST) uIOhook.stop();
  eyes.stop();
});

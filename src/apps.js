// Finding the app a goal is about: among the windows already open, or among the apps in the Start menu.
// Pure functions (no Electron), so they can be tested in plain Node.

// What people type -> what Windows calls the app.
const ALIASES = {
  vscode: 'visual studio code', 'vs code': 'visual studio code', code: 'visual studio code',
  chrome: 'google chrome', edge: 'microsoft edge', word: 'word', excel: 'excel', powerpoint: 'powerpoint', ppt: 'powerpoint',
  explorer: 'file explorer', 'file manager': 'file explorer', files: 'file explorer', calc: 'calculator',
  terminal: 'terminal', cmd: 'command prompt', settings: 'settings', store: 'microsoft store', teams: 'microsoft teams',
  pycharm: 'pycharm', intellij: 'intellij idea', spotify: 'spotify', notepad: 'notepad', paint: 'paint',
};

const words = (text) => String(text || '').toLowerCase().replace(/[^a-z0-9+#]+/g, ' ').trim();

function canonical(name) {
  const n = words(name).replace(/\b(the|app|application|program)\b/g, ' ').replace(/\s+/g, ' ').trim();
  return ALIASES[n] || n;
}

// How well a window matches the app name: 0 = not at all. appName(window) is eyes.appName ("VS Code").
function windowScore(name, window, appName) {
  const want = canonical(name);
  if (!want) return 0;
  const label = canonical(appName ? appName(window) : '');
  const title = words(window.title);
  const process = words(window.process);
  if (label && label === want) return 3;
  if (process && (process === want.replace(/\s/g, '') || canonical(process) === want)) return 3;
  if (title.endsWith(want) || title.includes(` ${want}`) || title.startsWith(want)) return 2;
  const tokens = want.split(' ').filter((t) => t.length > 2);
  if (tokens.length && tokens.every((t) => title.includes(t) || process.includes(t))) return 1;
  return 0;
}

// The open window for this app, top-most first among the best matches; null if none.
function findWindow(name, windows, appName) {
  let best = null;
  let bestScore = 0;
  for (const window of windows || []) {
    const score = windowScore(name, window, appName);
    if (score > bestScore) { best = window; bestScore = score; }
  }
  return best;
}

// The Start menu entry for this app ({ Name, AppID } from Get-StartApps); null if none. Prefers an exact name,
// then a name that starts with it, then one that contains every word; skips uninstallers and help links.
function findStartApp(name, apps) {
  const want = canonical(name);
  if (!want) return null;
  const usable = (apps || []).filter((a) => a && a.Name && a.AppID && !/uninstall|readme|help|documentation|website/i.test(a.Name));
  const named = (a) => canonical(a.Name);
  return usable.find((a) => named(a) === want)
    || usable.find((a) => named(a).startsWith(`${want} `))
    || usable.find((a) => want.split(' ').every((t) => named(a).split(' ').includes(t)))
    || null;
}

module.exports = { canonical, windowScore, findWindow, findStartApp };

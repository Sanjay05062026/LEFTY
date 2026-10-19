// Lefty's eyes, Node side: builds and runs native/uia-helper.exe and asks it what is on screen.
// Works in plain Node too (no Electron imports), so it can be tested without opening any window.

const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const WINDIR = process.env.WINDIR || 'C:\\Windows';
const NATIVE_DIR = path.join(__dirname, '..', 'native');
const BIN = path.join(NATIVE_DIR, 'bin');
const SOURCE = path.join(NATIVE_DIR, 'uia-helper.cs');
const TLBGEN_SOURCE = path.join(NATIVE_DIR, 'tlbgen.cs');
const TLBGEN = path.join(BIN, 'tlbgen.exe');
const INTEROP = path.join(BIN, 'Interop.UIAutomationClient.dll');
const EXE = path.join(BIN, 'uia-helper.exe');
const FRAMEWORK = path.join(WINDIR, 'Microsoft.NET', 'Framework64', 'v4.0.30319');
const CSC = path.join(FRAMEWORK, 'csc.exe');
const REQUEST_TIMEOUT_MS = 8000;

let child = null;
let ready = null;      // promise that resolves once the helper says it is ready
let nextId = 1;
const pending = new Map();
const listeners = new Set(); // for messages the helper sends unasked (see onScreenMode)

function needsBuild() {
  if (!fs.existsSync(EXE)) return true;
  const built = fs.statSync(EXE).mtimeMs;
  return [SOURCE, TLBGEN_SOURCE].some((file) => fs.statSync(file).mtimeMs > built);
}

function run(file, args, cwd) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, cwd }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${path.basename(file)} failed: ${stdout || stderr || error.message}`));
      else resolve();
    });
  });
}

// Everything is built with the C# compiler that ships with Windows, so users never install anything:
// 1. tlbgen turns the type library inside UIAutomationCore.dll into .NET definitions of native UI Automation,
// 2. the helper is compiled with those definitions embedded (/link), so it needs no extra files at runtime.
async function build() {
  fs.mkdirSync(BIN, { recursive: true });
  await run(CSC, ['/nologo', `/out:${TLBGEN}`, TLBGEN_SOURCE]);
  await run(TLBGEN, [path.join(WINDIR, 'System32', 'UIAutomationCore.dll'), INTEROP], BIN);
  await run(CSC, [
    '/nologo', '/optimize+', '/target:exe', `/out:${EXE}`,
    `/link:${INTEROP}`,
    `/r:${path.join(FRAMEWORK, 'System.Web.Extensions.dll')}`,
    SOURCE,
  ]);
}

function failAll(reason) {
  for (const { reject, timer } of pending.values()) {
    clearTimeout(timer);
    reject(new Error(reason));
  }
  pending.clear();
}

function onLine(line, markReady) {
  if (!line.trim()) return;
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.ready) { markReady(); return; }
  if (message.event) { listeners.forEach((listener) => listener(message)); return; }
  const request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id);
  clearTimeout(request.timer);
  if (message.ok) request.resolve(message);
  else request.reject(new Error(message.error || 'helper error'));
}

// leftyPid: the process that owns Lefty's own windows, so Lefty never reads himself.
function start(leftyPid = process.pid) {
  if (ready) return ready;
  ready = (async () => {
    if (needsBuild()) await build();
    await new Promise((resolve, reject) => {
      child = spawn(EXE, [String(leftyPid)], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let buffer = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        buffer += chunk;
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          onLine(buffer.slice(0, newline), resolve);
          buffer = buffer.slice(newline + 1);
        }
      });
      child.stderr.on('data', (chunk) => console.log('[eyes stderr]', String(chunk).trim()));
      child.on('error', reject);
      child.on('exit', (code) => {
        child = null;
        ready = null; // the next request restarts the helper
        failAll(`uia-helper stopped (code ${code})`);
        reject(new Error(`uia-helper exited early (code ${code})`));
      });
    });
  })();
  ready.catch(() => { ready = null; });
  return ready;
}

async function request(payload) {
  await start();
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`uia-helper timed out on "${payload.cmd}"`));
    }, REQUEST_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ id, ...payload })}\n`);
  });
}

// What the user's current app looks like: window info plus clickable elements in physical pixels.
function snapshot(hwnd) {
  return request(hwnd ? { cmd: 'snapshot', hwnd } : { cmd: 'snapshot' });
}

// Hands keyboard focus back to the user's app (Lefty's overlay takes it while the user types a goal).
function focusApp(hwnd) {
  return request(hwnd ? { cmd: 'focus', hwnd } : { cmd: 'focus' });
}

// The app windows open on the PC: [{ hwnd, title, process, minimized }], top first.
async function windows() {
  return (await request({ cmd: 'windows' })).windows;
}

// Where the text cursor is in a code editor: { hwnd, inFront, process, line?: rect of the cursor's line (its x is
// where column 1 starts in VS Code), area?: the editor's rect, popup?: the suggestion list's rect while it's open,
// ln?, col? (from the status bar) }. Physical pixels.
function caret(hwnd) {
  return request(hwnd ? { cmd: 'caret', hwnd } : { cmd: 'caret' });
}

// Presses keys in that window, which must be in front: ['ctrl+g', 'text:12:1', 'enter', 'wait:100'].
// Only for actions the user asked Lefty to do (reading or fixing their code).
function keys(hwnd, list) {
  return request({ cmd: 'keys', hwnd, keys: list });
}

// Is this window fullscreen (covers its monitor with no title bar)? Defaults to the window in front.
function screenMode(hwnd) {
  return request(hwnd ? { cmd: 'screenmode', hwnd } : { cmd: 'screenmode' });
}

// Called with { fullscreen, process } whenever a fullscreen app (a game, a video) comes to the front or leaves it.
function onScreenMode(callback) {
  listeners.add((message) => { if (message.event === 'screenmode') callback(message); });
}

const APP_NAMES = {
  code: 'VS Code', chrome: 'Chrome', msedge: 'Edge', firefox: 'Firefox', brave: 'Brave', explorer: 'File Explorer',
  notepad: 'Notepad', pycharm64: 'PyCharm', pycharm: 'PyCharm', idea64: 'IntelliJ IDEA', winword: 'Word',
  excel: 'Excel', powerpnt: 'PowerPoint', outlook: 'Outlook', olk: 'Outlook', windowsterminal: 'Terminal',
  cmd: 'Command Prompt', powershell: 'PowerShell', slack: 'Slack', discord: 'Discord', spotify: 'Spotify',
  teams: 'Teams', 'ms-teams': 'Teams', figma: 'Figma', devenv: 'Visual Studio', systemsettings: 'Settings',
  applicationframehost: '', // hosts Store apps: the window title names the real app
};

// A name people recognise ("PyCharm", "Chrome") instead of a process name ("pycharm64").
function appName(window) {
  const process = String(window.process || '').toLowerCase();
  const title = String(window.title || '').trim();
  // explorer.exe also runs the taskbar (no title) and the desktop ("Program Manager").
  if (process === 'explorer' && !title) return 'the taskbar';
  if (process === 'explorer' && title === 'Program Manager') return 'your desktop';
  const known = APP_NAMES[process];
  if (known) return known;
  if (title) {
    const parts = title.split(/\s[-–—|]\s/); // "notes.txt - Notepad" -> "Notepad"
    return parts[parts.length - 1].trim();
  }
  if (process) return process.charAt(0).toUpperCase() + process.slice(1);
  return 'this app';
}

function stop() {
  if (child) child.kill();
  child = null;
  ready = null;
}

module.exports = { start, snapshot, focusApp, windows, caret, keys, screenMode, onScreenMode, appName, stop };

// Lefty's eyes, Node side: builds and runs native/uia-helper.exe and asks it what is on screen.
// Works in plain Node too (no Electron imports), so it can be tested without opening any window.

const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const NATIVE_DIR = path.join(__dirname, '..', 'native');
const SOURCE = path.join(NATIVE_DIR, 'uia-helper.cs');
const EXE = path.join(NATIVE_DIR, 'bin', 'uia-helper.exe');
const FRAMEWORK = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319');
const REQUEST_TIMEOUT_MS = 8000;

let child = null;
let ready = null;      // promise that resolves once the helper says it is ready
let nextId = 1;
const pending = new Map();

function needsBuild() {
  if (!fs.existsSync(EXE)) return true;
  return fs.statSync(SOURCE).mtimeMs > fs.statSync(EXE).mtimeMs;
}

// Compile with the C# compiler that ships with Windows, so users never install anything.
function build() {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(EXE), { recursive: true });
    const args = [
      '/nologo', '/optimize+', '/target:exe', `/out:${EXE}`,
      `/r:${path.join(FRAMEWORK, 'WPF', 'UIAutomationClient.dll')}`,
      `/r:${path.join(FRAMEWORK, 'WPF', 'UIAutomationTypes.dll')}`,
      `/r:${path.join(FRAMEWORK, 'WPF', 'WindowsBase.dll')}`,
      `/r:${path.join(FRAMEWORK, 'System.Web.Extensions.dll')}`,
      SOURCE,
    ];
    execFile(path.join(FRAMEWORK, 'csc.exe'), args, { windowsHide: true }, (error, stdout) => {
      if (error) reject(new Error(`could not build uia-helper: ${stdout || error.message}`));
      else resolve();
    });
  });
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

function stop() {
  if (child) child.kill();
  child = null;
  ready = null;
}

module.exports = { start, snapshot, stop };

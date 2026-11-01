// Lefty's brain over the network: when LEFTY_SERVER is set (in the environment or .env), the next step comes from
// Lefty's backend (server/), which holds the AI key, instead of from an AI key on this PC. Same answers as brain.js.
// Each install sends a random device id (no account, nothing personal), which the server may use for rate limits.

const { setting } = require('./brain');

const TIMEOUT_MS = 90000;             // the server may wait out an AI "slow down" before it answers
const BUILD_TIMEOUT_MS = 300000;      // building a whole project takes the AI minutes
const WARM_FOR_MS = 2 * 60 * 1000;
let device = 'unknown';
let warmedAt = 0;
let fetchImpl = (...args) => fetch(...args);

const server = () => (setting('LEFTY_SERVER') || '').replace(/\/+$/, '');
const ready = () => Boolean(server());

function label() {
  try { return `server: ${new URL(server()).host}`; } catch { return 'server: (LEFTY_SERVER is not a web address)'; }
}

function setDevice(id) { device = String(id || 'unknown'); }

async function post(route, body, timeoutMs = TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const headers = { 'Content-Type': 'application/json', 'X-Lefty-Device': device };
  const token = setting('LEFTY_APP_TOKEN');
  if (token) headers.Authorization = `Bearer ${token}`;
  try {
    const response = await fetchImpl(`${server()}${route}`, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) {
      const error = new Error(data.error || `Lefty server error ${response.status}`);
      Object.assign(error, { status: response.status, remote: true });
      if (data.retryAfterMs) error.retryAfterMs = data.retryAfterMs;
      throw error;
    }
    return data;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('Lefty server timed out');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

// Same input and answer as brain.nextStep; the screenshot travels as base64 text, and stays home in a private app
// (jpeg is null then). A spoken goal's recording (audio: { mime, data }) is already base64.
async function nextStep({ jpeg, display, ...rest }) {
  const { ok, ...step } = await post('/v1/step', { ...rest, display: { bounds: display.bounds, size: display.size }, jpeg: jpeg ? jpeg.toString('base64') : null });
  return step;
}

// Same as brain.checkCode: the file's errors and fixes.
async function checkCode({ code, fileName, goal, hint }) {
  const { ok, ...result } = await post('/v1/check-code', { code, fileName, goal, hint });
  return result;
}

// Same as brain.explain: what a control does, in a sentence or two.
async function explain({ jpeg, ...rest }) {
  const { ok, ...result } = await post('/v1/explain', { ...rest, jpeg: jpeg ? jpeg.toString('base64') : null });
  return result;
}

// Same as brain.buildProject: whole files for a project folder.
async function buildProject({ request, files, lang }) {
  const { ok, ...result } = await post('/v1/build', { request, files, lang }, BUILD_TIMEOUT_MS);
  return result;
}

async function warmUp() {
  if (Date.now() - warmedAt < WARM_FOR_MS) return;
  warmedAt = Date.now();
  await post('/v1/warmup', {});
}

function useFetch(fake) { fetchImpl = fake; warmedAt = 0; } // tests

module.exports = { ready, label, nextStep, checkCode, explain, buildProject, warmUp, setDevice, useFetch };

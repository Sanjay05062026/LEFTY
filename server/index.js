// Lefty's backend: holds the AI key so people who download Lefty don't need their own. The app sends what it would
// have sent the AI (goal, steps so far, the screen's buttons, a screenshot); the server asks the AI with the same
// brain the app uses on its own (src/brain.js) and sends back the one next step. No sign-up yet: each install
// sends a random device id, used only for optional rate limits. Nothing is stored: goals and screenshots are
// passed to the AI and forgotten, and never logged.
//
//   GET  /health     -> { ok, brain }                 is it up, and which AI it uses
//   POST /v1/step    -> the next step (see brain.nextStep), or { ok: false, error } with an HTTP error status
//   POST /v1/check-code -> the errors in a file of code and their fixes (see brain.checkCode)
//   POST /v1/explain -> what one control does, in a sentence or two (see brain.explain)
//   POST /v1/build   -> whole files for a project folder (see brain.buildProject)
//   POST /v1/warmup  -> { ok }                         a tiny request so the user's first real answer is fast
// A step may come without a screenshot (an app on the user's private list) and with a spoken goal instead of a typed
// one (audio: { mime, data } in base64).
//
// Settings (environment variables, or the .env file next to package.json):
//   GEMINI_API_KEY         the AI key (as for the app on its own)
//   PORT (default 8787), HOST (default 127.0.0.1; use 0.0.0.0 on a server)
//   LEFTY_APP_TOKEN        if set, requests must carry "Authorization: Bearer <token>"
//   LEFTY_LIMIT_PER_MIN, LEFTY_LIMIT_PER_DAY   steps per device; 0 or unset = no limit
//
// Run: npm run server

const http = require('http');
const crypto = require('crypto');

const MAX_BODY_BYTES = 8 * 1024 * 1024; // a 1024 px screenshot is ~150 KB; this leaves lots of room
const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    Object.assign(this, extra);
  }
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { reject(new HttpError(413, 'request too big')); request.destroy(); return; }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(new HttpError(400, 'not JSON')); }
    });
    request.on('error', reject);
  });
}

// Steps per device in the last minute and the last day. Kept in memory: a restart forgets them, which is fine.
function createLimiter({ perMinute = 0, perDay = 0, now = Date.now } = {}) {
  const seen = new Map(); // device -> timestamps of its steps in the last day
  return {
    take(device) {
      if (!perMinute && !perDay) return null;
      const t = now();
      const times = (seen.get(device) || []).filter((at) => t - at < DAY_MS);
      const lastMinute = times.filter((at) => t - at < MINUTE_MS);
      if (perMinute && lastMinute.length >= perMinute) return { retryAfterMs: MINUTE_MS - (t - lastMinute[0]) };
      if (perDay && times.length >= perDay) return { retryAfterMs: DAY_MS - (t - times[0]) };
      times.push(t);
      seen.set(device, times);
      return null;
    },
  };
}

const MAX_AUDIO_CHARS = 6 * 1024 * 1024; // base64 of about 4 MB: two minutes of 16 kHz speech

// A spoken goal: { mime: 'audio/...', data: base64 }, or null.
function audioInput(audio) {
  if (audio == null) return null;
  if (typeof audio !== 'object' || !/^audio\/[\w.+-]+$/.test(String(audio.mime || '')) || typeof audio.data !== 'string' || !audio.data) {
    throw new HttpError(400, 'audio is not a recording');
  }
  if (audio.data.length > MAX_AUDIO_CHARS) throw new HttpError(413, 'recording too long');
  return { mime: audio.mime, data: audio.data };
}

// The step request, checked: only the fields the brain uses, with the screenshot turned back into bytes. No
// screenshot is fine (a private app); no goal is fine when it was spoken.
function stepInput(body) {
  const audio = audioInput(body && body.audio);
  if (!body || typeof body.goal !== 'string' || (!body.goal.trim() && !audio)) throw new HttpError(400, 'goal missing');
  const display = body.display;
  if (!display || !display.bounds || !display.size) throw new HttpError(400, 'display missing');
  if (body.jpeg != null && (typeof body.jpeg !== 'string' || !body.jpeg)) throw new HttpError(400, 'screenshot is not an image');
  return {
    goal: body.goal.slice(0, 2000),
    history: Array.isArray(body.history) ? body.history.slice(-60).map(String) : [],
    note: String(body.note || '').slice(0, 500),
    app: String(body.app || '').slice(0, 200),
    title: String(body.title || '').slice(0, 300),
    elements: Array.isArray(body.elements) ? body.elements.slice(0, 400) : [],
    display: { bounds: display.bounds, size: display.size },
    imageSize: body.imageSize || display.size,
    openApps: Array.isArray(body.openApps) ? body.openApps.slice(0, 40) : [],
    auto: body.auto === true,
    jpeg: body.jpeg ? Buffer.from(body.jpeg, 'base64') : null,
    audio,
  };
}

// The explain request, checked the same way.
function explainInput(body) {
  const element = body && body.element;
  if (!element || typeof element !== 'object') throw new HttpError(400, 'control missing');
  if (body.jpeg != null && (typeof body.jpeg !== 'string' || !body.jpeg)) throw new HttpError(400, 'picture is not an image');
  const spot = body.spot && ['x', 'y', 'w', 'h'].every((k) => Number.isFinite(body.spot[k])) ? body.spot : null;
  return {
    app: String(body.app || '').slice(0, 200),
    title: String(body.title || '').slice(0, 300),
    element: { name: String(element.name || '').slice(0, 200), type: String(element.type || '').slice(0, 40) },
    nearby: Array.isArray(body.nearby) ? body.nearby.slice(0, 30).map((n) => String(n).slice(0, 80)) : [],
    jpeg: body.jpeg ? Buffer.from(body.jpeg, 'base64') : null,
    spot,
    lang: /^[a-z]{2,3}(-[a-z0-9]{2,8})?$/i.test(String(body.lang || '')) ? String(body.lang) : '',
  };
}

// The build request: what to build and the files already in the folder (path and text only).
function buildInput(body) {
  if (!body || typeof body.request !== 'string' || !body.request.trim()) throw new HttpError(400, 'what to build is missing');
  const files = Array.isArray(body.files) ? body.files.slice(0, 200)
    .filter((f) => f && typeof f.path === 'string' && typeof f.content === 'string')
    .map((f) => ({ path: f.path.slice(0, 200), content: f.content.slice(0, 400 * 1024) })) : [];
  return {
    request: body.request.slice(0, 4000),
    files,
    lang: /^[a-z]{2,3}(-[a-z0-9]{2,8})?$/i.test(String(body.lang || '')) ? String(body.lang) : '',
  };
}

function createServer({
  brain = require('../src/brain'),
  token = brain.setting('LEFTY_APP_TOKEN'),
  limits = { perMinute: Number(brain.setting('LEFTY_LIMIT_PER_MIN')) || 0, perDay: Number(brain.setting('LEFTY_LIMIT_PER_DAY')) || 0 },
  log = (line) => console.log(`[server] ${line}`),
} = {}) {
  const limiter = createLimiter(limits);

  async function handle(request) {
    const url = new URL(request.url, 'http://lefty');
    if (request.method === 'GET' && url.pathname === '/health') return { ok: true, brain: brain.ready() ? brain.label() : 'no AI key' };
    if (request.method !== 'POST' || !['/v1/step', '/v1/check-code', '/v1/explain', '/v1/build', '/v1/warmup'].includes(url.pathname)) throw new HttpError(404, 'not found');
    if (token) {
      const sent = String(request.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const same = sent.length === token.length && crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(token));
      if (!same) throw new HttpError(401, 'this app is not allowed here');
    }
    if (!brain.ready()) throw new HttpError(503, 'the server has no AI key');
    const body = await readBody(request);
    if (url.pathname === '/v1/warmup') {
      brain.warmUp().catch(() => {});
      return { ok: true };
    }
    const device = String(request.headers['x-lefty-device'] || request.socket.remoteAddress || 'unknown').slice(0, 80);
    const limited = limiter.take(device);
    if (limited) throw new HttpError(429, 'too many steps, slow down', { retryAfterMs: limited.retryAfterMs });
    try {
      if (url.pathname === '/v1/check-code') {
        if (typeof body.code !== 'string') throw new HttpError(400, 'code missing');
        const result = await brain.checkCode({
          code: body.code.slice(0, 400000), fileName: String(body.fileName || '').slice(0, 200),
          goal: String(body.goal || '').slice(0, 2000), hint: String(body.hint || '').slice(0, 300),
        });
        return { ok: true, ...result };
      }
      if (url.pathname === '/v1/explain') {
        const { text, risky } = await brain.explain(explainInput(body));
        return { ok: true, text, risky };
      }
      if (url.pathname === '/v1/build') {
        const result = await brain.buildProject(buildInput(body));
        return { ok: true, files: result.files, summary: result.summary, run: result.run };
      }
      const step = await brain.nextStep(stepInput(body));
      return { ok: true, ...step };
    } catch (error) {
      if (error instanceof HttpError) throw error;
      // The AI's own refusals, passed on so the app can say the right thing: 429 slow down, the rest "busy".
      if (error.status === 429) throw new HttpError(429, 'the AI asked to slow down', { retryAfterMs: error.retryAfterMs });
      if (error.status === 401 || error.status === 403) throw new HttpError(502, "the server's AI key was refused");
      throw new HttpError(502, `the AI failed: ${error.message}`);
    }
  }

  return http.createServer(async (request, response) => {
    const started = Date.now();
    let status = 200;
    let reply;
    try {
      reply = await handle(request);
    } catch (error) {
      status = error.status || 500;
      reply = { ok: false, error: error.status ? error.message : 'server error' };
      if (error.retryAfterMs) reply.retryAfterMs = error.retryAfterMs;
      if (!error.status) log(`error: ${error.stack || error.message}`);
    }
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(reply));
    // Never the goal, the screen or the answer: only what's needed to see the server is healthy.
    const device = String(request.headers['x-lefty-device'] || '').slice(0, 8);
    if (request.url !== '/health') log(`${request.method} ${request.url} ${status} ${Date.now() - started} ms${device ? ` device ${device}…` : ''}${reply.ok ? '' : ` (${reply.error})`}`);
  });
}

if (require.main === module) {
  const brain = require('../src/brain');
  const port = Number(process.env.PORT || brain.setting('PORT')) || 8787;
  const host = process.env.HOST || brain.setting('HOST') || '127.0.0.1';
  createServer({ brain }).listen(port, host, () => {
    console.log(`[server] Lefty's backend on http://${host}:${port} (${brain.ready() ? brain.label() : 'no AI key: add GEMINI_API_KEY'})`);
  });
}

module.exports = { createServer, createLimiter, stepInput, explainInput, buildInput };

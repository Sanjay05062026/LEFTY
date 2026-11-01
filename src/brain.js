// Lefty's brain: sends an AI a screenshot of the user's screen plus the list of clickable things Lefty's eyes
// found, and gets back the single next step toward the user's goal. Runs in the main process, so the API key
// never reaches a web page. The AI only says what the next step is; the user makes the move (Learn mode), or Lefty
// makes it for them (Do it mode). In apps on the user's private list no screenshot is sent, only the list; a goal
// can also be spoken (the recording goes in the same request, and the answer says what was heard).
//
// The AI is Google Gemini: GEMINI_API_KEY (free tier, no card needed: aistudio.google.com/apikey), from the
// environment or a .env file next to package.json (never committed, never logged). Published copies use Lefty's
// backend instead (brain-remote.js), which holds the key.

const fs = require('fs');
const path = require('path');
const snap = require('./snap');

const MAX_ELEMENTS = 150;
const TIMEOUT_MS = 45000;
const LONG_TIMEOUT_MS = 240000; // building a whole project: many files of code
// The key lives in a .env file: next to package.json when run from the code, or in Lefty's data folder
// (%APPDATA%\lefty\.env) for the installed app, whose own files can't be changed.
const ENV_FILES = [
  path.join(__dirname, '..', '.env'),
  process.env.APPDATA ? path.join(process.env.APPDATA, 'lefty', '.env') : null,
].filter(Boolean);
const GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta';

let fetchImpl = (...args) => fetch(...args);
let geminiModel = null;  // may switch to a newer Flash model if the default one is retired

function setting(name) {
  if (process.env[name]) return process.env[name].trim();
  for (const file of ENV_FILES) {
    try {
      const line = fs.readFileSync(file, 'utf8').split(/\r?\n/).find((l) => new RegExp(`^\\s*${name}\\s*=`).test(l));
      if (line) return line.split('=').slice(1).join('=').trim().replace(/^["']|["']$/g, '') || null;
    } catch { /* no .env file there */ }
  }
  return null;
}

// Whether there's a brain right now (the .env file is re-read, so adding a key needs no restart).
const provider = () => (setting('GEMINI_API_KEY') ? 'gemini' : null);
const ready = () => provider() === 'gemini';
const modelName = () => (provider() ? setting('LEFTY_MODEL') || geminiModel || 'newest Flash' : 'none');

const label = () => `${provider() || 'no brain'}: ${modelName()}`;

const SYSTEM = `You are Lefty, a professional on-screen assistant on Windows. The user tells you a goal; you look at their
screen and say the ONE next thing they should do. Lefty points at it and the user makes the move (Learn mode), or
Lefty makes the move for them (Do it mode).

You get: the goal, the steps already done, a screenshot, a numbered list of clickable things read from the app
in front ("id type "name" (x,y wxh)" in screenshot pixels), and the other apps open on the PC.

Rules:
- Give exactly one step: the very next action on THIS screen. Never a list.
- Point with element_id from the list whenever the thing is in it. Use point when it is visible in the
  screenshot but missing from the list, or listed with a useless name (e.g. "The editor is not accessible",
  inside a canvas or web page). Look at the screenshot to be sure the element you pick is the right one.
- Use the search box of the panel that is open for the task (e.g. the Extensions panel's own "Search
  Extensions" box), not the app's global search or command bar.
- If the goal is about a different app than the one in front (or the user is on the desktop / taskbar), the
  first step is action "open_app" with app = that app's usual name, e.g. "Visual Studio Code". Lefty switches
  to it if it's open, or offers to open it. Do this even if it's not in the open apps list.
- instruction: what the step tag on screen says, 2-6 words, e.g. "Click Insert", "Type the title".
- For typing, point at the box and put what to type in text (or leave text empty if it's the user's choice).
- For keyboard shortcuts, use action "key" and put the combo in text, e.g. "Ctrl+B".
- status "done" as soon as the goal is achieved: the screen shows it, OR the steps done so far already did it
  (e.g. "Zoom in" was clicked for "make the text bigger", "New Text File" for "create a new file"). Don't add
  extra steps the user didn't ask for, and never repeat a step that was already done: if the last step done is
  the one that does the goal, the answer is done. Say it's done in message (one short sentence).
- status "need_user" when the user must decide or enter private information (passwords, payment, personal
  data): explain in message. Never ask them to share secrets with you.
- If what's needed is hidden (a collapsed or hidden toolbar, a closed menu or panel, a "More"/"..." button, a
  setting page, something scrolled away), the next step is to reveal it: point at whatever shows it, e.g.
  "Show toolbar". Never give up just because the thing isn't visible yet.
- status "impossible" only when this app truly can't do it: say why in message and suggest what to try.
- "How do I..." questions are goals: guide the steps on screen (don't explain them in words).
- status "answer" for a question that needs no steps ("what is this?", "what does this button do?", "is it
  saved?"): answer from what you see, in message, in 1-3 short, clear sentences.
- If the goal is unclear (one vague word like "tell" or "this", or you can't tell what they want), status
  "need_user" with one short question in message, e.g. "What should I help you with in VS Code?". Never
  pretend something is done.
- If the clickable list is empty, the app's buttons couldn't be read: point from the screenshot with point.
- If the user wants code written ("single linked list", "write bubble sort in java", "code to reverse a string")
  and a code editor (VS Code) is in front: action "write_code" with the complete, correct, runnable code in code.
  Lefty shows it as faint ghost text at the user's text cursor and they type over it, so: plain code only (no
  markdown fences, no explanation around it), 4-space indents, short lines, a few short comments are fine, at
  most 60 lines. Use the language they ask for, else the open file's language (from its name in the window
  title), else Python. instruction: e.g. "Type along with me". Do this right away, even with no file open.
- If the user wants errors or bugs in their code found or fixed ("find the error", "why doesn't this work", "fix my
  code") and a code editor is in front: action "check_code", instruction e.g. "Checking your code". Lefty reads the
  whole file himself, finds the errors, shows each one and offers to fix it.
- If the user wants a focus or study session ("focus mode 30 minutes, only Chrome", "study for an hour in VS Code
  and my physics tab", "stop focus mode"): action "focus" with minutes (0 to stop it) and allow = the apps, sites
  or tab words they named for their work, as short names (e.g. ["Chrome", "physics"]); allow is empty if they
  named none. Lefty closes anything else that comes up until the time is over. Never point at anything for this.
- If the user wants a whole project or several files built ("build me a portfolio website", "make a todo app",
  "create a snake game in python", "set up an express server"): action "build_project" with text = what to build,
  in one clear paragraph with every detail the user gave. Lefty asks which folder and writes the files himself, so
  do this right away, whatever app is in front. Code for the file open in the editor is write_code instead.
- Tone: calm, clear and professional. Never use emoji, emoticons or exclamation-heavy chatter.
- Guard the user: before anything destructive (deleting, overwriting, sending, paying), warn in the instruction.
- The goal is typed in a hurry: expect spelling mistakes, missing words and slang, in any language. Work out what
  the user means ("mak txt biger" = make the text bigger, "scintific mod" = scientific mode) and just do it;
  never ask them to fix their spelling.
- Speak the user's language: write instruction and message in the language of the goal (Hindi goal, Hindi
  answer; Tamil goal, Tamil answer), keeping on-screen names as the screen shows them. lang: that language's code
  (en, hi, ta, es...).
- A goal may come as a voice recording instead of text: listen to it, put exactly what the user said in heard (in
  their language and script), and answer that goal. If you can't make out what they said, status "need_user" and
  ask them to say it again.
- Sometimes there is no screenshot (the user keeps that app private): work from the clickable list alone, never
  use point, and don't mention the missing picture.`;

const FIELDS = {
  status: { type: 'string', enum: ['step', 'done', 'answer', 'need_user', 'impossible'] },
  action: { type: 'string', enum: ['click', 'double_click', 'right_click', 'type', 'key', 'scroll', 'open_app', 'write_code', 'check_code', 'focus', 'build_project'] },
  element_id: { type: 'integer', description: 'id from the clickable list' },
  app: { type: 'string', description: 'for open_app: the app to switch to or open, by its usual name' },
  instruction: { type: 'string', description: '2-6 words, shown on the step tag. Never empty for a step.' },
  text: { type: 'string', description: 'ONLY the literal text to type, or ONLY the key combo like "Ctrl+B". No explanations.' },
  message: { type: 'string', description: 'for done / answer / need_user / impossible: 1-3 short, clear sentences' },
  code: { type: 'string', description: 'for write_code: the whole code as plain text with real line breaks, no markdown fences' },
  minutes: { type: 'integer', description: 'for focus: how long, in minutes (0 stops focus mode)' },
  allow: { type: 'array', items: { type: 'string' }, description: 'for focus: the apps, sites or tab words that are for work' },
  heard: { type: 'string', description: 'only when the goal came as a voice recording: exactly what the user said' },
  lang: { type: 'string', description: "the language code of the user's goal: en, hi, ta, es..." },
};

const round = (n) => Math.round(n);
// A focus session from the answer: whole minutes up to 8 hours, and a few short app or tab names.
const focusOf = (step) => ({
  minutes: Math.max(0, Math.min(480, Math.round(Number(step.minutes) || 0))),
  allow: (Array.isArray(step.allow) ? step.allow : []).map((a) => firstLine(a, 60)).filter(Boolean).slice(0, 10),
});
const POINTED_ACTIONS = ['click', 'double_click', 'right_click', 'type']; // steps that need something to point at
const KEY_COMBO = /\b(?:(?:Ctrl|Control|Alt|Shift|Win|Windows)\s*\+\s*)+(?:[A-Za-z0-9]|F\d{1,2}|Plus|Minus|Enter|Tab|Esc|Escape|Delete|Del|Home|End|Space|Up|Down|Left|Right|PageUp|PageDown|[+=\-,./])(?![A-Za-z])/i;
// Text for the screen: no emoji (Lefty keeps a professional tone, whatever the model writes).
const plain = (value) => String(value || '').replace(/\s?[\p{Extended_Pictographic}\u{FE0F}\u{200D}]+/gu, '').replace(/[ \t]{2,}/g, ' ');
const firstLine = (value, max) => plain(value).split(/\r?\n/)[0].trim().slice(0, max);
const MAX_CODE_LINES = 120;

// Code the user will type over, ghost text style: the code inside any markdown fence, tabs as 4 spaces, no
// trailing spaces, no blank lines at either end. Line breaks sent as "\n" text instead of real ones are fixed.
function cleanCode(value) {
  let text = String(value || '').replace(/\r\n?/g, '\n');
  if (!text.includes('\n') && text.includes('\\n')) text = text.replace(/\\n/g, '\n');
  let lines = text.split('\n');
  const fence = lines.findIndex((line) => /^\s*```/.test(line));
  if (fence >= 0) {
    const close = lines.findIndex((line, i) => i > fence && /^\s*```/.test(line));
    lines = lines.slice(fence + 1, close > fence ? close : undefined);
  }
  lines = lines.map((line) => line.replace(/\t/g, '    ').replace(/\s+$/, ''));
  while (lines.length && !lines[0]) lines.shift();
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  return lines.slice(0, MAX_CODE_LINES).join('\n');
}

// elements: global DIP rects; display: the Electron display the screenshot shows (its own coordinates start at 0,0);
// scale: screenshot pixels per DIP (the screenshot is sent smaller than the screen, so it travels faster).
function describeElements(elements, display, scale = 1) {
  return elements.slice(0, MAX_ELEMENTS).map((el, i) => {
    const r = el.rect;
    // Chromium apps (VS Code...) name some text boxes "The editor is not accessible at this time...": say what it is.
    const name = /editor is not accessible/i.test(el.name || '') ? 'text box (unlabelled)' : String(el.name || '').slice(0, 60);
    return `${i} ${el.type} "${name}"${el.enabled === false ? ' disabled' : ''} (${round((r.x - display.bounds.x) * scale)},${round((r.y - display.bounds.y) * scale)} ${round(r.w * scale)}x${round(r.h * scale)})`;
  }).join('\n');
}

/* ---------- Gemini (free tier) ----------
   Plain REST, no extra package. The answer is forced into JSON by a response schema. Gemini locates things
   on images in a 0-1000 grid, so its point is asked for (and converted) that way. */
function geminiError(status, body) {
  const error = new Error((body && body.error && body.error.message) || `Gemini error ${status}`);
  error.status = status === 400 && /api key/i.test(error.message) ? 401 : status; // a bad key comes back as 400
  // "Slow down" answers say how long to wait, e.g. { "@type": "...RetryInfo", "retryDelay": "7s" }.
  const retry = ((body && body.error && body.error.details) || []).find((d) => d && d.retryDelay);
  if (retry) error.retryAfterMs = Math.round(parseFloat(retry.retryDelay) * 1000);
  return error;
}

const RATE_LIMIT_RETRIES = 2;
const RATE_LIMIT_WAIT_MS = 5000;      // when Google doesn't say how long
const MAX_RATE_LIMIT_WAIT_MS = 15000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function geminiCall(model, apiKey, body, signal, timeoutMs = TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true }); // the other model won the race
  try {
    const response = await fetchImpl(`${GEMINI_API}/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw geminiError(response.status, data);
    return data;
  } catch (error) {
    if (error.name === 'AbortError') throw signal && signal.aborted ? new Error('cancelled') : Object.assign(new Error('Gemini timed out'), { timeout: true });
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

// Speed matters most: Lefty waits on every answer. Measured on Lefty's requests, a Flash model with "minimal"
// thinking answers in about 2 s, while the biggest models and default thinking take 6-20 s (and the newest ones
// are often overloaded). So:
//  - the fast models go first (if this key has them), then the newest Flash models it can use;
//  - thinking is "minimal", or "low" on models that don't offer minimal;
//  - the best model is asked first; if it hasn't answered within 5 s, the next one is asked too and the first
//    good answer wins, so one busy server never stalls Lefty. (Flash-Lite answers fastest but judges "done"
//    worse, so it is only the backup.) LEFTY_MODEL pins one model.
const FAST_MODELS = ['gemini-3.6-flash', 'gemini-3.7-flash']; // measured: ~3.5 s each and right on real screens
const GEMINI_FALLBACK = [...FAST_MODELS, 'gemini-flash-latest', 'gemini-3.5-flash-lite'];
const RACE = 2;
const TRY_NEXT_ON = [404, 429, 500, 503];
// Worth asking another model: this one is gone, out of quota, overloaded or too slow right now.
const tryNext = (error) => Boolean(error) && (TRY_NEXT_ON.includes(error.status) || Boolean(error.timeout));
const BUSY_WAIT_MS = 3000;     // every model busy or slow: one more round after this pause
const BUSY_BUDGET_MS = 100000; // but a normal question never waits longer than this in all
const MAX_MODEL_TRIES = 6;
let flashModels = null;          // this key's Flash models, newest first (fetched once)
const thinkingFor = new Map();   // model -> thinking level it accepts ('minimal' unless it refused)

async function listFlash(apiKey) {
  if (flashModels) return flashModels;
  try {
    const response = await fetchImpl(`${GEMINI_API}/models?pageSize=200`, { headers: { 'x-goog-api-key': apiKey } });
    const data = await response.json().catch(() => ({}));
    const names = (data.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m) => String(m.name || '').replace(/^models\//, ''))
      .filter((name) => /^gemini-\d+(\.\d+)?-flash(-lite)?$/.test(name));
    if (names.length) flashModels = names;
  } catch { /* offline: the request itself will say so */ }
  return flashModels;
}

// Always the same order (best first), minus models Google has retired for this key and models resting after
// running out of quota (unless every model is resting: then they're all tried, and the wait-and-retry applies).
const retired = new Set();
const restingUntil = new Map();
const REST_MS = 10 * 60 * 1000;
async function geminiCandidates(apiKey) {
  const available = await listFlash(apiKey);
  let order;
  if (!available) {
    order = GEMINI_FALLBACK;
  } else {
    const version = (name) => parseFloat(name.split('-')[1]);
    const newestFlash = available.filter((name) => !name.endsWith('-lite')).sort((a, b) => version(b) - version(a));
    const fast = FAST_MODELS.filter((name) => available.includes(name));
    // Flash-Lite answers fast but gets more steps wrong (wrong search box, "done" too early): last resort only.
    const lite = available.filter((name) => name.endsWith('-lite')).sort((a, b) => version(b) - version(a));
    order = [...new Set([...fast, ...newestFlash, ...lite])];
  }
  order = order.filter((name) => !retired.has(name));
  const awake = order.filter((name) => !(restingUntil.get(name) > Date.now()));
  return awake.length ? awake : order;
}

// One model, one answer: asks with the lightest thinking the model accepts and returns the parsed step. long: a big
// job (building a project) that is worth more thinking and a longer wait.
async function askModel(model, apiKey, body, signal, { long = false } = {}) {
  for (;;) {
    const lightest = thinkingFor.get(model) || 'minimal';
    const level = long && lightest !== 'none' ? 'medium' : lightest;
    const request = { ...body, generationConfig: { ...body.generationConfig } };
    if (level !== 'none') request.generationConfig.thinkingConfig = { thinkingLevel: level };
    let data;
    try {
      data = await geminiCall(model, apiKey, request, signal, long ? LONG_TIMEOUT_MS : TIMEOUT_MS);
    } catch (error) {
      if (error.status === 400 && /thinking/i.test(error.message) && long && level === 'medium') { long = false; continue; } // no thinking choice here: as usual
      if (error.status === 400 && /thinking/i.test(error.message) && level !== 'none') {
        thinkingFor.set(model, level === 'minimal' ? 'low' : 'none'); // this model can't think that little: one step up
        continue;
      }
      if (error.status === 404) retired.add(model); // gone for this key: don't ask it again
      // Out of quota: rest this model for a while so Lefty doesn't wait ~2 s on its refusal every time.
      if (error.status === 429) restingUntil.set(model, Date.now() + Math.max(error.retryAfterMs || 0, error.retryAfterMs ? 60000 : REST_MS));
      throw error;
    }
    const candidate = (data.candidates || [])[0];
    const answer = candidate && candidate.content && (candidate.content.parts || []).map((p) => p.text || '').join('');
    if (!answer) throw new Error(`Gemini gave no step${candidate && candidate.finishReason ? ` (${candidate.finishReason})` : ''}`);
    const step = parseJson(answer);
    if (!step) throw new Error('Gemini answered in a broken format');
    return { model, step, usage: data.usageMetadata || {} };
  }
}

// The first good answer from a few models asked at once; the rest are cancelled.
// Quality first, with a speed backup: the best model is asked first; if it hasn't answered within hedgeMs (or
// fails), the next one is asked too, and the first good answer wins. The others are cancelled.
let hedgeMs = 5000; // Flash answers in ~3.5-4 s; Flash-Lite is no faster on big screens and gets more steps wrong

function raceModels(models, ask, hedge = hedgeMs) {
  const controllers = models.map(() => new AbortController());
  const timers = [];
  const errors = [];
  return new Promise((resolve, reject) => {
    let started = 0;
    let finished = false;
    const end = () => { finished = true; timers.forEach(clearTimeout); controllers.forEach((c) => c.abort()); };
    const startNext = () => {
      if (finished || started >= models.length) return;
      const i = started++;
      ask(models[i], controllers[i].signal).then(
        (result) => { if (!finished) { end(); resolve(result); } },
        (error) => {
          if (finished) return;
          errors.push(error);
          if (errors.length === models.length) { end(); reject(errors.find((e) => !tryNext(e)) || error); } else startNext();
        },
      );
      if (started < models.length) timers.push(setTimeout(startNext, hedge));
    };
    startNext();
  });
}

// The JSON answer, even when wrapped in a code fence or followed by stray text.
function parseJson(text) {
  try { return JSON.parse(text); } catch { /* try harder */ }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}

// Gemini's schema format spells types in capitals (STRING, OBJECT...).
function geminiSchema(schema) {
  if (Array.isArray(schema)) return schema.map(geminiSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    out[key] = key === 'type' && typeof value === 'string' ? value.toUpperCase() : key === 'enum' ? value : geminiSchema(value);
  }
  return out;
}

// jpeg: the screenshot (null in a private app); audio: { mime, data } (base64) when the goal was spoken.
async function askGemini({ text, jpeg, audio }) {
  const parts = [];
  if (jpeg) parts.push({ inlineData: { mimeType: 'image/jpeg', data: jpeg.toString('base64') } });
  if (audio) parts.push({ inlineData: { mimeType: audio.mime, data: audio.data } });
  parts.push({ text });
  const { answer, usage } = await geminiJson({
    system: SYSTEM,
    parts,
    schema: {
      type: 'object',
      properties: {
        ...FIELDS,
        point: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, description: 'only when the target is not in the list: x and y from 0 to 1000 across the screenshot width and height' },
      },
      required: ['status', 'instruction'],
    },
  });
  return { step: answer, pointScale: 1000, usage };
}

// One JSON answer shaped by schema, from the best Gemini model that answers (see geminiCandidates and raceModels).
async function geminiJson({ system, parts, schema, maxTokens = 8192, long = false }) {
  const apiKey = setting('GEMINI_API_KEY');
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts }],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: maxTokens, // room for the model's own thinking, and for fixed code
      responseMimeType: 'application/json',
      responseSchema: geminiSchema(schema),
    },
  };
  const pinned = setting('LEFTY_MODEL');
  const models = pinned ? [pinned] : (await geminiCandidates(apiKey)).slice(0, MAX_MODEL_TRIES);
  let result = null;
  let lastError = null;
  // Google's free tier allows a few requests a minute per model. When every model says "slow down" (429),
  // Lefty waits as long as Google asks (a few seconds) and tries again instead of giving up. When they are all
  // overloaded (503) or too slow, he tries once more after a short pause, within BUSY_BUDGET_MS.
  const startedAt = Date.now();
  const overBudget = () => !long && Date.now() - startedAt > BUSY_BUDGET_MS;
  for (let round = 0; round < RATE_LIMIT_RETRIES + 1 && !result; round += 1) {
    if (round > 0) {
      const busy = lastError && (lastError.status === 503 || lastError.status === 500 || lastError.timeout);
      if (!lastError || !(lastError.status === 429 || (busy && round === 1)) || overBudget()) break;
      await sleep(lastError.status === 429 ? Math.min(lastError.retryAfterMs || RATE_LIMIT_WAIT_MS, MAX_RATE_LIMIT_WAIT_MS) : BUSY_WAIT_MS);
    }
    for (let i = 0; i < models.length && !result && !overBudget(); i += RACE) {
      try {
        result = await raceModels(models.slice(i, i + RACE), (model, signal) => askModel(model, apiKey, body, signal, { long }), long ? LONG_TIMEOUT_MS : hedgeMs);
      } catch (error) {
        lastError = error;
        if (!tryNext(error)) throw error; // a bad key or a broken answer: no point asking others
      }
    }
  }
  if (!result) throw lastError;
  if (!pinned) geminiModel = result.model;
  const { step, usage } = result;
  return { answer: step, usage: { input: usage.promptTokenCount, output: usage.candidatesTokenCount } };
}

// Asks for the next step. Returns { status, action, instruction, text, message, target, usage } where target is
// { name, type, rect } in global DIPs (an element from the list, or a small spot around a point), or null.
// jpeg may be null: the app is on the user's private list, so the AI works from the clickable list alone.
// audio: { mime: 'audio/wav', data: base64 } when the goal was spoken; the answer then says what was heard.
async function nextStep({ goal, history, note, app, title, elements, display, jpeg = null, imageSize = display.size, openApps = [], auto = false, audio = null, earlier = [] }) {
  const scale = jpeg ? imageSize.width / display.size.width : 1;
  if (!ready()) throw new Error('no API key');
  const voice = audio && /^audio\/[\w.+-]+$/.test(String(audio.mime || '')) && typeof audio.data === 'string' && audio.data ? audio : null;
  const done = history.length ? history.map((step, i) => `${i + 1}. ${step}`).join('\n') : '(nothing yet)';
  const others = openApps.slice(0, 20).map((w) => `${w.app}${w.title && w.title !== w.app ? ` ("${String(w.title).slice(0, 70)}")` : ''}`).join(', ');
  const text = [
    earlier.length ? `Earlier in this chat (for context; the goal below is what to do now):\n${earlier.join('\n')}` : '',
    voice ? 'Goal: spoken in the voice recording (listen to it, and put what the user said in heard)' : `Goal: ${goal}`,
    `App in front: ${app}${title ? ` (window "${title}")` : ''}`,
    `Other open apps: ${others || '(none)'}`,
    `Steps done so far:\n${done}`,
    note ? `Since then: ${note}` : '',
    auto ? 'Mode: Do it. Lefty clicks and types for the user, so for a typing step put the exact text in text whenever the goal says what to type; leave it empty only when it is the user\'s own choice (a file name, a message) or private.' : '',
    jpeg ? `Screenshot: ${imageSize.width}x${imageSize.height} pixels` : 'Screenshot: none (a private app: use the clickable list only)',
    `Clickable things:\n${describeElements(elements, display, scale) || '(none found)'}`,
  ].filter(Boolean).join('\n\n');

  const ask = (prompt) => askGemini({ text: prompt, jpeg, audio: voice });
  const targetOf = (step, pointScale) => {
    const el = Number.isInteger(step.element_id) && step.element_id < MAX_ELEMENTS ? elements[step.element_id] : null;
    // guessed: a box worked out from its neighbours (snap.js); titleBar: the window's own Close / Minimize buttons
    if (el) return { name: el.name, type: el.type, rect: el.rect, ...(el.guessed ? { guessed: true } : {}), ...(el.titleBar ? { titleBar: true } : {}) };
    // A point is a place in the screenshot: without one it means nothing.
    if (!jpeg || !step.point || !Number.isFinite(step.point.x) || !Number.isFinite(step.point.y)) return null;
    const size = 36;
    const x = pointScale ? (step.point.x / pointScale) * display.size.width : step.point.x / scale;
    const y = pointScale ? (step.point.y / pointScale) * display.size.height : step.point.y / scale;
    return {
      name: firstLine(step.instruction, 60) || 'here', type: 'Spot',
      rect: { x: display.bounds.x + x - size / 2, y: display.bounds.y + y - size / 2, w: size, h: size },
    };
  };

  let { step, pointScale, usage } = await ask(text);
  let target = targetOf(step, pointScale);
  // "Click Install" with nothing to point at is no help to someone looking for the button: ask once more.
  if (step.status === 'step' && POINTED_ACTIONS.includes(step.action || 'click') && !target) {
    ({ step, pointScale, usage } = await ask(`${text}\n\nYour last answer said "${firstLine(step.instruction, 60)}" but gave no element_id or point. Point at it.`));
    target = targetOf(step, pointScale);
  }
  if (step.status === 'step' && step.action === 'write_code' && !cleanCode(step.code)) {
    ({ step, pointScale, usage } = await ask(`${text}\n\nYour last answer was write_code but code was empty. Put the whole code in code.`));
    target = targetOf(step, pointScale);
  }
  // "Done" while pointing at something nobody clicked yet (seen from the weaker backup models: "done" with the
  // Standard Calculator item still to click) is a contradiction: ask once more which it is.
  if (step.status === 'done' && target && target.type !== 'Spot' && !history.some((h) => h.includes(`"${target.name}"`) || h.includes(target.name))) {
    ({ step, pointScale, usage } = await ask(`${text}

Your last answer said done but also pointed at "${firstLine(target.name, 60)}", which hasn't been clicked. If that still needs doing, answer it as the next step; if the goal really is achieved on screen, answer done without element_id.`));
    target = targetOf(step, pointScale);
  }
  // A guessed spot, or a pick that doesn't fit the step, moves to the real element whose name fits (snap.js).
  const snapped = (s, t) => (POINTED_ACTIONS.includes(s.action || 'click')
    ? snap.snapTarget(t, { instruction: s.instruction, text: s.text, action: s.action || 'click', elements, screen: { w: display.size.width, h: display.size.height } })
    : t);
  target = snapped(step, target);
  // Still a guess for a step that names something ("Pick red") although the screen's buttons could be read: it's
  // probably hidden (Paint's colours behind "Show toolbar"). Ask once more, saying so.
  if (step.status === 'step' && target && target.type === 'Spot' && elements.length && snap.keyWords(step.instruction, step.text).length) {
    ({ step, pointScale, usage } = await ask(`${text}\n\nYour last answer guessed a spot for "${firstLine(step.instruction, 60)}", but nothing in the clickable list matches it. If it is hidden (behind a "Show toolbar", "More" or "..." button, a closed menu or panel), point at what reveals it instead. Otherwise point at it in the screenshot again.`));
    target = snapped(step, targetOf(step, pointScale));
  }
  // Models sometimes leak their reasoning into a field: keep only what fits on a step tag.
  const action = step.action || 'click';
  let keys = action === 'key' ? (String(step.text || '').match(KEY_COMBO) || [''])[0] : '';
  if (action === 'key' && !keys) keys = (String(step.instruction || '').match(KEY_COMBO) || [''])[0];
  const instruction = firstLine(step.instruction, 60) || (keys ? `Press ${keys}` : target ? `Click ${target.name}` : '');
  return {
    status: step.status || 'impossible',
    action,
    instruction,
    text: action === 'key' ? keys : action === 'build_project' ? String(step.text || '').trim().slice(0, 2000) : firstLine(step.text, 200),
    message: plain(step.message).trim().slice(0, 300),
    app: action === 'open_app' ? firstLine(step.app || step.text, 60) : '',
    code: action === 'write_code' ? cleanCode(step.code) : '',
    target: ['open_app', 'write_code', 'check_code', 'focus', 'build_project'].includes(action) ? null : target,
    ...(action === 'focus' ? focusOf(step) : {}),
    heard: voice ? firstLine(step.heard, 300) : '',
    lang: /^[a-z]{2,3}(-[a-z0-9]{2,8})?$/i.test(String(step.lang || '').trim()) ? String(step.lang).trim() : '',
    usage,
  };
}

/* ---------- "What does this do?" ----------
   The user rests the mouse on a control and asks. The AI gets the control's name and type, the controls around it,
   and (unless the app is private) a small picture of the area around it, and explains it in a sentence or two. */
const EXPLAIN_SYSTEM = `You are Lefty, a professional on-screen assistant on Windows. The user points at one control in an app
and asks "what does this do?". You get the app, the window title, the control's name and type, the controls around
it, and sometimes a picture of the area around it with the control's place in it. Say what happens when it is used,
in one or two short, plain sentences for someone who has never used this app: no jargon, no markdown, don't start
with "This button". If using it deletes, sends, buys, closes or shares something, say so plainly. If you can't be
sure, give your best guess and say it's a guess. Write in the language given by lang (English if none). Never use emoji.`;

const EXPLAIN_SCHEMA = {
  type: 'object',
  properties: {
    explanation: { type: 'string', description: 'one or two short, plain sentences' },
    risky: { type: 'boolean', description: 'true when using it deletes, sends, buys, closes or shares something' },
  },
  required: ['explanation'],
};

// element: { name, type }; nearby: names of the controls around it; jpeg: the area around it (null in a private app);
// spot: where the control is in that picture, { x, y, w, h } in its pixels. Returns { text, risky, usage }.
async function explain({ app = '', title = '', element, nearby = [], jpeg = null, spot = null, lang = '' }) {
  if (!ready()) throw new Error('no API key');
  const name = String((element && element.name) || '').slice(0, 120);
  const text = [
    `App: ${app || 'unknown'}${title ? ` (window "${String(title).slice(0, 120)}")` : ''}`,
    `The control: ${(element && element.type) || 'control'} "${name || '(no name)'}"`,
    nearby.length ? `Around it: ${nearby.slice(0, 20).map((n) => `"${String(n).slice(0, 60)}"`).join(', ')}` : '',
    jpeg && spot ? `In the picture it is at ${round(spot.x)},${round(spot.y)} (${round(spot.w)}x${round(spot.h)} pixels).` : '',
    jpeg ? '' : 'No picture (a private app, or none was taken).',
    `lang: ${lang || 'en'}`,
  ].filter(Boolean).join('\n');
  const parts = jpeg ? [{ inlineData: { mimeType: 'image/jpeg', data: jpeg.toString('base64') } }, { text }] : [{ text }];
  const { answer, usage } = await geminiJson({ system: EXPLAIN_SYSTEM, parts, schema: EXPLAIN_SCHEMA });
  const said = plain(answer.explanation).replace(/\s+/g, ' ').trim().slice(0, 400);
  if (!said) throw new Error('Gemini gave no explanation');
  return { text: said, risky: answer.risky === true, usage };
}

/* ---------- Code doctor ----------
   "Find the error" in VS Code: Lefty reads the whole file himself (main.js copies it) and the AI finds the errors and
   the smallest fix for each, as replacement lines. One mistake often causes several messages ("b==2" leaves b
   undefined further down): only the cause is reported, so fixing it clears the rest. */
const DOCTOR_SYSTEM = `You are Lefty's code doctor. You get one file of code; every line starts with its number and "| ".
Find the real errors: syntax errors, names used before they exist, wrong operators (== where = was meant), typos in
names, wrong indentation, wrong calls or arguments, and logic slips that make the code fail or give a clearly wrong
result. For each error give the smallest fix: "fixed" is the exact new text for lines line..end_line, keeping the
file's indentation, without line numbers or markdown fences. When one mistake causes several errors, report only the
cause. Style, naming and missing comments are not errors. Order by line, at most 10. "message": what's wrong in plain
words, at most 12 words, plain, e.g. "== compares; use = to give b a value". If nothing is wrong, problems is empty
and summary says so in one short sentence; otherwise summary sums up in one short sentence. Never use emoji.`;

const DOCTOR_SCHEMA = {
  type: 'object',
  properties: {
    problems: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          line: { type: 'integer', description: 'first line of the fix (1-based)' },
          end_line: { type: 'integer', description: 'last line the fix replaces; same as line for one line' },
          message: { type: 'string' },
          fixed: { type: 'string', description: 'the new text for those lines, real line breaks, original indentation' },
        },
        required: ['line', 'message', 'fixed'],
      },
    },
    summary: { type: 'string' },
  },
  required: ['problems'],
};
const MAX_DOCTOR_LINES = 1500;
const MAX_PROBLEMS = 10;

// The fix as plain lines: no markdown fence, no "12| " numbers copied back, no trailing spaces or \r.
function cleanFix(value) {
  let lines = String(value || '').replace(/\r\n?/g, '\n').split('\n');
  const fence = lines.findIndex((l) => /^\s*```/.test(l));
  if (fence >= 0) {
    const close = lines.findIndex((l, i) => i > fence && /^\s*```/.test(l));
    lines = lines.slice(fence + 1, close > fence ? close : undefined);
  }
  if (lines.every((l) => /^\s*\d+\| ?/.test(l) || !l.trim())) lines = lines.map((l) => l.replace(/^\s*\d+\| ?/, ''));
  return lines.map((l) => l.replace(/\s+$/, '')).join('\n');
}

// code: the whole file. Returns { problems: [{ line, endLine, message, fixed }], summary, usage }, problems in line
// order without overlaps, each checked against the file (a fix that changes nothing is dropped).
async function checkCode({ code, fileName = '', goal = '', hint = '' }) {
  if (!ready()) throw new Error('no API key');
  const lines = String(code || '').replace(/\r\n?/g, '\n').split('\n');
  const shown = lines.slice(0, MAX_DOCTOR_LINES);
  const numbered = shown.map((l, i) => `${i + 1}| ${l}`).join('\n');
  const text = [
    `File: ${fileName || '(unsaved)'}${lines.length > shown.length ? ` (first ${shown.length} of ${lines.length} lines)` : ''}`,
    goal ? `The user asked: ${goal}` : '',
    hint ? `The editor says: ${hint}` : '',
    `Code:\n${numbered}`,
  ].filter(Boolean).join('\n\n');
  const { answer, usage } = await geminiJson({ system: DOCTOR_SYSTEM, parts: [{ text }], schema: DOCTOR_SCHEMA });
  const problems = [];
  for (const p of (Array.isArray(answer.problems) ? answer.problems : []).slice().sort((a, b) => a.line - b.line)) {
    const line = Math.round(Number(p.line));
    const endLine = Math.max(line, Math.round(Number(p.end_line) || line));
    if (!(line >= 1 && endLine <= shown.length)) continue;
    if (problems.length && line <= problems[problems.length - 1].endLine) continue; // overlaps the previous fix
    const fixed = cleanFix(p.fixed);
    if (fixed === lines.slice(line - 1, endLine).join('\n')) continue; // changes nothing
    problems.push({ line, endLine, message: firstLine(p.message, 120) || 'Something is wrong here', fixed });
    if (problems.length >= MAX_PROBLEMS) break;
  }
  return { problems, summary: firstLine(answer.summary, 200), usage };
}

/* ---------- Building a project ----------
   "Build me a website": the user picks a folder, and the AI gets what to build plus the files already there (to change
   them), and answers with whole files. Every path is checked here (safePath) and again where main writes them. */
const BUILD_SYSTEM = `You are Lefty's builder, a senior developer. You get what the user wants built and the files already in
their project folder (maybe none). Answer with every file to create or change: path relative to the folder with
forward slashes, and the COMPLETE content of each file (never a diff, never "..." or "rest unchanged" placeholders).
Write complete, working, good-looking, well-structured code with a few helpful comments. Match the size of the work to
the request: "simple" or "basic" means one clean page or a small program; "complex", "advanced", "full",
"professional" or a list of features means a real multi-file project: for a website several pages with shared
navigation, a responsive layout, real content (no lorem ipsum), interactivity in JavaScript (menus, form checks,
filters, modals, animations) and one consistent design in CSS; for other programs separate modules and error handling.
Never shrink a big request into a toy, and build every feature the user names. A website opens straight from
index.html in a browser: plain HTML, CSS and JavaScript linked by relative paths, no build step, unless the user asks
for a framework. For other projects add a short README.md saying how to run it, and the files a beginner needs (e.g.
requirements.txt or package.json). When files already exist, keep their style and change only what the request needs;
leave untouched files out. Never write secrets, keys or passwords into files. At most 25 files. summary: one or two
short sentences on what you made. run: one short line on how to open or run it. Write summary and run in the
language given by lang. Never use emoji in them.`;

const BUILD_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    run: { type: 'string' },
    files: {
      type: 'array',
      items: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
    },
  },
  required: ['summary', 'files'],
};
const MAX_BUILD_FILES = 25;
const MAX_FILE_CHARS = 400 * 1024;
const MAX_CONTEXT_CHARS = 300 * 1024; // the existing files the AI is shown, all together

// A path inside the project folder, with forward slashes, or '' when it isn't one (absolute, a drive, '..', tool
// folders like .git, .env files, or names Windows refuses).
function safePath(value) {
  const p = String(value || '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (!p || p.length > 200 || /^[a-z]:|^\/|^~/i.test(p) || /[<>:"|?*\u0000-\u001f]/.test(p)) return '';
  const parts = p.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(part) || / $|\.$/.test(part))) return '';
  if (/^(\.git|node_modules)$/i.test(parts[0]) || /^\.env(\..*)?$/i.test(parts[parts.length - 1])) return '';
  return parts.join('/');
}

// request: what to build; files: [{ path, content }] already in the folder. Returns { files, summary, run, usage }.
async function buildProject({ request, files = [], lang = '' }) {
  if (!ready()) throw new Error('no API key');
  let budget = MAX_CONTEXT_CHARS;
  const shown = [];
  for (const f of files) {
    const content = String(f.content || '');
    if (content.length > budget) { shown.push(`--- ${f.path} (too big to show)`); continue; }
    budget -= content.length;
    shown.push(`--- ${f.path}\n${content}`);
  }
  const text = [
    `Build: ${String(request || '').slice(0, 4000)}`,
    shown.length ? `Files already in the folder:\n${shown.join('\n')}` : 'The folder is empty.',
    `lang: ${lang || 'en'}`,
  ].join('\n\n');
  const { answer, usage } = await geminiJson({ system: BUILD_SYSTEM, parts: [{ text }], schema: BUILD_SCHEMA, maxTokens: 65536, long: true });
  const out = new Map();
  for (const f of Array.isArray(answer.files) ? answer.files : []) {
    const path = safePath(f && f.path);
    if (!path || typeof f.content !== 'string' || f.content.length > MAX_FILE_CHARS) continue;
    out.set(path.toLowerCase(), { path, content: f.content.replace(/\r\n?/g, '\n') });
    if (out.size >= MAX_BUILD_FILES) break;
  }
  if (!out.size) throw new Error('Gemini wrote no files');
  return { files: [...out.values()], summary: plain(answer.summary).trim().slice(0, 400), run: firstLine(answer.run, 200), usage };
}

// The first request after a while is slow (finding the models, opening connections: up to ~20 s), later ones
// take 1-2 s. So when Lefty is summoned, a tiny request goes out while the user is still typing their goal.
const WARM_FOR_MS = 2 * 60 * 1000;
let warmedAt = 0;

async function warmUp() {
  if (provider() !== 'gemini' || !ready() || Date.now() - warmedAt < WARM_FOR_MS) return;
  warmedAt = Date.now();
  const apiKey = setting('GEMINI_API_KEY');
  const pinned = setting('LEFTY_MODEL');
  const models = pinned ? [pinned] : (await geminiCandidates(apiKey)).slice(0, RACE);
  const body = {
    contents: [{ role: 'user', parts: [{ text: 'Reply with {"status":"done"}' }] }],
    generationConfig: { maxOutputTokens: 50, responseMimeType: 'application/json' },
  };
  await Promise.allSettled(models.map((model) => askModel(model, apiKey, body)));
}

// Tests hand in fakes so they never call a real API.
function useFetch(fake) { fetchImpl = fake; warmedAt = 0; restingUntil.clear(); retired.clear(); }
function useHedge(ms) { hedgeMs = ms; }

module.exports = { ready, nextStep, checkCode, explain, buildProject, safePath, warmUp, describeElements, cleanCode, cleanFix, label, provider, setting, useFetch, useHedge };

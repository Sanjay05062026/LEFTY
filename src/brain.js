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

// Whether there's a brain right now (the .env file is re-read, so adding a key needs no restart). With no key,
// or no internet, the local brain on this PC answers instead (see "Offline" below).
const provider = () => (localFirst() && localUp ? 'local' : setting('GEMINI_API_KEY') ? 'gemini' : null);
function ready() {
  if (!setting('GEMINI_API_KEY')) checkLocal().catch(() => {}); // Ollama may have started since: true next time
  return provider() !== null;
}
const modelName = () => (provider() === 'local' ? localModel() : provider() ? setting('LEFTY_MODEL') || geminiModel || 'newest Flash' : 'none');

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
- If the user wants code written ("single linked list", "write bubble sort in java", "code to reverse a string"):
  action "write_code" with the complete, correct, runnable code in code, whatever app is in front. Never open_app
  VS Code first: Lefty makes a new folder and opens VS Code on it himself. Only another editor the user names
  (PyCharm, Notepad++) is opened first.
  Lefty shows it as faint ghost text at the user's text cursor and they type over it, so: plain code only (no
  markdown fences, no explanation around it), 4-space indents, short lines, a few short comments are fine, at
  most 60 lines. Use the language they ask for, else the open file's language (from its name in the window
  title), else Python. Also give file: a short name for a file of its own, with the right extension
  ("linear_search.py", "Stack.java"), because Lefty gives the code a new folder and never touches the file or
  project the user has open. instruction: e.g. "Type along with me". Do this right away, even with no file open.
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
  file: { type: 'string', description: 'for write_code: a short file name with the right extension, e.g. "linear_search.py". The code goes in a new file of its own.' },
  lang: { type: 'string', description: 'for write_code: the language, lower case, e.g. "python"' },
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
    const level = long && lightest !== 'none' ? 'high' : lightest;
    const request = { ...body, generationConfig: { ...body.generationConfig } };
    if (level !== 'none') request.generationConfig.thinkingConfig = { thinkingLevel: level };
    let data;
    try {
      data = await geminiCall(model, apiKey, request, signal, long ? LONG_TIMEOUT_MS : TIMEOUT_MS);
    } catch (error) {
      if (error.status === 400 && /thinking/i.test(error.message) && long && level === 'high') { long = false; continue; } // no thinking choice here: as usual
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
async function askGemini({ text, jpeg, audio, goal = '' }) {
  const parts = [];
  if (jpeg) parts.push({ inlineData: { mimeType: 'image/jpeg', data: jpeg.toString('base64') } });
  if (audio) parts.push({ inlineData: { mimeType: audio.mime, data: audio.data } });
  parts.push({ text });
  const withPoint = (description) => ({
    type: 'object',
    properties: { ...FIELDS, point: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, description } },
    required: ['status', 'instruction'],
  });
  const localStepSchema = { ...withPoint('x and y in screenshot pixels, only when the target is not in the list'), required: LOCAL_REQUIRED };
  const { answer, usage, local } = await geminiJson({
    system: SYSTEM,
    parts,
    // (a spoken goal stays with localJson, which says voice needs the internet)
    localJob: audio ? undefined : () => localStep(goal, { system: SYSTEM, localSystem: LOCAL_SYSTEM, parts, schema: localStepSchema }),
    schema: withPoint('only when the target is not in the list: x and y from 0 to 1000 across the screenshot width and height'),
    // The small local model gets lost in the full instructions (it answered "need_user" to everything) and leaves
    // out fields it may skip; a short version with every field required gets real steps from it. Qwen's vision
    // models point in the picture's own pixels, not a 0-1000 grid.
    localSystem: LOCAL_SYSTEM,
    localSchema: localStepSchema,
  });
  // The short instructions say -1 for "no element" and "" for fields that don't apply.
  if (local && answer.element_id === -1) delete answer.element_id;
  if (local && answer.point && !(answer.point.x > 0 && answer.point.y > 0)) delete answer.point;
  return { step: answer, pointScale: local ? 0 : 1000, usage };
}

const LOCAL_SYSTEM = `You are Lefty, a helper on Windows. Say the ONE next step toward the user's goal.
Answer JSON. status: "step" when there is something to do (almost always), "done" when the goal is already
reached on screen, "answer" when the goal is only a question (put the reply in message).
For a step pick action:
- open_app: the goal is about an app that is not in front; put its name in app.
- click: click something from the clickable list; put its id in element_id.
- type: type into a box; element_id of the box, the words in text.
- key: a keyboard shortcut like Ctrl+S in text.
- write_code: the goal asks for code; the whole code in code.
instruction: 2-6 words like "Click File" or "Open Calculator". Fields that do not apply: element_id -1,
other fields "". Never use emoji.`;
const LOCAL_REQUIRED = ['status', 'action', 'instruction', 'element_id', 'app', 'text', 'message'];
const LOCAL_ANSWER_SYSTEM = 'You are Lefty, a helper on Windows. Answer the question in one to three short, plain sentences, with no markdown and no emoji.';

// One JSON answer shaped by schema: from Gemini when it can be reached, else from the local brain (localJson).
// localJob: a job of several local asks that replaces the single one (a staged build), when the answer is local.
async function geminiJson(options) {
  const local = () => (options.localJob ? options.localJob() : localJson(options));
  if (localFirst()) {
    if (localUp || await checkLocal()) return local();
    if (!setting('GEMINI_API_KEY')) return local(); // says the local model isn't running
  }
  try {
    return await cloudJson(options);
  } catch (error) {
    if (!offline(error) || !localModel()) throw error;
    offlineUntil = Date.now() + OFFLINE_FOR_MS; // no internet: stay local for a while instead of waiting on it
    console.log('[lefty] no internet: the local brain answers');
    return local();
  }
}

// The best Gemini model that answers (see geminiCandidates and raceModels).
async function cloudJson({ system, parts, schema, maxTokens = 8192, long = false, temperature = 0.2 }) {
  const apiKey = setting('GEMINI_API_KEY');
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts }],
    generationConfig: {
      // 0.2 for a step on screen, where there is one right button and no room for invention. Building a project
      // is the opposite: at 0.2 the same request returns almost the same files every time, so asking again after
      // "make it better" gave back what it gave before. Designs want room to differ.
      temperature,
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

/* ---------- Offline: the local brain ----------
   With no internet (or no key), Lefty asks a vision model running on this PC through Ollama (ollama.com):
   LEFTY_LOCAL_MODEL, "lefty-vision" by default (qwen2.5vl:3b set to run wholly on the graphics card), at
   OLLAMA_HOST. It is slower and makes more mistakes than Gemini, so it is the backup: once Gemini can't be reached,
   Lefty stays local for a minute before trying the internet again. LEFTY_BRAIN=local always uses it, and
   LEFTY_LOCAL_MODEL=off turns it off. Voice still needs the internet: the local model can't hear. */
const LOCAL_TIMEOUT_MS = 90000;
const LOCAL_CTX = 8192;          // the screenshot alone is ~1,150 tokens, and the clickable list can be thousands more
const LOCAL_MAX_TOKENS = 4096;
const OFFLINE_FOR_MS = 60 * 1000;
let localFetch = (...args) => fetch(...args);
let localUp = false;             // Ollama answered with the model in its list (checkLocal)
let localNames = [];             // every model Ollama has
let offlineUntil = 0;

function localModel() {
  const model = setting('LEFTY_LOCAL_MODEL') || 'lefty-vision';
  return /^(off|none|false|0)$/i.test(model) ? null : model;
}
const hasLocal = (model) => localNames.some((name) => name === model || name === `${model}:latest`);
// Code jobs (writing code, the code doctor, building a project) go to a model trained on code when Ollama has one:
// LEFTY_LOCAL_CODER, "qwen2.5-coder:3b" by default. Measured on one todo-site request, the vision model wrote a
// script that didn't even parse. Steps on screen stay with the vision model: they need to see the screenshot.
function modelFor(kind) {
  const coder = setting('LEFTY_LOCAL_CODER') || 'qwen2.5-coder:3b';
  return kind === 'code' && !/^(off|none|false|0)$/i.test(coder) && hasLocal(coder) ? coder : localModel();
}
const ollamaHost = () => (setting('OLLAMA_HOST') || 'http://127.0.0.1:11434').replace(/\/+$/, '').replace(/^(?!https?:\/\/)/, 'http://');
const localFirst = () => Boolean(localModel()) && (!setting('GEMINI_API_KEY') || /^local$/i.test(setting('LEFTY_BRAIN') || '') || Date.now() < offlineUntil);
// The request never left this PC: no internet, no DNS, nothing listening.
const offline = (error) => Boolean(error) && /fetch failed|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ENETUNREACH|EHOSTUNREACH/i.test(`${error.message} ${error.cause && error.cause.code}`);

// Whether Ollama is running and has the model.
async function checkLocal() {
  const model = localModel();
  if (!model) return (localUp = false);
  try {
    const response = await localFetch(`${ollamaHost()}/api/tags`, { signal: AbortSignal.timeout(2000) });
    const data = await response.json();
    localNames = (data.models || []).map((m) => m.name);
    localUp = hasLocal(model);
  } catch {
    localUp = false;
    localNames = [];
  }
  return localUp;
}

// The same job as cloudJson, answered by the local model: Ollama's structured output keeps it to the schema.
// raw: the answer is plain code, not JSON (see localBuild).
async function localJson({ system, localSystem, parts, schema, localSchema, maxTokens = 8192, long = false, temperature = 0.2, kind = '', raw = false }) {
  if (parts.some((p) => p.inlineData && /^audio\//.test(p.inlineData.mimeType))) throw Object.assign(new Error('voice needs the internet'), { local: true, voice: true });
  const images = parts.filter((p) => p.inlineData && /^image\//.test(p.inlineData.mimeType)).map((p) => p.inlineData.data);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), long ? LONG_TIMEOUT_MS : LOCAL_TIMEOUT_MS);
  try {
    const response = await localFetch(`${ollamaHost()}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: modelFor(kind),
        stream: false,
        keep_alive: '30m',
        ...(raw ? {} : { format: localSchema || schema }),
        // A big job (a whole project) gets most of the context for its answer: its request is short.
        options: { temperature, num_ctx: LOCAL_CTX, num_predict: Math.min(maxTokens, long ? LOCAL_CTX - 1024 : LOCAL_MAX_TOKENS) },
        messages: [
          { role: 'system', content: localSystem || system },
          { role: 'user', content: parts.filter((p) => p.text).map((p) => p.text).join('\n\n'), ...(images.length ? { images } : {}) },
        ],
      }),
      signal: controller.signal,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(data.error || `local model error ${response.status}`), { status: response.status, local: true });
    const content = (data.message && data.message.content) || '';
    const answer = raw ? cleanFix(content) : parseJson(content);
    if (!answer) throw Object.assign(new Error('the local model answered in a broken format'), { local: true });
    localUp = true;
    return { answer, usage: { input: data.prompt_eval_count, output: data.eval_count }, local: true };
  } catch (error) {
    if (error.name === 'AbortError') throw Object.assign(new Error('the local model timed out'), { timeout: true, local: true });
    if (offline(error)) {
      localUp = false;
      throw Object.assign(new Error('the local model is not running'), { local: true, down: true });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/* What a goal asks for, read without the model. Tested on real screens, the 3B model answered "open Notepad" with
   "Close the current window", put code where nothing shows it, and wrote until it timed out on "what is 25 times 4".
   So the plain goals never reach it as a step: opening an app needs no model, and code and questions get a short ask
   of their own. Everything else (a step on the screen) goes to the model, kept short. */
const NOT_AN_APP = /\b(file|folder|menu|tab|window|page|link|settings? page|dialog|panel|document|project|new|this|that|it)\b/i;
function localAppGoal(goal) {
  const match = String(goal).trim().match(/^(?:please\s+|can you\s+)?(?:open|launch|start)\s+(?:up\s+)?(?:the\s+|my\s+)?(.+?)(?:\s+app)?[.!]*$/i);
  return match && match[1].split(/\s+/).length <= 3 && !NOT_AN_APP.test(match[1]) ? match[1] : '';
}
// "open Calculator and work out 12 x 8": well-known apps open at once, before anything is asked of the AI. Reading a
// busy screen took Gemini 25-30 s just to say "open it", the slowest step of the whole job.
const KNOWN_APPS = /^(calculator|notepad|paint|vs ?code|visual studio code|pycharm|chrome|google chrome|edge|microsoft edge|firefox|brave|word|excel|powerpoint|outlook|settings|file explorer|explorer|terminal|windows terminal|command prompt|cmd|powershell|task manager|spotify|discord|whatsapp|teams|microsoft teams|zoom|blender|snipping tool|photos|camera|clock)$/i;
function firstApp(goal) {
  const app = localAppGoal(String(goal).split(/\s+(?:and|then)\s+|,\s*|;\s*/i)[0]);
  return KNOWN_APPS.test(app) ? app : '';
}
const localCodeGoal = (goal) => /\b(write|create|make|generate|give me|show me)\b.*(\b(function|code|program|script|class|algorithm|linked list)\b|\bin (python|java|javascript|typescript|c|c\+\+|c#|go|rust)(\s|$))/i.test(goal) && !/\b(website|web ?site|web ?app|project)\b/i.test(goal);
const localBuildGoal = (goal) => /\b(build|create|make|generate|design)\b.*\b(website|web ?site|web ?page|web ?app|landing page|project|game)\b/i.test(goal);
const localQuestion = (goal) => /\?\s*$|^(what|who|when|where|why|which|calculate|explain|define|how (much|many|long|far|old|big))\b/i.test(String(goal).trim());
const CODE_FILES = { python: 'code.py', javascript: 'code.js', typescript: 'code.ts', java: 'Main.java', 'c++': 'code.cpp', cpp: 'code.cpp', 'c#': 'Code.cs', html: 'index.html', go: 'main.go', rust: 'main.rs' };
const LOCAL_STEP_TOKENS = 300;  // a step is short: more than this is the model going round in circles
const LOCAL_ANSWER_TOKENS = 200;

async function localStep(goal, options) {
  const noUsage = { input: 0, output: 0 };
  const app = localAppGoal(goal);
  if (app) return { answer: { status: 'step', action: 'open_app', app, instruction: `Open ${app}` }, usage: noUsage, local: true };
  if (localBuildGoal(goal)) return { answer: { status: 'step', action: 'build_project', instruction: 'Build the project', text: goal }, usage: noUsage, local: true };
  if (localCodeGoal(goal)) {
    const { answer, usage } = await localJson({ system: CODE_SYSTEM, parts: [{ text: `Write: ${goal}` }], maxTokens: 2048, kind: 'code', raw: true });
    const language = Object.keys(CODE_FILES).find((name) => String(goal).toLowerCase().split(/\s+/).includes(name)) || 'python';
    return { answer: { status: 'step', action: 'write_code', instruction: 'Write the code', text: goal, code: answer, file: CODE_FILES[language], lang: language }, usage, local: true };
  }
  if (localQuestion(goal)) {
    const { answer, usage } = await localJson({ system: LOCAL_ANSWER_SYSTEM, parts: [{ text: goal }], maxTokens: LOCAL_ANSWER_TOKENS, raw: true });
    return { answer: { status: 'answer', message: answer }, usage, local: true };
  }
  const result = await localJson({ ...options, maxTokens: LOCAL_STEP_TOKENS });
  if (result.answer.status === 'answer' && !result.answer.message) result.answer.message = result.answer.text || result.answer.instruction;
  return result;
}

// Asks for the next step. Returns { status, action, instruction, text, message, target, usage } where target is
// { name, type, rect } in global DIPs (an element from the list, or a small spot around a point), or null.
// jpeg may be null: the app is on the user's private list, so the AI works from the clickable list alone.
// audio: { mime: 'audio/wav', data: base64 } when the goal was spoken; the answer then says what was heard.
async function nextStep({ goal, history, note, app, title, elements, display, jpeg = null, imageSize = display.size, openApps = [], auto = false, audio = null, earlier = [] }) {
  const scale = jpeg ? imageSize.width / display.size.width : 1;
  if (!ready()) throw new Error('no API key');
  const voice = audio && /^audio\/[\w.+-]+$/.test(String(audio.mime || '')) && typeof audio.data === 'string' && audio.data ? audio : null;
  const quick = !voice && !history.length && !note ? firstApp(goal) : '';
  // "open VS Code and write a calculator": the code brings its own VS Code window, so a second one isn't opened first.
  const codeBringsEditor = /^(vs ?code|visual studio code)$/i.test(quick) && localCodeGoal(goal);
  if (quick && !codeBringsEditor && !`${app} ${title}`.toLowerCase().replace(/\s/g, '').includes(quick.toLowerCase().replace(/\s/g, ''))) {
    return { status: 'step', action: 'open_app', instruction: `Open ${quick}`, text: '', message: '', app: quick, code: '', file: '', target: null, heard: '', lang: '', usage: { input: 0, output: 0 } };
  }
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

  const ask = (prompt) => askGemini({ text: prompt, jpeg, audio: voice, goal });
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
  // Told not to, the model still opens VS Code first now and then, which would leave a second window behind.
  if (step.status === 'step' && step.action === 'open_app' && /^(vs ?code|visual studio code)$/i.test(String(step.app).trim()) && localCodeGoal(goal)) {
    ({ step, pointScale, usage } = await ask(`${text}\n\nYour last answer was open_app, but Lefty opens VS Code himself. Answer write_code with the whole code in code.`));
    target = targetOf(step, pointScale);
  }
  if (step.status === 'step' && step.action === 'write_code' && !cleanCode(step.code)) {
    ({ step, pointScale, usage } = await ask(`${text}\n\nYour last answer was write_code but code was empty. Put the whole code in code.`));
    target = targetOf(step, pointScale);
    // Still nothing: the screenshot and the element list are taking the room the code needed, so ask for the
    // code by itself. Better than telling the user to ask again, which is what he used to do.
    if (!cleanCode(step.code)) {
      const only = await writeCode({ request: step.text || step.instruction || goal, fileName: title }).catch(() => '');
      if (only) step = { ...step, code: only };
    }
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
  // The small local model invents buttons that aren't there: better to say so than to do something else.
  // It also picks real buttons that have nothing to do with the step ("Open File Explorer" on a Windows Update icon):
  // a named button has to share a word with what the step says.
  const unrelated = (t) => t && t.type !== 'Spot' && !snap.keyWords(step.instruction, '').some((word) => snap.keyWords(t.name, '').includes(word));
  if (pointScale === 0 && step.status === 'step' && POINTED_ACTIONS.includes(step.action || 'click') && (!target || unrelated(target))) {
    target = null;
    step = { status: 'need_user', message: "I can't find that on screen with my offline model. Tell me the name of the button, or try again with the internet on." };
  }
  // Models sometimes leak their reasoning into a field: keep only what fits on a step tag.
  let action = step.action || 'click';
  let keys = action === 'key' ? (String(step.text || '').match(KEY_COMBO) || [''])[0] : '';
  if (action === 'key' && !keys) keys = (String(step.instruction || '').match(KEY_COMBO) || [''])[0];
  // "12*8=" sent as keys isn't a shortcut, it's text to type: without this Lefty handed a plain calculation back.
  if (action === 'key' && !keys && !/^(enter|return|esc|escape|tab|space|backspace|delete|del|home|end|up|down|left|right|pageup|pagedown|f\d{1,2})$/i.test(String(step.text || '').trim())) {
    const typed = String(step.text || '').trim() || (String(step.instruction || '').match(/^type\s+(.+)$/i) || ['', ''])[1];
    if (typed) { action = 'type'; step = { ...step, text: typed }; }
  }
  const instruction = firstLine(step.instruction, 60) || (keys ? `Press ${keys}` : target ? `Click ${target.name}` : '');
  return {
    status: step.status || 'impossible',
    action,
    instruction,
    text: action === 'key' ? keys : action === 'build_project' ? String(step.text || '').trim().slice(0, 2000) : firstLine(step.text, 200),
    message: plain(step.message).trim().slice(0, 300),
    app: action === 'open_app' ? firstLine(step.app || step.text, 60) : '',
    code: action === 'write_code' ? cleanCode(step.code) : '',
    file: action === 'write_code' ? String(step.file || '').trim() : '',
    lang: action === 'write_code' ? String(step.lang || '').trim() : '',
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

/* ---------- Code on its own ----------
   Asking for the next step means sending a screenshot, every clickable thing on screen and the steps so far, and
   the answer has to fit in one budget alongside all that. Code is the one answer that can be long, and when it
   did not fit, "code" came back empty and Lefty said he couldn't write it. This asks for nothing but the code:
   no screenshot, no element list, a far bigger budget, so there is room for the whole thing. */
const CODE_SYSTEM = `You write code for a beginner to type over, as faint text at their cursor. Answer with the
complete, correct, runnable code and nothing else: no markdown fences, no explanation around it, 4-space indents,
short lines, a few short comments where they help. Use the language the user asks for, else the one the open file
suggests, else Python. Keep it under 60 lines unless the request plainly needs more.`;

// Just the code for a request like "single linked list in python". Returns '' when even this comes back empty.
async function writeCode({ request, fileName = '', lang = '' }) {
  if (!ready()) throw new Error('no API key');
  const text = [
    `Write: ${request}`,
    fileName ? `The open file is ${fileName}, so use its language.` : '',
    lang ? `Any comments in: ${lang}` : '',
  ].filter(Boolean).join('\n');
  const { answer } = await geminiJson({
    system: CODE_SYSTEM,
    parts: [{ text }],
    schema: { type: 'object', properties: { code: { type: 'string', description: 'the whole code, plain text with real line breaks' } }, required: ['code'] },
    maxTokens: 16384,
    kind: 'code',
  });
  return cleanCode(answer && answer.code);
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
  const { answer, usage } = await geminiJson({ system: DOCTOR_SYSTEM, parts: [{ text }], schema: DOCTOR_SCHEMA, kind: 'code' });
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
leave untouched files out. Never write secrets, keys or passwords into files. At most 25 files. When the folder already holds a project you
built and the user asks again - "make it better", "more complex", "redesign it" - do not hand back what is already
there: take it further. Add the pages, features and polish that are missing, change the layout and the look, and
make the result clearly better than what they had, not a reshuffle of it. summary: one or two
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
  const { answer, usage } = await geminiJson({
    system: BUILD_SYSTEM, parts: [{ text }], schema: BUILD_SCHEMA, maxTokens: 65536, long: true, temperature: 0.95, kind: 'code',
    // A small local model can't write a whole site in one answer: it gets lost in the long rules, sloppy at 0.95,
    // and runs out of room. So it builds in steps instead (localBuild).
    localJob: () => localBuild({ request, shown, lang }),
  });
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

/* ---------- Building with the local model, in steps ----------
   Measured on a todo-site request: in one answer the 3B models broke their own script, left out features and wrote
   a plain page. Shorter answers, each about one thing, go far better: the HTML first (with the markup of one list
   item, so the other two know what the script will create), then the CSS and the JavaScript, each written for that
   HTML. The script is then checked (does it parse, does every id it looks up exist) and sent back to fix, twice at
   most. It's always index.html, style.css and script.js: one page that opens straight in a browser. */
const LOCAL_CLASSES = 'done (a finished item), active (the selected filter or tab), hidden (anything not shown right now)';

const LOCAL_HTML_SYSTEM = `You write index.html for a website, nothing else. Plain semantic HTML: a header, a main
area, every control for EVERY feature the user names (inputs, buttons, filter buttons, a counter...), each with a
clear kebab-case id or class. In <head>: a viewport meta tag, a Google Fonts <link> (Poppins or Inter) and
<link rel="stylesheet" href="style.css">. At the end of <body>: <script src="script.js"></script>. No inline styles
or scripts. Real text, no lorem ipsum. item_template: the exact HTML of ONE item the script will add to a list
(e.g. one task with its own checkbox, text and delete button), with classes on every part; "" if there is no list.
summary: one or two short sentences on what the site does. Never use emoji.`;

const LOCAL_CSS_SYSTEM = `You write style.css for the HTML you are given, nothing else. Style every id and class in
it and in the item template, plus the classes the script adds: ${LOCAL_CLASSES}. The design matters most:
- :root CSS variables for colours: a bright primary, an accent, a soft background, text and muted text
- the Google font from the HTML everywhere; a gradient page background
- content in a centred card, max-width about 560px, rounded corners (16px+), a soft shadow, generous padding
- inputs and buttons: padding, rounded corners, no default borders, hover and focus states, transitions
- list items: spaced rows, a custom-looking checkbox, .done items struck through and faded, a small delete button
- a @keyframes animation for items appearing; .active filter button clearly highlighted; .hidden { display: none }
- @media (max-width: 600px) rules so it looks good on a phone
Write complete, polished CSS, at least 150 lines, one rule per line block. Answer with only the CSS: no markdown
fences, no explanation.`;

const LOCAL_JS_SYSTEM = `You write script.js for the HTML you are given, nothing else. Use EXACTLY the ids and classes
in the HTML; build list items with exactly the item template's markup and classes. Make EVERY feature the user names
work: addEventListener (no inline handlers); Enter in a text input does the same as its button; every item's own
controls work (tick, delete); filters only change what is shown (toggle the hidden class or re-render a filtered copy),
never the saved data; counters update after every change. When the user wants things saved, keep them in localStorage
as JSON, save after every change and load on start. Use the classes ${LOCAL_CLASSES}. Wrap it all in
document.addEventListener('DOMContentLoaded', ...). Complete, runnable code, no placeholders, one statement per line.
Answer with only the JavaScript: no markdown fences, no explanation.`;

const MAX_LOCAL_FIXES = 2;

// What's wrong with the script before anyone opens the page: it doesn't parse, or it looks up ids that aren't there.
function scriptProblems(js, html, template) {
  const markup = `${html}\n${template}`;
  try {
    new (require('vm').Script)(js, { filename: 'script.js' }); // parsed only, never run
  } catch (error) {
    return [`It does not run: ${error.message}`];
  }
  const ids = [...js.matchAll(/getElementById\(\s*['"`]([\w-]+)['"`]\s*\)|querySelector(?:All)?\(\s*['"`]#([\w-]+)['"`]\s*\)/g)].map((m) => m[1] || m[2]);
  const missing = [...new Set(ids)].filter((id) => !new RegExp(`id=["']${id}["']`).test(markup));
  return missing.length ? [`It looks up ids that are not in the HTML: ${missing.map((id) => `#${id}`).join(', ')}. Use the ids the HTML really has.`] : [];
}

// index.html always loads the other two, whatever the model wrote.
function linkFiles(html) {
  let page = String(html || '');
  if (!/href=["']style\.css["']/.test(page)) page = page.includes('</head>') ? page.replace('</head>', '  <link rel="stylesheet" href="style.css">\n</head>') : `<link rel="stylesheet" href="style.css">\n${page}`;
  if (!/src=["']script\.js["']/.test(page)) page = page.includes('</body>') ? page.replace('</body>', '  <script src="script.js"></script>\n</body>') : `${page}\n<script src="script.js"></script>`;
  return page;
}

async function localBuild({ request, shown = [], lang = '' }) {
  const ask = (system, schema, text) => localJson({ system, parts: [{ text }], schema, maxTokens: 65536, long: true, temperature: 0.3, kind: 'code' });
  // Code inside a JSON answer came back on one line: the first // comment then swallowed the rest of the script.
  // As plain text it keeps its line breaks.
  const code = (system, text) => localJson({ system, parts: [{ text }], maxTokens: 65536, long: true, temperature: 0.3, kind: 'code', raw: true });
  const usage = { input: 0, output: 0 };
  const add = (u) => { usage.input += u.input || 0; usage.output += u.output || 0; };
  const goal = `Build: ${String(request || '').slice(0, 4000)}${shown.length ? `\n\nFiles already in the folder (keep what still fits):\n${shown.join('\n').slice(0, 12000)}` : ''}`;

  const page = await ask(LOCAL_HTML_SYSTEM, {
    type: 'object',
    properties: { html: { type: 'string' }, item_template: { type: 'string' }, summary: { type: 'string' } },
    required: ['html', 'item_template', 'summary'],
  }, goal);
  add(page.usage);
  const html = linkFiles(page.answer.html);
  const template = String(page.answer.item_template || '');
  const markup = `${goal}\n\nindex.html:\n${html}${template ? `\n\nItem template (the script adds one of these per item):\n${template}` : ''}`;

  const style = await code(LOCAL_CSS_SYSTEM, markup);
  add(style.usage);
  let script = await code(LOCAL_JS_SYSTEM, markup);
  add(script.usage);
  let js = script.answer;
  for (let round = 0; round < MAX_LOCAL_FIXES; round += 1) {
    const problems = scriptProblems(js, html, template);
    if (!problems.length) break;
    console.log(`[lefty] local build: fixing script.js (${problems.join(' ')})`);
    script = await code(LOCAL_JS_SYSTEM, `${markup}\n\nYour script.js:\n${js}\n\nProblems:\n${problems.join('\n')}\n\nAnswer with the whole fixed script.js.`);
    add(script.usage);
    js = script.answer;
  }
  if (!html.trim() || !js.trim()) throw Object.assign(new Error('the local model wrote no files'), { local: true });
  return {
    answer: {
      summary: page.answer.summary,
      run: lang && !/^en/i.test(lang) ? '' : 'Open index.html in your browser.',
      files: [{ path: 'index.html', content: html }, { path: 'style.css', content: style.answer }, { path: 'script.js', content: js }],
    },
    usage,
    local: true,
  };
}

/* ---------- Chat: an answer in words, as it is written ----------
   The main page's answers: no screenshot, no buttons, just the question and the chat so far. The words reach the page
   as they arrive (onText gets each piece), from Gemini or, with no internet, the local model. */
const CHAT_SYSTEM = `You are Lefty, a friendly, professional assistant on Windows. Answer the user directly and correctly,
as long as the question needs and no longer. Plain text only: no markdown symbols like ** or #, short paragraphs,
a dash at the start of list items. Never use emoji. Answer in the language the user writes in.`;
const CHAT_MAX_TOKENS = 4096;

// Calls onLine for each line of a streamed answer as it arrives.
async function readLines(response, onLine) {
  const decoder = new TextDecoder();
  let pending = '';
  for await (const chunk of response.body) {
    pending += decoder.decode(chunk, { stream: true });
    const lines = pending.split('\n');
    pending = lines.pop();
    for (const line of lines) if (line.trim()) onLine(line.trim());
  }
  if (pending.trim()) onLine(pending.trim());
}

async function geminiStream(model, apiKey, { goal, earlier, attachments = [] }, onText) {
  const level = thinkingFor.get(model) || 'minimal';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetchImpl(`${GEMINI_API}/models/${model}:streamGenerateContent?alt=sse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: CHAT_SYSTEM }] },
        contents: [{ role: 'user', parts: [...attachments.filter((a) => a.data).map((a) => ({ inlineData: { mimeType: a.mime, data: a.data } })), { text: chatPrompt(goal, earlier, attachments) }] }],
        generationConfig: { temperature: 0.4, maxOutputTokens: CHAT_MAX_TOKENS, ...(level !== 'none' ? { thinkingConfig: { thinkingLevel: level } } : {}) },
      }),
      signal: controller.signal,
    });
    if (!response.ok) throw geminiError(response.status, await response.json().catch(() => ({})));
    const usage = {};
    await readLines(response, (line) => {
      if (!line.startsWith('data:')) return;
      const data = parseJson(line.slice(5));
      const parts = data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
      const text = (parts || []).map((p) => (p.thought ? '' : p.text || '')).join('');
      if (text) onText(text);
      if (data && data.usageMetadata) Object.assign(usage, { input: data.usageMetadata.promptTokenCount, output: data.usageMetadata.candidatesTokenCount });
    });
    return usage;
  } catch (error) {
    if (error.name === 'AbortError') throw Object.assign(new Error('Gemini timed out'), { timeout: true });
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

// Text files travel inside the prompt; images and PDFs go alongside it.
const chatPrompt = (goal, earlier = [], attachments = []) => [
  earlier.length ? `The chat so far:\n${earlier.join('\n')}` : '',
  ...attachments.filter((a) => a.text).map((a) => `File "${a.name}":\n${a.text}`),
  String(goal),
].filter(Boolean).join('\n\n');

async function localStream({ goal, earlier, attachments = [] }, onText) {
  // The local models read pictures, not PDF files.
  if (attachments.some((a) => a.mime === 'application/pdf')) throw Object.assign(new Error('a PDF needs the internet'), { local: true, pdf: true });
  const images = attachments.filter((a) => a.data).map((a) => a.data);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LOCAL_TIMEOUT_MS);
  try {
    const response = await localFetch(`${ollamaHost()}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: localModel(), stream: true, keep_alive: '30m',
        options: { temperature: 0.4, num_ctx: LOCAL_CTX, num_predict: LOCAL_MAX_TOKENS },
        messages: [{ role: 'system', content: CHAT_SYSTEM }, { role: 'user', content: chatPrompt(goal, earlier, attachments), ...(images.length ? { images } : {}) }],
      }),
      signal: controller.signal,
    });
    if (!response.ok) throw Object.assign(new Error(`local model error ${response.status}`), { status: response.status, local: true });
    const usage = {};
    await readLines(response, (line) => {
      const data = parseJson(line);
      if (data && data.message && data.message.content) onText(data.message.content);
      if (data && data.done) Object.assign(usage, { input: data.prompt_eval_count, output: data.eval_count });
    });
    return usage;
  } catch (error) {
    if (error.name === 'AbortError') throw Object.assign(new Error('the local model timed out'), { timeout: true, local: true });
    if (offline(error)) { localUp = false; throw Object.assign(new Error('the local model is not running'), { local: true, down: true }); }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

// goal: the question; earlier: ["User: ...", "Lefty: ..."]; onText: called with each new piece. Returns { text, usage }.
async function chat({ goal, earlier = [], attachments = [], onText = () => {} }) {
  if (!ready()) throw new Error('no API key');
  let text = '';
  const piece = (words) => { const clean = words.replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, ''); text += clean; if (clean) onText(clean); };
  const request = { goal, earlier, attachments };
  const local = async () => ({ usage: await localStream(request, piece) });
  let result = null;
  if (localFirst() && (localUp || await checkLocal())) result = await local();
  else {
    const apiKey = setting('GEMINI_API_KEY');
    const pinned = setting('LEFTY_MODEL');
    const models = pinned ? [pinned] : (await geminiCandidates(apiKey)).slice(0, MAX_MODEL_TRIES);
    let lastError = null;
    for (const model of models) {
      try {
        result = { usage: await geminiStream(model, apiKey, request, piece) };
        if (!pinned) geminiModel = model;
        break;
      } catch (error) {
        lastError = error;
        if (text) throw error; // part of the answer is on the page: a second model would start it again
        if (error.status === 400 && /thinking/i.test(error.message)) { thinkingFor.set(model, 'none'); continue; }
        if (offline(error) && localModel()) {
          offlineUntil = Date.now() + OFFLINE_FOR_MS;
          console.log('[lefty] no internet: the local brain answers');
          result = await local();
          break;
        }
        if (!tryNext(error)) throw error;
      }
    }
    if (!result) throw lastError;
  }
  if (!text.trim()) throw new Error('the answer came back empty');
  return { text: text.trim(), usage: result.usage };
}

// The first request after a while is slow (finding the models, opening connections: up to ~20 s), later ones
// take 1-2 s. So when Lefty is summoned, a tiny request goes out while the user is still typing their goal.
const WARM_FOR_MS = 2 * 60 * 1000;
let warmedAt = 0;

async function warmUp() {
  if (Date.now() - warmedAt < WARM_FOR_MS) return;
  // The local model takes a few seconds to load onto the graphics card: load it now (same context size as a real
  // ask, or Ollama would load it again), so the first answer doesn't wait for that.
  if (localFirst() && await checkLocal()) {
    warmedAt = Date.now();
    await localFetch(`${ollamaHost()}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: localModel(), messages: [], keep_alive: '30m', options: { num_ctx: LOCAL_CTX } }),
    }).catch(() => {});
    return;
  }
  if (provider() !== 'gemini') return;
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
// useFetch also cuts off the local brain, so a test never reaches a real Ollama by accident; useLocalFetch fakes it.
function useFetch(fake) {
  fetchImpl = fake; warmedAt = 0; restingUntil.clear(); retired.clear();
  localFetch = async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); };
  localUp = false; offlineUntil = 0;
}
function useLocalFetch(fake) { localFetch = fake; localUp = false; offlineUntil = 0; warmedAt = 0; }
function useHedge(ms) { hedgeMs = ms; }

module.exports = { chat, firstApp, localAppGoal, localCodeGoal, localBuildGoal, localQuestion, ready, nextStep, writeCode, checkCode, explain, buildProject, safePath, warmUp, checkLocal, describeElements, cleanCode, cleanFix, label, provider, setting, useFetch, useLocalFetch, useHedge };

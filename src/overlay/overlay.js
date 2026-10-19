// Lefty's on-screen body: appears next to the mouse when the shortcut is pressed.
// He reads the app you're in and points at the button you name; any other goal goes to his AI brain
// (through the main process), which plans it one step at a time from a screenshot.

const api = window.lefty;
// Not named `lefty`: that name is taken by the window.lefty bridge from preload.js.
const leftyEl = document.getElementById('lefty');
const bubble = document.getElementById('bubble');
const ring = document.getElementById('ring');
const stepTag = document.getElementById('steptag');
const messages = document.getElementById('messages');
const form = document.getElementById('ask');
const input = document.getElementById('goal');

const LEFTY_WIDTH = 64;
const LEFTY_HEIGHT = 90;
const LEFTY_TIP = 5; // the pointer tip sits this far inside the top-left of the drawing
const BUBBLE_WIDTH = 320;
const GAP = 14;
const RING_PAD = 4;
const MAX_MESSAGES = 4;

let screenArea = { width: window.innerWidth, height: window.innerHeight, originX: 0, originY: 0 };
let currentSeq = 0;
let greeting = null;
let contextReady = null;   // resolves with what Lefty can see in the user's app, for the current summon
let resolveContext = null;

function setPosition(el, x, y) {
  el.style.left = `${Math.round(x)}px`;
  el.style.top = `${Math.round(y)}px`;
}

function place({ x, y, width, height }) {
  // Sit just below-right of the real mouse pointer so it isn't covered.
  const leftyX = Math.min(x + 12, width - LEFTY_WIDTH - GAP);
  const leftyY = Math.min(y + 12, height - LEFTY_HEIGHT - GAP);
  setPosition(leftyEl, leftyX, leftyY);

  // Bubble goes to the right of Lefty, or flips left near the screen edge.
  const fitsRight = leftyX + LEFTY_WIDTH + GAP + BUBBLE_WIDTH < width - GAP;
  const bubbleX = fitsRight ? leftyX + LEFTY_WIDTH + GAP : Math.max(GAP, leftyX - BUBBLE_WIDTH - GAP);
  const bubbleHeight = bubble.offsetHeight || 230;
  const bubbleY = Math.max(GAP, Math.min(leftyY - 10, height - bubbleHeight - GAP));
  setPosition(bubble, bubbleX, bubbleY);
}

function overlaps(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function clampToScreen(box) {
  const { width, height } = screenArea;
  return {
    ...box,
    x: Math.max(GAP, Math.min(box.x, width - box.w - GAP)),
    y: Math.max(GAP, Math.min(box.y, height - box.h - GAP)),
  };
}

// Lefty's tip lands inside the target's bottom-right corner, so its label stays readable;
// the bubble goes wherever it covers neither the target nor Lefty.
function pointAt(target) {
  const r = {
    x: target.rect.x - screenArea.originX,
    y: target.rect.y - screenArea.originY,
    w: target.rect.w,
    h: target.rect.h,
  };

  setPosition(ring, r.x - RING_PAD, r.y - RING_PAD);
  ring.style.width = `${r.w + RING_PAD * 2}px`;
  ring.style.height = `${r.h + RING_PAD * 2}px`;
  ring.classList.remove('show', 'hit');
  void ring.offsetWidth; // replay the entrance when pointing at a new target
  ring.classList.add('show');

  const tipX = r.x + r.w - Math.min(10, r.w * 0.3);
  const tipY = r.y + r.h - Math.min(8, r.h * 0.3);
  const lefty = { x: tipX - LEFTY_TIP, y: tipY - LEFTY_TIP, w: LEFTY_WIDTH, h: LEFTY_HEIGHT };
  leftyEl.classList.add('glide', 'pointing');
  bubble.classList.add('glide');
  setPosition(leftyEl, lefty.x, lefty.y);

  const bw = BUBBLE_WIDTH;
  const bh = bubble.offsetHeight || 230;
  const keepClear = { x: r.x - RING_PAD - GAP, y: r.y - RING_PAD - GAP, w: r.w + (RING_PAD + GAP) * 2, h: r.h + (RING_PAD + GAP) * 2 };
  const candidates = [
    { x: lefty.x + LEFTY_WIDTH + GAP, y: lefty.y - 10 },     // right of Lefty
    { x: lefty.x - 20, y: lefty.y + LEFTY_HEIGHT + GAP },     // below Lefty
    { x: r.x - bw - GAP * 2, y: r.y },                        // left of the target
    { x: r.x, y: r.y - bh - GAP * 2 },                        // above the target
  ].map((c) => clampToScreen({ ...c, w: bw, h: bh }));
  const spot = candidates.find((c) => !overlaps(c, keepClear) && !overlaps(c, lefty)) || candidates[0];
  setPosition(bubble, spot.x, spot.y);
}

function stopPointing() {
  ring.classList.remove('show', 'hit', 'error');
  stepTag.classList.remove('show', 'glide', 'done', 'nudge');
  leftyEl.classList.remove('glide', 'pointing');
  bubble.classList.remove('glide');
  api.setTarget(null);
}

// While guiding, the chat bubble steps aside so the screen itself shows the way.
function tuckBubble(tucked) {
  bubble.classList.toggle('tucked', tucked);
  if (tucked) api.setInteractive(false); // a hidden bubble must never keep catching the user's clicks
}

// The step tag rides to the right of Lefty, or below him near the right screen edge.
function placeStepTag() {
  const leftyX = parseFloat(leftyEl.style.left);
  const leftyY = parseFloat(leftyEl.style.top);
  const w = stepTag.offsetWidth || 120;
  const h = stepTag.offsetHeight || 30;
  let x = leftyX + LEFTY_WIDTH - 6;
  let y = leftyY + 34;
  if (x + w > screenArea.width - GAP) {
    x = leftyX + 10;
    y = leftyY + LEFTY_HEIGHT + 4;
  }
  const box = clampToScreen({ x, y, w, h });
  setPosition(stepTag, box.x, box.y);
}

function setStepTag(count, text, { done = false } = {}) {
  stepTag.replaceChildren();
  if (count) {
    const counter = document.createElement('span');
    counter.className = 'count';
    counter.textContent = count;
    stepTag.append(counter);
  }
  stepTag.append(document.createTextNode(text));
  stepTag.classList.remove('nudge');
  stepTag.classList.toggle('done', done);
  stepTag.classList.add('show', 'glide');
  placeStepTag();
}

function nudgeStepTag() {
  stepTag.classList.remove('nudge');
  void stepTag.offsetWidth; // replay the wiggle
  stepTag.classList.add('nudge');
  stepTag.dataset.nudges = String(Number(stepTag.dataset.nudges || 0) + 1);
}

function addMessage(text, from) {
  const el = document.createElement('div');
  el.className = `msg ${from === 'lefty' ? 'lefty-msg' : 'user-msg'}`;
  el.textContent = text;
  messages.append(el);
  while (messages.children.length > MAX_MESSAGES) messages.firstElementChild.remove();
  return el;
}

// A question from Lefty with answer buttons; each button runs its pick() once, then all of them go quiet.
function addChoices(text, choices) {
  return addChoicesTo(addMessage(text, 'lefty'), choices);
}

function addChoicesTo(el, choices) {
  const row = document.createElement('div');
  row.className = 'choices';
  for (const choice of choices) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = choice.label;
    if (choice.primary) button.className = 'primary';
    button.addEventListener('click', () => {
      row.querySelectorAll('button').forEach((b) => { b.disabled = true; });
      choice.pick();
    });
    row.append(button);
  }
  el.append(row);
  // Where the buttons are, for the log: once the bubble has stopped gliding to its place (0.5 s).
  setTimeout(() => row.querySelectorAll('button').forEach((b) => {
    const r = b.getBoundingClientRect();
    api.log(`choice "${b.textContent}" (${Math.round(r.left + screenArea.originX)},${Math.round(r.top + screenArea.originY)} ${Math.round(r.width)}x${Math.round(r.height)})`);
  }), 600);
  return el;
}

function showTyping() {
  const el = document.createElement('div');
  el.className = 'msg lefty-msg typing';
  el.append(document.createElement('i'), document.createElement('i'), document.createElement('i'));
  messages.append(el);
  return el;
}

/* ---------- Guiding: the goal loop ----------
   Lefty works toward the real result, not through a fixed list: look at the screen, let the skill decide the
   next step (skills.js), point at it, watch what the user does (clicks, Ctrl+S, Enter, typing), look again,
   and repeat until the skill confirms the goal is really done — e.g. the file is actually saved. */

// Menus and dialogs take a moment to appear after a click, so Lefty looks a few times before giving up.
const LOOK_AGAIN_DELAYS_MS = [150, 250, 400, 600, 800, 1000];
// While guiding, Lefty also re-checks the screen on his own, so progress made from the keyboard is noticed.
const WATCH_EVERY_MS = 1200;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let job = null;         // { skill, memory, decision, hinted }
let lookToken = 0;      // bumped by every new look: only the latest one acts
let looking = false;
let watchTimer = null;

function cancelJob() {
  job = null;
  lookToken += 1;
  looking = false;
  clearInterval(watchTimer);
  watchTimer = null;
  stopGhost();
  clearFix(); // the code doctor's ghost fix
}

function reset() {
  cancelJob();
  stopPointing();
  tuckBubble(false);
  stepTag.dataset.nudges = '0';
  hideGuard();
  lastSeen = []; // a new summon may be over a different app
  messages.replaceChildren();
  greeting = addMessage("👋 Hi! What's your goal?", 'lefty');
  input.value = '';
  contextReady = new Promise((resolve) => { resolveContext = resolve; });
}

const isOnScreen = (rect) => {
  const cx = rect.x - screenArea.originX + rect.w / 2;
  const cy = rect.y - screenArea.originY + rect.h / 2;
  return cx >= 0 && cy >= 0 && cx <= screenArea.width && cy <= screenArea.height;
};

const sameRect = (a, b) => ['x', 'y', 'w', 'h'].every((key) => Math.abs(a[key] - b[key]) < 1);

// Ends the guide and brings the chat back with a message: used whenever the user's attention is needed.
function stopGuide(message) {
  api.log(`stopped: ${message}`);
  cancelJob();
  stopPointing();
  addMessage(message, 'lefty');
  tuckBubble(false);
}

function show(decision) {
  const { target } = decision;
  if (!target) { // a step with nothing to point at (a key to press): the tag says it, Lefty stays put
    ring.classList.remove('show', 'hit');
    api.setTarget(null);
    setStepTag(decision.count || '', decision.label);
    api.log(`step ${decision.count || decision.id}: ${decision.label}`);
    return;
  }
  if (!isOnScreen(target.rect)) {
    stopGuide(`Found "${target.name}", but it's on your other screen. 👀`);
    return;
  }
  pointAt(target);
  api.raise(); // a menu that just opened is drawn above Lefty otherwise
  setStepTag(decision.count || '', decision.label);
  api.setTarget(target.rect);
  api.log(`step ${decision.count || decision.id}: pointing at ${target.type} "${target.name}" (${Math.round(target.rect.x)},${Math.round(target.rect.y)} ${Math.round(target.rect.w)}x${Math.round(target.rect.h)})`);
}

// Shows a decision: a new step moves Lefty on; the same step only follows the target if it moved, and a
// missed click wiggles the tag once to catch the user's eye.
function apply(decision, event) {
  const previous = job.decision;
  if (previous && previous.id === decision.id) {
    job.decision = decision;
    if (!decision.target) return;
    const moved = !previous.target || !sameRect(previous.target.rect, decision.target.rect);
    if (moved) show(decision);
    else api.setTarget(decision.target.rect); // a click on the target clears it in main: keep watching
    if (event && event.type === 'click' && !event.hit && (moved || !job.hinted)) {
      job.hinted = true;
      nudgeStepTag();
    }
    return;
  }
  job.decision = decision;
  job.hinted = false;
  show(decision);
}

// The AI is working out the next step: the old ring goes, the tag says Lefty is thinking.
function showThinking() {
  if (job.thinking) return;
  job.thinking = true;
  job.decision = null;
  ring.classList.remove('show', 'hit');
  api.setTarget(null);
  setStepTag('', job.memory.history && job.memory.history.length ? '🤔 Thinking…' : '🤔 Looking at your screen…');
}

// The goal is about another app ("...in VS Code", asked from the desktop): switch to it if it's open, or ask
// before opening it - opening an app is the user's call. Then the goal carries on in that app.
async function openApp(decision) {
  if (job.opening === decision.id) return; // already on it (the watch keeps re-deciding the same step)
  const thisJob = job;
  job.opening = decision.id;
  job.decision = decision;
  ring.classList.remove('show', 'hit');
  api.setTarget(null);
  setStepTag('', `🔎 Looking for ${decision.app}…`);
  api.log(`step ${decision.id}: open app "${decision.app}"`);
  const found = await api.openApp(decision.app);
  if (job !== thisJob) return;
  if (found.ok) { appOpened(thisJob, decision, found.app); return; }
  if (!found.launchable) {
    stopGuide(`I can't find ${decision.app} on this PC. 🤔 If it's installed, open it and call me again.`);
    return;
  }
  job.paused = true; // nothing moves on until the user answers
  stepTag.classList.remove('show');
  addChoices(`${found.app} isn't open. Shall I open it? 🚀`, [
    {
      label: `Yes, open ${found.app}`,
      primary: true,
      pick: async () => {
        if (job !== thisJob) return;
        job.paused = false;
        tuckBubble(true);
        setStepTag('', `🚀 Opening ${found.app}…`);
        api.log(`user said yes: opening ${found.app}`);
        const launched = await api.launchApp({ app: found.app, appId: found.appId });
        if (job !== thisJob) return;
        if (launched.ok) appOpened(thisJob, decision, launched.app);
        else stopGuide(`${found.app} didn't open. 😕 Try opening it yourself and call me again.`);
      },
    },
    {
      label: 'No',
      pick: () => { if (job === thisJob) stopGuide(`Okay! Open ${found.app} when you're ready and call me again. 👍`); },
    },
  ]);
  tuckBubble(false);
}

function appOpened(thisJob, decision, app) {
  setStepTag('', `✅ ${app} is in front`);
  setTimeout(() => { if (job === thisJob) reconsider({ type: 'opened', app, decisionId: decision.id }); }, 600);
}

/* ---------- Ghost code ----------
   "Write a linked list" in VS Code: the brain writes the code and Lefty draws it as faint text at the user's text
   cursor, like an inline suggestion, for them to type over. Main reports the cursor many times a second
   (onCaret); ghost.js works out which line they're on and what's left; this draws it in the editor's own font,
   so every character lands where the real one will. Until they start typing, the code follows the cursor. */
const ghostEl = document.getElementById('ghost');
const GHOST_EDITORS = new Set(['code', 'code - insiders', 'cursor', 'windsurf', 'vscodium']); // VS Code and its cousins
const NO_LN_COL_MS = 3000; // a known editor that never says "Ln, Col" (status bar hidden): show the code in the chat
let ghostOn = false;
let measureCanvas = null;

// options.gap: lines left free above the code before typing starts (1 for new code, 0 to retype a line in place);
// options.onDone: what happens when it's all typed (default: the goal is done).
function startGhost(decision, { gap = 1, onDone = null, tag = '👻 Press Enter, then type along' } = {}) {
  if (job.ghost && job.ghost.id === decision.id) return; // the same step decided again
  job.decision = decision;
  job.ghost = { id: decision.id, code: decision.code, tracker: LeftyGhost.track(decision.code, { gap }), font: null, row: -1, since: Date.now(), onDone };
  ghostOn = true;
  ring.classList.remove('show', 'hit', 'error');
  leftyEl.classList.remove('pointing');
  api.setTarget(null);
  retreatToCorner(); // out of the way of the code
  setStepTag('', tag);
  api.log(`step ${decision.id}: ghost code, ${decision.code.split('\n').length} lines`);
  api.ghostStart();
}

function stopGhost() {
  if (!ghostOn) return;
  ghostOn = false;
  api.ghostStop();
  ghostEl.classList.remove('show');
  ghostEl.replaceChildren();
}

// The editor's font, sized the way the editor sizes it; checked against the cursor line's real height in case
// the editor is zoomed in a way its settings don't say.
function useFont(g, font, caret) {
  Object.assign(g, measureFont(font, caret.line));
  api.log(`ghost font: ${g.font.fontSize.toFixed(1)}px ${g.font.fontFamily}, line ${g.font.lineHeight.toFixed(1)}px, char ${g.charWidth.toFixed(2)}px`);
}

// { font, charWidth } for the editor, and the ghost layer set to draw in it. lineRect: the cursor line's DIP rect.
function measureFont(font, lineRect) {
  const ratio = lineRect.h / font.lineHeight;
  const scale = Math.abs(ratio - 1) > 0.15 ? ratio : 1;
  const sized = { ...font, fontSize: font.fontSize * scale, lineHeight: font.lineHeight * scale, letterSpacing: font.letterSpacing * scale };
  measureCanvas = measureCanvas || document.createElement('canvas');
  const ctx = measureCanvas.getContext('2d');
  ctx.font = `${sized.fontSize}px ${sized.fontFamily}`;
  const charWidth = ctx.measureText('m'.repeat(40)).width / 40 + sized.letterSpacing;
  Object.assign(ghostEl.style, {
    fontFamily: sized.fontFamily, fontSize: `${sized.fontSize}px`, lineHeight: `${sized.lineHeight}px`, letterSpacing: `${sized.letterSpacing}px`,
  });
  ghostEl.classList.toggle('light', Boolean(font.light));
  return { font: sized, charWidth };
}

// Positions are in columns and rows from the cursor's line: the line's left edge is column 0 (VS Code reports
// it that way) and rows are one line height apart. The layer covers the editor and clips to it.
function drawGhost(g, view, caret) {
  const area = caret.area || { x: caret.line.x - 60, y: screenArea.originY, w: screenArea.width, h: screenArea.height };
  setPosition(ghostEl, area.x - screenArea.originX, area.y - screenArea.originY);
  ghostEl.style.width = `${area.w}px`;
  ghostEl.style.height = `${area.h}px`;
  const left = (col) => caret.line.x - area.x + col * g.charWidth;
  const rowTop = caret.line.y - area.y + (caret.line.h - g.font.lineHeight) / 2;
  const lines = [];
  // VS Code's suggestion list stays readable: ghost lines that would cross it are left out while it's open.
  const underPopup = (x, top, chars) => Boolean(caret.popup) && overlaps( // a few pixels of slack: the list starts right under the cursor's line
    { x: area.x + x, y: area.y + top + 3, w: chars * g.charWidth, h: g.font.lineHeight - 6 }, caret.popup);
  const line = (row, col, cls, chars) => {
    const top = rowTop + (row - view.row) * g.font.lineHeight;
    if (top > area.h || underPopup(left(col), top, chars)) return null;
    const el = document.createElement('div');
    el.className = `gline${cls ? ` ${cls}` : ''}`;
    el.style.left = `${left(col)}px`;
    el.style.top = `${top}px`;
    lines.push(el);
    return el;
  };
  for (const item of view.items) {
    const el = line(item.row, item.col, item.current ? 'current' : '', item.text.length);
    if (!el) continue;
    if (item.current) { // the next character to type stands out
      const next = document.createElement('span');
      next.className = 'next';
      next.textContent = item.text[0];
      el.append(next, document.createTextNode(item.text.slice(1)));
    } else {
      el.textContent = item.text;
    }
  }
  if (view.lineDone) { // this line is typed (or the code waits below it): Enter for the next one
    const el = line(view.row, caret.col - 1 + 0.4, 'enter', 1);
    if (el) el.textContent = '↵';
  }
  ghostEl.replaceChildren(...lines);
  ghostEl.classList.add('show');
}

// The code in the chat instead, for an editor whose cursor Lefty can't follow.
function codeInChat(code, why) {
  cancelJob();
  stopPointing();
  const el = addMessage(why, 'lefty');
  el.classList.add('has-code');
  const pre = document.createElement('pre');
  pre.className = 'code';
  pre.textContent = code;
  el.append(pre);
  retreatToCorner();
  tuckBubble(false);
}

function finishGhost(g) {
  g.done = true;
  stopGhost();
  if (g.onDone) { job.ghost = null; g.onDone(); return; } // e.g. the code doctor moves on to the next error
  LeftySkills.noteEvent(job, { type: 'coded', decisionId: g.id });
  act(LeftySkills.decide(job, asSeen(null)), null);
}

/* ---------- Code doctor ----------
   "Find the error" in VS Code: main reads the whole file, the brain finds each error and its fix, and Lefty takes
   them one at a time: VS Code jumps to the line (scrolling long files), the wrong code gets a red ring, the fix
   shows as ghost text beside it, and the chat offers "Fix it for me" (Lefty pastes the fix), "I'll type it" (the
   line is cleared and the fix becomes ghost code to type over) or "Skip". */
const DOCTOR_PROBLEMS = {
  'not-editor': "I can check code in VS Code (or Cursor). Open your file there and ask me again. 🩺",
  'not-front': "I couldn't get to your editor. Click into your code and ask me again. 👆",
  'no-cursor': 'Click into your code first, then ask me again. 👆',
  secret: "That file looks like it holds secrets (keys, passwords), so I won't read it. 🔒",
  'no-copy': "I couldn't read your code. Click into the file and ask me again. 😕",
  failed: "I couldn't read your code. Click into the file and ask me again. 😕",
};
const indentOf = (line) => line.length - line.trimStart().length;

async function startDoctor(goal) {
  if (job.doctor) return; // already on it (the watch may decide the same step again)
  const thisJob = job;
  job.doctor = { problems: [], i: 0, fixed: 0 };
  job.thinking = false;
  ring.classList.remove('show', 'hit', 'error');
  api.setTarget(null);
  tuckBubble(true);
  setStepTag('', '🩺 Reading your code…');
  const read = await api.doctorRead();
  if (job !== thisJob) return;
  if (!read.ok) { stopGuide(DOCTOR_PROBLEMS[read.error] || DOCTOR_PROBLEMS.failed); return; }
  if (!read.code.trim()) { stopGuide('Your file is empty, so nothing can be wrong yet! ✍️'); return; }
  setStepTag('', `🩺 Checking ${read.fileName || 'your code'}…`);
  const result = await api.doctorCheck({ code: read.code, fileName: read.fileName, goal, hint: read.hint });
  if (job !== thisJob) return;
  if (!result.ok) { stopGuide(result.error); return; }
  if (!result.problems.length) { stopGuide(`✅ ${result.summary || "I don't see any errors in your code."}`); return; }
  Object.assign(job.doctor, { lines: read.code.split('\n'), problems: result.problems, fileName: read.fileName });
  api.log(`doctor: ${result.problems.length} problem(s) in ${read.fileName || 'the file'}`);
  showProblem(thisJob);
}

async function showProblem(thisJob) {
  const d = job.doctor;
  const p = d.problems[d.i];
  if (!p) { doctorDone(); return; }
  const count = `${d.i + 1}/${d.problems.length}`;
  setStepTag(count, `🔎 Going to line ${p.line}…`);
  const at = await api.doctorGoto({ line: p.line, col: 1 });
  if (job !== thisJob) return;
  if (!at.ok) { stopGuide(`I couldn't get to line ${p.line}. 😕 Click into your code and ask me again.`); return; }
  if (!d.metrics) d.metrics = measureFont(await api.editorFont(at.process), at.line);
  if (job !== thisJob) return;
  const { charWidth } = d.metrics;
  const wrong = d.lines.slice(p.line - 1, p.endLine);
  const indent = Math.min(...wrong.filter((l) => l.trim()).map(indentOf).concat([indentOf(wrong[0] || '')]));
  const longest = Math.max(1, ...wrong.map((l) => l.length));
  // The wrong code gets the red ring: from its first character to the end of its longest line.
  const rect = {
    x: at.line.x + indent * charWidth - 4, y: at.line.y - 1,
    w: Math.max(2, longest - indent) * charWidth + 8, h: at.line.h * wrong.length + 2,
  };
  drawFix(at, d.metrics, longest + 3, p.fixed);
  const el = addMessage(`❌ Line ${p.line}: ${p.message}`, 'lefty');
  el.classList.add('has-code');
  const pre = document.createElement('pre');
  pre.className = 'code';
  pre.textContent = p.fixed;
  el.append(pre);
  addChoicesTo(el, [
    { label: '✨ Fix it for me', primary: true, pick: () => doctorFix(thisJob, p) },
    { label: "✍️ I'll type it", pick: () => doctorRetype(thisJob, p) },
    { label: 'Skip', pick: () => doctorNext(thisJob) },
  ]);
  tuckBubble(false);
  pointAt({ rect });
  bubbleClearOfRow(rect); // the fix is drawn beside the wrong line: the chat keeps off that row
  ring.classList.add('error');
  api.raise();
  setStepTag(count, `❌ ${p.message}`);
  api.log(`doctor: showing line ${p.line}${p.endLine > p.line ? `-${p.endLine}` : ''} (${Math.round(rect.x)},${Math.round(rect.y)} ${Math.round(rect.w)}x${Math.round(rect.h)})`);
}

// The chat at the right edge of the screen, below the wrong code's row (or above it near the bottom), so neither
// the code nor the ghost fix beside it is covered.
function bubbleClearOfRow(rect) {
  const bh = bubble.offsetHeight || 230;
  const top = rect.y - screenArea.originY;
  const below = top + rect.h + GAP * 3;
  const y = below + bh <= screenArea.height - GAP ? below : Math.max(GAP, top - bh - GAP * 3);
  setPosition(bubble, screenArea.width - BUBBLE_WIDTH - GAP, y);
}

// The fix as ghost text, a few columns right of the wrong code ("→ b = 2"), each line of it one row down.
function drawFix(at, metrics, col, fixed) {
  const area = at.area || { x: at.line.x - 60, y: screenArea.originY, w: screenArea.width, h: screenArea.height };
  setPosition(ghostEl, area.x - screenArea.originX, area.y - screenArea.originY);
  ghostEl.style.width = `${area.w}px`;
  ghostEl.style.height = `${area.h}px`;
  const lines = fixed.split('\n');
  const base = Math.min(...lines.filter((l) => l.trim()).map(indentOf).concat([indentOf(lines[0])]));
  ghostEl.replaceChildren(...lines.map((line, row) => {
    const el = document.createElement('div');
    el.className = `gline fixline${row === 0 ? ' current' : ''}`;
    el.style.left = `${at.line.x - area.x + col * metrics.charWidth}px`;
    el.style.top = `${at.line.y - area.y + (at.line.h - metrics.font.lineHeight) / 2 + row * metrics.font.lineHeight}px`;
    el.textContent = `${row === 0 ? '→ ' : '  '}${line.slice(base)}`;
    return el;
  }));
  ghostEl.classList.add('show');
}

function clearFix() {
  if (ghostOn) return; // the ghost layer belongs to ghost code right now
  ghostEl.classList.remove('show');
  ghostEl.replaceChildren();
}

// The local copy of the file follows the fix, and later errors move with the lines it added or removed.
function applyFixLocally(d, p) {
  const fresh = p.fixed.split('\n');
  const shift = fresh.length - (p.endLine - p.line + 1);
  d.lines.splice(p.line - 1, p.endLine - p.line + 1, ...fresh);
  for (const later of d.problems.slice(d.i + 1)) { later.line += shift; later.endLine += shift; }
  d.fixed += 1;
}

async function doctorFix(thisJob, p) {
  if (job !== thisJob) return;
  tuckBubble(true);
  clearFix();
  setStepTag(`${job.doctor.i + 1}/${job.doctor.problems.length}`, '✨ Fixing it…');
  const result = await api.doctorFix({ line: p.line, endLine: p.endLine, text: p.fixed });
  if (job !== thisJob) return;
  if (!result.ok) { stopGuide("I couldn't change your code. 😕 Click into the file and try again, or type the fix yourself."); return; }
  applyFixLocally(job.doctor, p);
  ring.classList.remove('error');
  ring.classList.add('hit');
  setStepTag(`${job.doctor.i + 1}/${job.doctor.problems.length}`, '✅ Fixed!', { done: true });
  setTimeout(() => doctorNext(thisJob), 1000);
}

// "I'll type it": the wrong lines are emptied (keeping their indent) and the fix becomes ghost code to type over.
async function doctorRetype(thisJob, p) {
  if (job !== thisJob) return;
  tuckBubble(true);
  clearFix();
  const lines = p.fixed.split('\n');
  const indent = lines[0].slice(0, indentOf(lines[0]));
  const result = await api.doctorFix({ line: p.line, endLine: p.endLine, text: indent });
  if (job !== thisJob) return;
  if (!result.ok) { stopGuide("I couldn't get your code ready. 😕 Click into the file and try again."); return; }
  const code = lines.map((l) => (l.startsWith(indent) ? l.slice(indent.length) : l.trimStart())).join('\n');
  startGhost({ id: `doctor:${p.line}`, code }, {
    gap: 0,
    tag: '✍️ Type the fix',
    onDone: () => {
      if (job !== thisJob) return;
      applyFixLocally(job.doctor, p);
      setStepTag(`${job.doctor.i + 1}/${job.doctor.problems.length}`, '✅ Nice, fixed!', { done: true });
      setTimeout(() => doctorNext(thisJob), 1000);
    },
  });
}

function doctorNext(thisJob) {
  if (job !== thisJob) return;
  ring.classList.remove('hit', 'error');
  clearFix();
  job.doctor.i += 1;
  showProblem(thisJob);
}

function doctorDone() {
  const d = job.doctor;
  const n = d.problems.length;
  const message = d.fixed === n ? `🎉 All ${n === 1 ? 'fixed' : `${n} fixed`}! Run your code to see it work.`
    : d.fixed ? `👍 Fixed ${d.fixed} of ${n}. The rest is up to you!` : `👍 That's all ${n === 1 ? 'of it' : n}. Fix them whenever you're ready.`;
  api.log(`doctor: done, ${d.fixed} of ${n} fixed`);
  stopGuide(message);
  retreatToCorner();
}

api.onCaret(async (caret) => {
  const g = job && job.ghost;
  if (!g || g.done || !caret.inFront) { if (g) ghostEl.classList.remove('show'); return; }
  const editor = String(caret.process || '').toLowerCase();
  if (!GHOST_EDITORS.has(editor)) {
    api.log(`ghost: ${caret.process} is not an editor Lefty can follow; code goes in the chat`);
    codeInChat(g.code, "Here's the code to type. ✍️ (I can draw it right at your cursor in VS Code.)");
    return;
  }
  if (!caret.line) { ghostEl.classList.remove('show'); setStepTag('', '👻 Click in your code file'); return; } // focus is in a side panel
  if (!caret.ln) {
    if (Date.now() - g.since > NO_LN_COL_MS) codeInChat(g.code, "Here's the code to type. ✍️ (Show the Ln/Col in VS Code's status bar and I can draw it at your cursor.)");
    return;
  }
  if (!g.font) {
    if (g.fontAsked) return;
    g.fontAsked = true;
    const font = await api.editorFont(caret.process);
    if (!job || job.ghost !== g) return;
    useFont(g, font, caret);
  }
  const view = g.tracker.update(caret);
  if (view.off) { ghostEl.classList.remove('show'); return; } // the cursor went somewhere else in the file
  if (view.finished) { finishGhost(g); return; }
  drawGhost(g, view, caret);
  if (g.tracker.locked && view.row !== g.row) {
    g.row = view.row;
    setStepTag(`${view.row + 1}/${view.total}`, '👻 Type along');
  }
});

// Acts on a decision; false means "nothing to do yet, look again".
function act(decision, event) {
  if (decision.done) { finish(decision); return true; }
  if (decision.giveUp) { api.log(`gave up: ${decision.giveUp}`); stopGuide(decision.giveUp); return true; }
  if (decision.say) { api.log(`said: ${decision.say}`); stopGuide(decision.say); return true; }
  if (decision.thinking) { showThinking(); return true; }
  if (decision.kind === 'open') { job.thinking = false; openApp(decision); return true; }
  if (decision.kind === 'code') { job.thinking = false; startGhost(decision); return true; }
  if (decision.kind === 'doctor') { startDoctor(job.goal); return true; }
  if (decision.target || decision.kind === 'tell') { job.thinking = false; apply(decision, event); return true; }
  return false;
}

// After the user did something: look again (a few times, the screen may still be changing) and decide.
async function reconsider(event) {
  if (!job || job.paused || job.ghost || job.doctor) return; // waiting for the user's answer, typing ghost code, or the code doctor
  const thisJob = job;
  if (event) LeftySkills.noteEvent(job, event);
  const look = ++lookToken;
  looking = true;
  let stuck = null;
  try {
    for (const delay of LOOK_AGAIN_DELAYS_MS) {
      await sleep(delay);
      if (job !== thisJob || look !== lookToken) return;
      const seen = await api.rescan();
      rememberSeen(seen);
      if (job !== thisJob || look !== lookToken) return;
      if (!seen.ok && !job.skill.wantsTyping) continue; // the brain doesn't need the read: it has the screenshot
      const decision = LeftySkills.decide(job, asSeen(seen));
      if (act(decision, event)) return;
      if (decision.stuck) stuck = decision.stuck;
    }
    stopGuide(stuck || "I lost track of the screen. Call me again when you're ready. 👀");
  } finally {
    if (look === lookToken) looking = false;
  }
}

// Between the user's actions: progress made from the keyboard (Enter in a dialog, shortcuts) still counts.
async function watch() {
  if (!job || looking || job.paused || job.ghost || job.doctor) return; // ghost code follows the cursor instead (onCaret)
  const thisJob = job;
  const seen = await api.rescan({ quiet: true });
  rememberSeen(seen);
  if (job !== thisJob || looking || (!seen.ok && !job.skill.wantsTyping)) return;
  act(LeftySkills.decide(job, asSeen(seen)), null);
}

function finish(decision) {
  api.log(`goal finished (${job.skill.name})`);
  cancelJob();
  api.setTarget(null);
  if (decision.cancelled) {
    stopGuide('Okay, cancelled. 👍 What next?');
    return;
  }
  const done = decision.message || '🎉 Done!';
  setStepTag('', done, { done: true });
  const token = lookToken;
  setTimeout(() => { // let the green tag show first, then Lefty steps out of the way, ready for the next goal
    if (token !== lookToken) return;
    stopPointing();
    addMessage(decision.message ? `${done} What next?` : `${done} You did it. What next?`, 'lefty'); // before placing, so the bubble is measured at its new height
    retreatToCorner();
    tuckBubble(false);
  }, 1200);
}

// After a goal Lefty moves to the bottom-right corner, so his chat never covers the user's work.
function retreatToCorner() {
  const x = screenArea.width - LEFTY_WIDTH - GAP * 3;
  const y = screenArea.height - LEFTY_HEIGHT - GAP * 5;
  leftyEl.classList.add('glide');
  bubble.classList.add('glide');
  place({ x: x - 12, y: y - 12, width: screenArea.width, height: screenArea.height });
}

// A screen read that failed (some apps refuse for a moment while they redraw), as an empty but usable read: the
// brain works from the screenshot, and the skill keeps the last target instead of thinking it vanished.
const asSeen = (seen) => (seen && seen.ok ? seen : { ok: true, unread: true, elements: [], title: '', app: '' });

// VS Code and its cousins, where Lefty can follow the text cursor and read the code.
const isCodeEditor = (seen) => Boolean(seen && seen.ok) && (/^(VS Code|Cursor|Windsurf|VSCodium)$/.test(seen.app || '')
  || / - (Visual Studio Code|Cursor|Windsurf|VSCodium)$/.test(seen.title || ''));

const NO_KEY_HINT ='Get a free key at aistudio.google.com/apikey and put GEMINI_API_KEY=your-key in a .env file in the Lefty folder.';

async function ask(goal) {
  addMessage(goal, 'user');
  input.value = '';
  cancelJob();
  stopPointing();
  tuckBubble(false); // replies show in the chat; it tucks away again only if a guide starts
  const token = lookToken;

  const brainOn = await api.brainReady();
  if (token !== lookToken) return;
  if (LeftyMatch.isStuck(goal) && !brainOn) {
    addMessage(`My brain isn't connected yet. 🧠 ${NO_KEY_HINT} For now, try "save this", or a path like File > Save as.`, 'lefty');
    return;
  }
  const steps = LeftyMatch.parsePlan(goal);
  if (!steps.length) return;

  const typing = showTyping();
  let seen = await contextReady;
  typing.remove();
  if (token !== lookToken) return; // Lefty was closed, or asked something else, meanwhile

  if (!seen.ok && !brainOn) {
    addMessage("I couldn't read this app's buttons, sorry. 😕 Try clicking into the app and calling me again.", 'lefty');
    return;
  }
  const unreadable = !seen.ok; // the brain still sees the screenshot, so it can guide anyway
  if (unreadable) seen = asSeen(seen);
  // Free and instant first: saving, a typed path, or a short button name found on screen. Anything else
  // (a question, a task in words, or a button that isn't there) goes to the brain.
  const startJob = (skill, { decide = true } = {}) => {
    const thisJob = { skill, goal, memory: {}, decision: null, hinted: false };
    thisJob.memory.wake = () => { if (job === thisJob) watch(); };
    job = thisJob;
    return decide ? LeftySkills.decide(job, seen) : null;
  };
  // "Find the error" in a code editor: straight to the code doctor, no first trip to the brain.
  if (brainOn && !unreadable && isCodeEditor(seen) && LeftySkills.isCodeCheckGoal(goal)) {
    startJob(LeftySkills.aiSkill(goal, (request) => api.think(request)), { decide: false });
    startDoctor(goal);
    return;
  }
  const longRequest = steps.length === 1 && goal.split(/\s+/).length > 3;
  let first = null;
  if (!unreadable && !(brainOn && (LeftyMatch.isStuck(goal) || (longRequest && !LeftySkills.isSaveGoal(goal))))) {
    first = startJob(steps.length === 1 && LeftySkills.isSaveGoal(goal) ? LeftySkills.saveSkill(goal) : LeftySkills.pathSkill(steps));
    if (!first.target && brainOn && steps.length === 1) first = null; // not found the simple way: ask the brain
  }
  if (!first) first = startJob(LeftySkills.aiSkill(goal, (request) => api.think(request)));
  if (!first.target && !first.thinking && first.kind !== 'tell') {
    const notFound = job.skill.name === 'path'
      ? (steps.length === 1
        ? `I can't spot "${goal}" on this screen. 🤔 ${brainOn ? '' : `Connect my brain and I'll plan every step for you. 🧠 ${NO_KEY_HINT}`}`
        : `I can't spot "${steps[0]}" on this screen. 🤔`)
      : (first.giveUp || first.stuck || "I can't see how to do that here yet. 🤔");
    stopGuide(notFound.trim());
    return;
  }
  act(first, null);
  if (!job) return;
  tuckBubble(true);
  api.focusApp(); // the next move is in the app: many apps ignore the first click while inactive
  watchTimer = setInterval(watch, WATCH_EVERY_MS);
}

api.onClick(({ hit, free, x, y }) => {
  if (job && (job.ghost || job.doctor)) return; // clicks in the editor just move the cursor; the ghost follows it
  // Not pointing at anything: keep the guard's picture of the screen fresh. While guiding, that's the second
  // click of a double-click on the target (it no longer counts) - unless the step has nothing to point at.
  if (free && (!job || job.thinking || (job.decision && job.decision.target))) { refreshSeenSoon(); return; }
  if (!job || !job.decision) return;
  const point = { x, y };
  if (hit) { // flash the ring green; main already stopped watching this target
    ring.classList.add('hit');
  }
  reconsider({
    type: 'click',
    hit,
    point,
    element: LeftyGuard.elementAt(point, lastSeen),
    elements: lastSeen,
    decisionId: job.decision.id,
    targetName: job.decision.target ? job.decision.target.name : '',
  });
});

// Keys the user pressed while Lefty guides. Only Ctrl+S, Enter and Escape are named; for anything else Lefty
// is only told that typing happened, never which keys.
api.onKey(({ combo, typing }) => {
  if (!job) return;
  if (job.ghost) { // the first key typed pins the ghost code where the cursor is
    if (typing || combo === 'Enter') job.ghost.tracker.lock();
    return;
  }
  if (job.doctor) return; // the code doctor waits for a button
  if (combo === 'nav') return; // arrow keys and the like only matter to ghost code
  if (typing) {
    const dialog = job.memory.dialogOpen && job.memory.dialog;
    if (dialog && !dialog.nameTouched) { reconsider({ type: 'typing' }); return; } // naming a file in a dialog
    if (job.skill.wantsTyping) LeftySkills.noteEvent(job, { type: 'typing' }); // the brain notices a pause in typing
    return;
  }
  reconsider({ type: 'key', combo });
});

/* ---------- Click guard ----------
   While Lefty is on screen, resting the mouse on a button that throws work away ("Delete", "Don't Save",
   "Empty Recycle Bin") flags it before the click. It uses the latest screen read, so it costs no extra
   work per mouse move; the read is refreshed after the user's clicks, since clicks change the screen. */
const GUARD_REST_MS = 250;
const GUARD_STALE_MS = 1500; // older than this, the screen may have changed without a click (keyboard, timers)
const GUARD_PAD = 3;
const guardRing = document.getElementById('guard-ring');
const guardTag = document.getElementById('guard-tag');
let lastSeen = [];       // elements of the latest screen read
let lastSeenAt = 0;
let lastPoint = null;    // where the mouse is resting
let guarded = null;      // the element currently flagged
let guardTimer = null;
let refreshTimer = null;
let refreshing = false;

function rememberSeen(seen) {
  if (!seen || !seen.ok) return;
  lastSeen = seen.elements;
  lastSeenAt = Date.now();
}

function refreshSeenSoon() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => rememberSeen(await api.rescan({ quiet: true })), 500);
}

const contains = (rect, point) => point.x >= rect.x && point.y >= rect.y && point.x <= rect.x + rect.w && point.y <= rect.y + rect.h;

function hideGuard() {
  guarded = null;
  guardRing.classList.remove('show', 'high');
  guardTag.classList.remove('show', 'high');
}

function showGuard(element, risk) {
  guarded = element;
  const r = { x: element.rect.x - screenArea.originX, y: element.rect.y - screenArea.originY, w: element.rect.w, h: element.rect.h };
  setPosition(guardRing, r.x - GUARD_PAD, r.y - GUARD_PAD);
  guardRing.style.width = `${r.w + GUARD_PAD * 2}px`;
  guardRing.style.height = `${r.h + GUARD_PAD * 2}px`;
  guardTag.textContent = `⚠️ ${risk.warning}`;
  const high = risk.level === 'high';
  guardRing.classList.toggle('high', high);
  guardTag.classList.toggle('high', high);
  guardRing.classList.add('show');
  guardTag.classList.add('show');

  // Above the button, or below it when there's no room.
  const w = guardTag.offsetWidth || 260;
  const h = guardTag.offsetHeight || 32;
  const above = r.y - GUARD_PAD - h - 8;
  const y = above >= GAP ? above : r.y + r.h + GUARD_PAD + 8;
  const box = clampToScreen({ x: r.x - GUARD_PAD, y, w, h });
  setPosition(guardTag, box.x, box.y);
  api.raise();
  api.log(`guard: "${element.name}" (${risk.level})`);
}

async function checkGuard(point) {
  // A dialog opened from the keyboard ("Don't save" after Ctrl+W) changes the screen without a click: look again.
  if (Date.now() - lastSeenAt > GUARD_STALE_MS && !refreshing) {
    refreshing = true;
    try {
      rememberSeen(await api.rescan({ quiet: true }));
    } finally {
      refreshing = false;
    }
    if (!leftyEl.classList.contains('show') || point !== lastPoint) return; // the mouse moved on meanwhile
  }
  const element = LeftyGuard.elementAt(point, lastSeen);
  const risk = element && LeftyGuard.riskOf(element);
  if (!risk) { hideGuard(); return; }
  if (guarded === element) return;
  showGuard(element, risk);
}

// The overlay ignores clicks but still receives mouse moves over the whole screen.
document.addEventListener('mousemove', (event) => {
  clearTimeout(guardTimer);
  if (!leftyEl.classList.contains('show') || (job && (job.ghost || job.doctor))) return; // no screen reads while ghost code follows the cursor
  if (bubble.contains(event.target) && !bubble.classList.contains('tucked')) { hideGuard(); return; } // over Lefty's own chat
  const point = { x: event.clientX + screenArea.originX, y: event.clientY + screenArea.originY };
  lastPoint = point;
  if (guarded && !contains(guarded.rect, point)) hideGuard(); // left the button: clear at once
  guardTimer = setTimeout(() => checkGuard(point), GUARD_REST_MS);
});

function setVisible(visible) {
  for (const el of [leftyEl, bubble]) {
    el.classList.toggle('show', visible);
    el.classList.toggle('hide', !visible);
  }
  if (!visible) {
    ring.classList.remove('show');
    stepTag.classList.remove('show');
    hideGuard();
    clearTimeout(guardTimer);
    clearTimeout(refreshTimer);
  }
}

api.onShow((position) => {
  currentSeq = position.seq;
  screenArea = { width: position.width, height: position.height, originX: position.originX, originY: position.originY };
  reset();
  place(position);
  setVisible(true);
  setTimeout(() => input.focus(), 60);
});

api.onContext((seen) => {
  if (seen.seq !== currentSeq) return;
  rememberSeen(seen);
  if (seen.ok && greeting && greeting.isConnected) {
    greeting.textContent = `👋 Hi! I can see ${seen.app}. What's your goal?`;
    // The editor's own problem count ("Errors: 1, Warnings: 2"): offer to find and fix them.
    const problems = isCodeEditor(seen) ? seen.elements.map((el) => /^(?:Errors?|Warnings?): (\d+)/.exec(el.name || '')).filter(Boolean)
      .reduce((sum, m) => sum + Number(m[1]), 0) : 0;
    if (problems) {
      greeting.textContent = `👋 Hi! I spot ${problems} problem${problems === 1 ? '' : 's'} in your code. Want me to find ${problems === 1 ? 'it' : 'them'}?`;
      addChoicesTo(greeting, [{ label: '🩺 Find & fix', primary: true, pick: () => ask('find the errors in my code') }]);
    }
  }
  resolveContext(seen);
});

api.onHide(() => {
  cancelJob();
  setVisible(false);
});

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const goal = input.value.trim();
  if (!goal) {
    form.classList.remove('shake');
    void form.offsetWidth; // restart the animation
    form.classList.add('shake');
    input.focus();
    return;
  }
  ask(goal);
});

document.querySelectorAll('[data-q]').forEach((chip) => {
  chip.addEventListener('click', () => ask(chip.dataset.q));
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') api.requestHide();
});

// Only catch the mouse while it's over Lefty or the bubble; everywhere else clicks reach the app below.
for (const el of [leftyEl, bubble]) {
  el.addEventListener('mouseenter', () => api.setInteractive(true));
  el.addEventListener('mouseleave', () => api.setInteractive(false));
}

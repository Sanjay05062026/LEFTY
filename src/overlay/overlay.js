// Lefty's on-screen body: appears next to the mouse when the shortcut is pressed.
// He reads the app you're in and points at the button you name; any other goal goes to his AI brain
// (through the main process), which plans it one step at a time from a screenshot. Goals can be typed or spoken,
// he can explain any button ("What does this do?"), keep the user focused for a while, and build whole projects.

const api = window.lefty;
// Line icons for the buttons whose picture changes (drawn in the text colour).
const ICONS = {
  speakerOn: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M19 5a10 10 0 0 1 0 14"/></svg>',
  speakerOff: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H2v6h4l5 4V5z"/><line x1="22" y1="9" x2="16" y2="15"/><line x1="16" y1="9" x2="22" y2="15"/></svg>',
};
// Not named `lefty`: that name is taken by the window.lefty bridge from preload.js.
const leftyEl = document.getElementById('lefty');
const leftyBody = leftyEl.querySelector('.lefty-body');
const bubble = document.getElementById('bubble');
const ring = document.getElementById('ring');
const stepTag = document.getElementById('steptag');
const messages = document.getElementById('messages');
const form = document.getElementById('ask');
const input = document.getElementById('goal');
const micButton = document.getElementById('mic');
const speakButton = document.getElementById('speak');

// Lefty's size on screen (the Small / Normal / Large setting): width in px; the drawing is 74 x 104 with the pointer
// tip 6 units inside its top-left corner.
const SIZES = { small: 30, normal: 40, large: 56 };
const leftySize = { w: SIZES.normal, h: Math.round((SIZES.normal * 104) / 74), tip: Math.round((SIZES.normal * 6) / 74) };
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
  const leftyX = Math.min(x + 12, width - leftySize.w - GAP);
  const leftyY = Math.min(y + 12, height - leftySize.h - GAP);
  setPosition(leftyEl, leftyX, leftyY);

  // Bubble goes to the right of Lefty, or flips left near the screen edge.
  const fitsRight = leftyX + leftySize.w + GAP + BUBBLE_WIDTH < width - GAP;
  const bubbleX = fitsRight ? leftyX + leftySize.w + GAP : Math.max(GAP, leftyX - BUBBLE_WIDTH - GAP);
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
  const lefty = { x: tipX - leftySize.tip, y: tipY - leftySize.tip, w: leftySize.w, h: leftySize.h };
  leftyEl.classList.add('glide', 'pointing');
  playBody('land'); // grows a little as he lands, so the eye finds him
  bubble.classList.add('glide');
  setPosition(leftyEl, lefty.x, lefty.y);

  const bw = BUBBLE_WIDTH;
  const bh = bubble.offsetHeight || 230;
  const keepClear = { x: r.x - RING_PAD - GAP, y: r.y - RING_PAD - GAP, w: r.w + (RING_PAD + GAP) * 2, h: r.h + (RING_PAD + GAP) * 2 };
  const candidates = [
    { x: lefty.x + leftySize.w + GAP, y: lefty.y - 10 },     // right of Lefty
    { x: lefty.x - 20, y: lefty.y + leftySize.h + GAP },     // below Lefty
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
  updateModeChip();
}

// A short animation of Lefty's body: 'land' (grows as he arrives at a target) or 'press' (a click in Do it mode).
function playBody(name) {
  leftyBody.classList.remove('land', 'press');
  void leftyBody.offsetWidth; // replay it
  leftyBody.classList.add(name);
}

// While guiding, the chat bubble steps aside so the screen itself shows the way.
function tuckBubble(tucked) {
  bubble.classList.toggle('tucked', tucked);
  reportRegions(); // a hidden bubble must never keep catching the user's clicks
}

// The step tag rides to the right of Lefty, or below him near the right screen edge.
function placeStepTag() {
  const leftyX = parseFloat(leftyEl.style.left);
  const leftyY = parseFloat(leftyEl.style.top);
  const w = stepTag.offsetWidth || 120;
  const h = stepTag.offsetHeight || 30;
  let x = leftyX + leftySize.w - 4;
  let y = leftyY + Math.round(leftySize.h * 0.38);
  if (x + w > screenArea.width - GAP) {
    x = leftyX + 10;
    y = leftyY + leftySize.h + 4;
  }
  const box = clampToScreen({ x, y, w, h });
  setPosition(stepTag, box.x, box.y);
  placeModeChip(box);
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
  updateModeChip();
}

function nudgeStepTag() {
  stepTag.classList.remove('nudge');
  void stepTag.offsetWidth; // replay the wiggle
  stepTag.classList.add('nudge');
  stepTag.dataset.nudges = String(Number(stepTag.dataset.nudges || 0) + 1);
}

/* ---------- Chat history ----------
   What the user and Lefty say is saved as a chat (main's history.js: Supabase or this PC), from the user's first
   message on, so it can be opened and continued from the home screen. Only the text: never screenshots or audio. */
let chat = { id: null, ready: null, earlier: [] };
function newChat() { chat = { id: null, ready: null, earlier: [] }; }

function record(role, text) {
  if (!text || !api.chatCreate) return;
  if (!chat.ready) {
    if (role !== 'user') return; // the greeting before anything was asked is not a chat yet
    const thisChat = chat;
    thisChat.ready = api.chatCreate(text).then((r) => { thisChat.id = r && r.ok && r.chat ? r.chat.id : null; return thisChat.id; }).catch(() => null);
  }
  chat.ready.then((id) => { if (id) api.chatAdd({ chatId: id, role, text }); });
  chat.earlier.push(`${role === 'user' ? 'User' : 'Lefty'}: ${String(text).slice(0, 600)}`);
  if (chat.earlier.length > 12) chat.earlier.shift();
}

// Lefty's messages are read out too when "Lefty talks" is on (not the greeting: that would talk at every summon).
// save: kept in the chat history (not the greeting, "listening" notes or messages shown again from the history).
function addMessage(text, from, { say = true, save = say } = {}) {
  const el = document.createElement('div');
  el.className = `msg ${from === 'lefty' ? 'lefty-msg' : 'user-msg'}`;
  el.textContent = text;
  if (save) record(from === 'lefty' ? 'lefty' : 'user', text);
  messages.append(el);
  while (messages.children.length > MAX_MESSAGES) messages.firstElementChild.remove();
  keepBubbleOnScreen();
  if (from === 'lefty' && say) speak(text);
  return el;
}

// A bubble that grew (a new message, answer buttons, a name box) moves up if its bottom would leave the screen.
function keepBubbleOnScreen() {
  const top = parseFloat(bubble.style.top);
  const h = bubble.offsetHeight;
  if (!Number.isFinite(top) || !h || top + h <= screenArea.height - GAP) return;
  setPosition(bubble, parseFloat(bubble.style.left) || GAP, Math.max(GAP, screenArea.height - h - GAP));
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
  keepBubbleOnScreen();
  // Where the buttons are, for the log: once the bubble has stopped gliding to its place (0.5 s).
  setTimeout(() => row.querySelectorAll('button').forEach((b) => api.log(`choice "${b.textContent}" ${whereIs(b)}`)), 600);
  return el;
}

// "(x,y wxh)" of an element in global DIPs, for the log (live tests click Lefty's own buttons from it).
function whereIs(el) {
  const r = el.getBoundingClientRect();
  return `(${Math.round(r.left + screenArea.originX)},${Math.round(r.top + screenArea.originY)} ${Math.round(r.width)}x${Math.round(r.height)})`;
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
  updateModeChip();
}

function reset() {
  newChat();
  focusBlock = null;
  stepTag.classList.remove('wrap');
  cancelJob();
  stopPointing();
  tuckBubble(false);
  stepTag.dataset.nudges = '0';
  hideGuard();
  hideTip();
  endPick();
  stopListening(false);
  lastSeen = []; // a new summon may be over a different app
  lastSeenApp = { app: '', title: '', private: false };
  messages.replaceChildren();
  clearTimeout(focusNoticeTimer);
  greeting = addMessage(focusState.on ? `Focus mode: ${focusLeft()} left. What's your goal?` : "Hi! What's your goal?", 'lefty', { say: false });
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
    setStepTag(decision.count || '', tagText(decision));
    api.log(`step ${decision.count || decision.id}: ${decision.label}`);
    return;
  }
  if (!isOnScreen(target.rect)) {
    stopGuide(`Found "${target.name}", but it's on your other screen.`);
    return;
  }
  pointAt(target);
  api.raise(); // a menu that just opened is drawn above Lefty otherwise
  setStepTag(decision.count || '', tagText(decision));
  api.setTarget(target.rect);
  api.log(`step ${decision.count || decision.id}: pointing at ${target.type} "${target.name}" (${Math.round(target.rect.x)},${Math.round(target.rect.y)} ${Math.round(target.rect.w)}x${Math.round(target.rect.h)})`);
}

// Shows a decision: a new step moves Lefty on; the same step only follows the target if it moved, and a
// missed click wiggles the tag once to catch the user's eye.
function apply(decision, event) {
  const previous = job.decision;
  if (previous && previous.id === decision.id) {
    job.decision = decision;
    if (decision.target) {
      const moved = !previous.target || !sameRect(previous.target.rect, decision.target.rect);
      if (moved) show(decision);
      else api.setTarget(decision.target.rect); // a click on the target clears it in main: keep watching
      if (event && event.type === 'click' && !event.hit && (moved || !job.hinted)) {
        job.hinted = true;
        nudgeStepTag();
      }
    }
    autoStep(decision);
    return;
  }
  job.decision = decision;
  job.hinted = false;
  job.yourTurn = null;
  show(decision);
  speak(decision.label); // each new step, once
  autoStep(decision);
}

// The AI is working out the next step: the old ring goes, the tag says Lefty is thinking.
function showThinking() {
  if (job.thinking) return;
  job.thinking = true;
  job.decision = null;
  ring.classList.remove('show', 'hit');
  api.setTarget(null);
  setStepTag('', job.memory.history && job.memory.history.length ? 'Thinking…' : 'Looking at your screen…');
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
  setStepTag('', `Looking for ${decision.app}…`);
  api.log(`step ${decision.id}: open app "${decision.app}"`);
  const found = await api.openApp(decision.app);
  if (job !== thisJob) return;
  if (found.ok) { appOpened(thisJob, decision, found.app); return; }
  if (!found.launchable) {
    stopGuide(`I can't find ${decision.app} on this PC. If it's installed, open it and call me again.`);
    return;
  }
  if (autoOn()) { // Do it mode: opening an app is harmless, so Lefty just does it
    setStepTag('', `Opening ${found.app}…`);
    api.log(`do it: opening ${found.app}`);
    const launched = await api.launchApp({ app: found.app, appId: found.appId, want: decision.app });
    if (job !== thisJob) return;
    if (launched.ok) appOpened(thisJob, decision, launched.app);
    else stopGuide(`${found.app} didn't open. Try opening it yourself and call me again.`);
    return;
  }
  job.paused = true; // nothing moves on until the user answers
  stepTag.classList.remove('show');
  addChoices(`${found.app} isn't open. Shall I open it?`, [
    {
      label: `Yes, open ${found.app}`,
      primary: true,
      pick: async () => {
        if (job !== thisJob) return;
        job.paused = false;
        tuckBubble(true);
        setStepTag('', `Opening ${found.app}…`);
        api.log(`user said yes: opening ${found.app}`);
        const launched = await api.launchApp({ app: found.app, appId: found.appId, want: decision.app });
        if (job !== thisJob) return;
        if (launched.ok) appOpened(thisJob, decision, launched.app);
        else stopGuide(`${found.app} didn't open. Try opening it yourself and call me again.`);
      },
    },
    {
      label: 'No',
      pick: () => { if (job === thisJob) stopGuide(`Okay! Open ${found.app} when you're ready and call me again.`); },
    },
  ]);
  tuckBubble(false);
}

function appOpened(thisJob, decision, app) {
  setStepTag('', `${app} is in front`);
  setTimeout(() => { if (job === thisJob) reconsider({ type: 'opened', app, decisionId: decision.id }); }, 600);
}

/* ---------- Do it mode ----------
   In Do it mode Lefty makes each move himself: he glides to the target (so the user sees what he's about to do),
   clicks it, types, presses the keys or scrolls, and the goal loop carries on as if the user had done it. What only
   the user can decide (a file name, a password) stays theirs: the tag says "Your turn" and Lefty waits. Anything
   risky (delete, buy, send, install) is asked about first. While he works, Esc, a click or a key from the user stops
   him (moving the mouse doesn't), and the chat offers Continue. auto.js decides what each step needs. */
const modeChip = document.getElementById('modechip');
const AUTO_SHOW_MS = 600;        // the glide to the target, before the click
const AUTO_IDLE_MS = 1500;       // after the user's own turn, how long they must have stopped before Lefty acts
const AUTO_IDLE_WAIT_MAX_MS = 8000; // ...but he gets on with it after this, however busy they stay
const AUTO_MAX_SAME = 6;         // the same click this many times with nothing moving on: it isn't working
const AUTO_GRACE_MS = 600;       // the key that sent the goal may arrive just after the job starts: not a stop
const AUTO_MAX_FAILS = 6;        // failed tries at one step before the user is asked to do it
let settings = { mode: 'learn', size: 'normal', speak: 'off', privateApps: [] };
let lastUserInputAt = 0;

const autoOn = () => settings.mode === 'auto';
// Lefty is working for the user right now (thinking or acting): their input means "stop". Once a step was handed to
// the user, their input is theirs (typing a file name moves the guide on after the first letter) until Lefty acts again.
const autoWorking = () => Boolean(job) && autoOn() && !job.paused && !job.yourTurn && !job.handedOver && !job.ghost;

// Main needs to know, so a tap of Ctrl+Space shows the Stop button instead of hiding Lefty mid-task.
let toldWorking = false;
function tellWorking() {
  const working = autoWorking();
  if (working === toldWorking) return;
  toldWorking = working;
  api.setWorking(working);
}

const YOUR_TURN = {
  choice: 'Your turn: ',
  private: 'Your turn: ',
  nothing: 'Your turn: ',
  cant: "I couldn't do this one: ",
  stuck: 'Your turn: ',
};

// What the step tag says: the step, plus who does it in Do it mode.
function tagText(decision) {
  if (!autoOn() || !job) return decision.label;
  const label = LeftyAuto.stripEmoji(decision.label) || decision.label;
  if (job.yourTurn === decision.id) return `${YOUR_TURN[job.yourTurnWhy] || YOUR_TURN.nothing}${label}`;
  return label;
}

function applySettings(next) {
  const before = settings.mode;
  settings = { ...settings, ...next };
  const w = SIZES[settings.size] || SIZES.normal;
  Object.assign(leftySize, { w, h: Math.round((w * 104) / 74), tip: Math.round((w * 6) / 74) });
  leftyEl.style.width = `${w}px`;
  document.querySelectorAll('#mode button').forEach((b) => {
    const on = b.dataset.mode === settings.mode;
    b.classList.toggle('on', on);
    b.setAttribute('aria-checked', String(on));
  });
  const talking = settings.speak === 'on';
  speakButton.innerHTML = talking ? ICONS.speakerOn : ICONS.speakerOff;
  speakButton.setAttribute('aria-pressed', String(talking));
  speakButton.title = talking ? 'Lefty talks: on' : 'Lefty talks: off';
  if (!talking) hush();
  if (job && settings.mode !== before) {
    api.log(`mode: ${settings.mode === 'auto' ? 'Do it' : 'Learn'}${job.decision ? ` during ${job.decision.id}` : ''}`);
    job.yourTurn = null;
    job.okFor = null;
    if (job.decision && !job.paused && (job.decision.target || job.decision.kind === 'tell')) {
      setStepTag(job.decision.count || '', tagText(job.decision));
      autoStep(job.decision);
    }
  }
  updateModeChip();
}

api.getSettings().then(applySettings).catch(() => {});
api.onSettings(applySettings);
// After a switch in the bubble the keyboard goes back to the goal box (typing would otherwise press the switch again).
document.querySelectorAll('#mode button').forEach((b) => {
  b.addEventListener('click', () => { api.setSettings({ mode: b.dataset.mode }); input.focus(); });
});
speakButton.addEventListener('click', () => { api.setSettings({ speak: settings.speak === 'on' ? 'off' : 'on' }); input.focus(); });

// The chip beside the step tag: "Do it for me" in Learn mode, "Stop" while Lefty works.
function updateModeChip() {
  tellWorking();
  const showing = Boolean(job) && !job.paused && !job.ghost && !job.doctor && !job.coding && stepTag.classList.contains('show') && !stepTag.classList.contains('done');
  modeChip.classList.toggle('show', showing);
  if (!showing) return;
  const auto = autoOn();
  modeChip.textContent = auto ? '■ Stop' : 'Do it for me';
  modeChip.classList.toggle('stop', auto);
  placeModeChip();
}

function placeModeChip(tagBox) {
  if (!modeChip.classList.contains('show')) return;
  const tag = tagBox || { x: parseFloat(stepTag.style.left), y: parseFloat(stepTag.style.top), w: stepTag.offsetWidth, h: stepTag.offsetHeight };
  const w = modeChip.offsetWidth || 110;
  const h = modeChip.offsetHeight || 26;
  let x = tag.x + tag.w + 6;
  let y = tag.y + (tag.h - h) / 2;
  if (x + w > screenArea.width - GAP) { x = tag.x; y = tag.y + tag.h + 6; } // no room on the right: below the tag
  const box = clampToScreen({ x, y, w, h });
  setPosition(modeChip, box.x, box.y);
}

modeChip.addEventListener('click', () => {
  if (!job) return;
  if (autoOn()) stopAuto('button');
  else api.setSettings({ mode: 'auto' });
});

// The step stays the user's: what to type is their choice, it's private, or Lefty can't do it himself.
function yourTurn(decision, why) {
  if (job.yourTurn === decision.id && job.yourTurnWhy === why) return;
  job.yourTurn = decision.id;
  job.yourTurnWhy = why;
  job.handedOver = true;
  api.log(`do it: your turn (${why}) for ${decision.id}`);
  setStepTag(decision.count || '', tagText(decision));
  speak(tagText(decision));
}

// The name Lefty expects under the point before he clicks: a real button's name. Guessed spots, areas and boxes worked
// out from their neighbours have no name Windows knows.
const expectName = (target) => (target.type === 'Spot' || target.type === 'Area' || target.guessed ? '' : String(target.name || '').trim());
const centre = (rect) => ({ x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 });

async function autoStep(decision) {
  if (!autoOn() || !job || job.paused || job.autoBusy) return;
  if (['open', 'code', 'doctor', 'focus', 'build'].includes(decision.kind)) return; // act() handles these
  const plan = LeftyAuto.plan(decision);
  if (plan.yourTurn) { yourTurn(decision, plan.yourTurn); return; }
  if (job.yourTurn === decision.id) return; // handed to the user earlier (failed tries, or they chose to do it)
  if (job.acted === decision.id) return;    // done; waiting for the screen to move on
  const thisJob = job;
  const still = () => job === thisJob && !job.paused && autoOn() && job.decision && job.decision.id === decision.id;
  job.autoBusy = true;
  try {
    await sleep(AUTO_SHOW_MS);
    // Wait for a gap in what the user is doing, so Lefty's click doesn't land mid-sentence - but only for so
    // long. Someone working steadily in another window must not leave him waiting for ever.
    const waitUntil = Date.now() + AUTO_IDLE_WAIT_MAX_MS;
    while (still() && Date.now() - lastUserInputAt < AUTO_IDLE_MS && Date.now() < waitUntil) await sleep(200);
    if (!still()) return;
    const current = job.decision; // the latest read of the same step (its target may have moved)
    if (current.target && current.target.type === 'Spot' && (plan.act === 'click' || plan.act === 'type')) {
      const under = await api.autoPeek(current.target.rect);
      if (!still()) return;
      if (!LeftyAuto.spotOk(current.label, under, lastSeen.length === 0)) {
        api.log(`do it: the guessed spot for ${current.id} is on ${under.type} "${under.name}", not what the step names`);
        yourTurn(current, 'cant');
        return;
      }
    }
    if (plan.ask && job.okFor !== decision.id) { askFirst(thisJob, current, plan); return; }
    if (plan.act !== 'skip') { // the same move again and again (a click that does nothing): hand it over
      const t = current.target;
      const key = t ? `${plan.act}|${t.type}|${t.name}|${Math.round(t.rect.x)},${Math.round(t.rect.y)}` : `${plan.act}|${plan.combo || plan.text || ''}`;
      job.sameCount = job.lastAutoKey === key ? (job.sameCount || 0) + 1 : 1;
      job.lastAutoKey = key;
      if (job.sameCount > AUTO_MAX_SAME) { yourTurn(current, 'stuck'); return; }
    }
    await perform(thisJob, current, plan);
  } finally {
    if (job === thisJob) job.autoBusy = false;
  }
}

async function perform(thisJob, decision, plan) {
  const t = decision.target;
  api.log(`do it: ${plan.act} for ${decision.id}${t ? ` on ${t.type} "${t.name}"` : ''}`);
  job.handedOver = false; // Lefty is working again: from now on the user's input stops him
  if (plan.act === 'skip') { // "Pick any folder": the one the dialog shows is fine
    job.acted = decision.id;
    reconsider({ type: 'click', hit: true, auto: true, decisionId: decision.id, element: null, elements: lastSeen, point: null });
    return;
  }
  playBody('press');
  let result;
  if (plan.act === 'click') {
    api.setTarget(null); // Lefty's own click is not the user's
    result = await api.autoClick({ rect: t.rect, button: plan.button, count: plan.count, expect: expectName(t) });
  } else if (plan.act === 'type') {
    result = plan.click ? await api.autoClick({ rect: t.rect, button: 'left', count: 1, expect: expectName(t) }) : { ok: true };
    if (result.ok && job === thisJob && !job.paused) {
      await sleep(120); // the box takes the keyboard
      result = await api.autoType(plan.text);
    }
  } else if (plan.act === 'keys') {
    result = await api.autoKeys(plan.keys);
  } else if (plan.act === 'scroll') {
    result = await api.autoScroll({ rect: t.rect, notches: plan.notches });
  } else {
    return;
  }
  if (job !== thisJob) return;
  if (!result.ok) { autoFailed(decision, result.error); return; }
  job.acted = decision.id;
  job.autoFails = 0;
  if (t) ring.classList.add('hit');
  if (job.paused) return; // stopped while acting: the step is done, the rest waits for Continue
  if (plan.act === 'click') {
    reconsider({ type: 'click', hit: true, auto: true, point: centre(t.rect), element: t, elements: lastSeen, decisionId: decision.id, targetName: t.name });
  } else if (plan.act === 'keys') {
    reconsider({ type: 'key', combo: plan.combo, auto: true, decisionId: decision.id });
  } else {
    reconsider({ type: 'acted', auto: true, decisionId: decision.id });
  }
}

async function autoFailed(decision, error) {
  api.log(`do it: ${decision.id} failed (${error})`);
  if (error === 'password') { yourTurn(decision, 'private'); return; } // he can't know the password anyway
  const thisJob = job;
  job.autoFails = (job.autoFails || 0) + 1;
  // Something in the way, or the app no longer in front: put that right and keep going. A task is not over
  // because a window moved - the user would have to start again, which is worse than Lefty trying once more.
  if (error === 'covered' || error === 'not-front' || error === 'no-window') {
    if (job.autoFails < AUTO_MAX_FAILS) {
      setStepTag('', 'Getting back to the app…');
      await api.focusGoalApp();
      if (job !== thisJob) return;
      await sleep(400);
      if (job !== thisJob) return;
      reconsider(null);
      return;
    }
    stopAuto(error, "I can't get back to the app, so I've stopped.");
    return;
  }
  if (job.autoFails >= AUTO_MAX_FAILS) { yourTurn(decision, 'cant'); return; }
  reconsider(null); // the screen moved on (or the target moved): look again
}

// Risky steps wait for a yes. The ring stays on what Lefty would click.
function askFirst(thisJob, decision, plan) {
  job.paused = true;
  updateModeChip();
  api.log(`do it: asking first (${plan.ask})`);
  addChoices(`${plan.ask}. Shall I do it?`, [
    {
      label: 'Yes, do it',
      primary: true,
      pick: () => {
        if (job !== thisJob) return;
        job.paused = false;
        job.okFor = decision.id;
        tuckBubble(true);
        api.log('do it: the user said yes');
        autoStep(job.decision && job.decision.id === decision.id ? job.decision : decision);
      },
    },
    {
      label: "I'll do it",
      pick: () => {
        if (job !== thisJob) return;
        job.paused = false;
        tuckBubble(true);
        yourTurn(decision, 'choice');
        api.focusApp();
      },
    },
    { label: 'Stop', pick: () => { if (job === thisJob) stopGuide("Okay, I stopped there."); } },
  ]);
  tuckBubble(false);
}

// Esc, the Stop chip, or the user's own click or key while Lefty works: he stops and offers to go on.
function stopAuto(why, message) {
  if (!job || job.paused) return;
  const thisJob = job;
  job.paused = true;
  lookToken += 1; // a look already on its way must not act any more
  looking = false;
  ring.classList.remove('show', 'hit');
  stepTag.classList.remove('show', 'glide');
  api.setTarget(null);
  updateModeChip();
  api.log(`do it: stopped (${why})`);
  const said = message || (why === 'esc' || why === 'button' ? 'Stopped.' : 'You took over, so I stopped.');
  addChoices(`${said} Carry on yourself, or let me continue.`, [
    { label: 'Continue', primary: true, pick: () => resumeAuto(thisJob, 'auto') },
    { label: 'Guide me instead', pick: () => resumeAuto(thisJob, 'learn') },
  ]);
  tuckBubble(false);
}

function resumeAuto(thisJob, mode) {
  if (job !== thisJob) return;
  api.log(`do it: ${mode === 'auto' ? 'continuing' : 'guiding instead'}`);
  if (mode !== settings.mode) {
    settings.mode = mode; // at once, so the next decision is made in the new mode; main confirms and saves it
    api.setSettings({ mode });
  }
  Object.assign(job, { paused: false, acted: null, autoFails: 0, yourTurn: null, handedOver: false, okFor: null, decision: null, sameCount: 0 });
  tuckBubble(true);
  api.focusApp();
  if (job.doctor) { autoDoctor(thisJob); return; }
  reconsider({ type: 'resumed' });
}

// Do it mode for code: Lefty writes it into VS Code himself instead of drawing it to type over.
async function writeCode(decision) {
  if (job.coding === decision.id) return;
  const thisJob = job;
  job.coding = decision.id;
  job.decision = decision;
  ring.classList.remove('show', 'hit', 'error');
  api.setTarget(null);
  retreatToCorner();
  setStepTag('', 'Writing the code…');
  playBody('press');
  const result = await api.autoCode(decision.code);
  if (job !== thisJob) return;
  if (!result.ok && result.error === 'not-editor') { codeInChat(decision.code, "Here's the code. (I can write it in for you in VS Code.)"); return; }
  if (!result.ok) { stopGuide("I couldn't write into your editor. Click into your code and ask me again."); return; }
  finish({ done: true, message: 'Done! I wrote the code for you. Run it to see it work.' });
}

// Ctrl+Space while Lefty is working: his chat comes back so the Stop button can be reached. The task keeps
// going meanwhile - only Stop ends it.
api.onReveal(() => {
  if (!job) return;
  tuckBubble(false);
  api.setInteractive(true); // the buttons have to be clickable, even mid-task
  updateModeChip();
  if (!autoWorking()) return;
  const thisJob = job;
  api.log('chat brought back mid-task');
  addChoices("I'm still on it. Shall I carry on, or stop?", [
    { label: '▶ Carry on', primary: true, pick: () => { if (job === thisJob) { tuckBubble(true); api.setInteractive(false); } } },
    { label: '■ Stop', pick: () => { if (job === thisJob) stopAuto('button'); } },
  ]);
});

// Main says the user clicked, turned the wheel or pressed a key (not which key, except Esc).
// Working on your own means working through this: using the PC while Lefty works no longer stops him, and
// neither does Esc. He only waits for a gap in what you are doing (AUTO_IDLE_MS below) so his click doesn't
// land in the middle of your typing. The one way to stop him is Ctrl+Space, which brings his chat back with a
// Stop button on it.
api.onInput(({ kind }) => {
  if (kind === 'key' && document.hasFocus()) return; // typed into Lefty's own chat box, not the app
  lastUserInputAt = Date.now();
});

/* ---------- Ghost code ----------
   "Write a linked list" in VS Code: the brain writes the code and Lefty draws it as faint text at the user's text
   cursor, like an inline suggestion, for them to type over. Main reports the cursor many times a second
   (onCaret); ghost.js works out which line they're on and what's left; this draws it in the editor's own font,
   so every character lands where the real one will. Until they start typing, the code follows the cursor. */
const ghostEl = document.getElementById('ghost');
// Ghost code works in whatever editor answers. Lefty needs two things from one, both read through Windows UI
// Automation: the rectangle of the cursor's line, and "Ln 12, Col 5" in its status bar. Any editor that reports
// those is followed - listed in src/editors.js or not. One that stays quiet gets the code in the chat with the
// reason why, which for the JetBrains IDEs is a setting they can turn on.
const NO_LN_COL_MS = 3000;
let ghostOn = false;
let measureCanvas = null;

// Why Lefty can't follow the cursor here, in words the user can act on.
function noCursorHint(process) {
  const editor = LeftyEditors.find(process);
  if (editor && editor.needsAccessibility) {
    return `Here's the code to type. (To draw it at your cursor in ${LeftyEditors.describe(process)}, turn on ${editor.needsAccessibility}.)`;
  }
  if (editor) return `Here's the code to type. (Show the Ln/Col in ${LeftyEditors.describe(process)}'s status bar and I can draw it at your cursor.)`;
  return "Here's the code to type. (Your editor doesn't tell me where the cursor is, so I can't draw it there.)";
}

// options.gap: lines left free above the code before typing starts (1 for new code, 0 to retype a line in place);
// options.onDone: what happens when it's all typed (default: the goal is done).
function startGhost(decision, { gap = 1, onDone = null, tag = 'Press Enter, then type along' } = {}) {
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
  'not-editor': "I can check code in VS Code (or Cursor). Open your file there and ask me again.",
  'not-front': "I couldn't get to your editor. Click into your code and ask me again.",
  'no-cursor': 'Click into your code first, then ask me again.',
  secret: "That file looks like it holds secrets (keys, passwords), so I won't read it.",
  'no-copy': "I couldn't read your code. Click into the file and ask me again.",
  failed: "I couldn't read your code. Click into the file and ask me again.",
  private: "This editor is on your private list, so I won't send its code anywhere. (Change that on my home screen.)",
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
  setStepTag('', 'Reading your code…');
  const read = await api.doctorRead();
  if (job !== thisJob) return;
  if (!read.ok) { stopGuide(DOCTOR_PROBLEMS[read.error] || DOCTOR_PROBLEMS.failed); return; }
  if (!read.code.trim()) { stopGuide('Your file is empty, so nothing can be wrong yet!'); return; }
  setStepTag('', `Checking ${read.fileName || 'your code'}…`);
  const result = await api.doctorCheck({ code: read.code, fileName: read.fileName, goal, hint: read.hint });
  if (job !== thisJob) return;
  if (!result.ok) { stopGuide(result.error); return; }
  if (!result.problems.length) { stopGuide(result.summary || "I don't see any errors in your code."); return; }
  Object.assign(job.doctor, { lines: read.code.split('\n'), problems: result.problems, fileName: read.fileName });
  api.log(`doctor: ${result.problems.length} problem(s) in ${read.fileName || 'the file'}`);
  showProblem(thisJob);
}

async function showProblem(thisJob) {
  const d = job.doctor;
  const p = d.problems[d.i];
  if (!p) { doctorDone(); return; }
  const count = `${d.i + 1}/${d.problems.length}`;
  setStepTag(count, `Going to line ${p.line}…`);
  const at = await api.doctorGoto({ line: p.line, col: 1 });
  if (job !== thisJob) return;
  if (!at.ok) { stopGuide(`I couldn't get to line ${p.line}. Click into your code and ask me again.`); return; }
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
  const el = addMessage(`Line ${p.line}: ${p.message}`, 'lefty');
  el.classList.add('has-code');
  const pre = document.createElement('pre');
  pre.className = 'code';
  pre.textContent = p.fixed;
  el.append(pre);
  const choices = addChoicesTo(el, [
    { label: 'Fix it for me', primary: true, pick: () => { p.picked = true; doctorFix(thisJob, p); } },
    { label: "I'll type it", pick: () => { p.picked = true; doctorRetype(thisJob, p); } },
    { label: 'Skip', pick: () => { p.picked = true; doctorNext(thisJob); } },
  ]);
  d.choices = choices;
  tuckBubble(false);
  pointAt({ rect });
  bubbleClearOfRow(rect); // the fix is drawn beside the wrong line: the chat keeps off that row
  ring.classList.add('error');
  api.raise();
  setStepTag(count, `${p.message}`);
  api.log(`doctor: showing line ${p.line}${p.endLine > p.line ? `-${p.endLine}` : ''} (${Math.round(rect.x)},${Math.round(rect.y)} ${Math.round(rect.w)}x${Math.round(rect.h)})`);
  autoDoctor(thisJob);
}

// Do it mode: each error is shown for a moment (so the user sees what changes), then Lefty fixes it himself.
const AUTO_DOCTOR_SHOW_MS = 1400;
function autoDoctor(thisJob) {
  const d = job.doctor;
  const p = d.problems[d.i];
  if (!autoOn() || !p || p.picked) return;
  setTimeout(() => {
    if (job !== thisJob || job.paused || !autoOn() || p.picked || d.problems[d.i] !== p) return;
    p.picked = true;
    if (d.choices) d.choices.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    api.log(`do it: fixing line ${p.line}`);
    doctorFix(thisJob, p);
  }, AUTO_DOCTOR_SHOW_MS);
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
  setStepTag(`${job.doctor.i + 1}/${job.doctor.problems.length}`, 'Fixing it…');
  const result = await api.doctorFix({ line: p.line, endLine: p.endLine, text: p.fixed });
  if (job !== thisJob) return;
  if (!result.ok) { stopGuide("I couldn't change your code. Click into the file and try again, or type the fix yourself."); return; }
  applyFixLocally(job.doctor, p);
  ring.classList.remove('error');
  ring.classList.add('hit');
  setStepTag(`${job.doctor.i + 1}/${job.doctor.problems.length}`, 'Fixed!', { done: true });
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
  if (!result.ok) { stopGuide("I couldn't get your code ready. Click into the file and try again."); return; }
  const code = lines.map((l) => (l.startsWith(indent) ? l.slice(indent.length) : l.trimStart())).join('\n');
  startGhost({ id: `doctor:${p.line}`, code }, {
    gap: 0,
    tag: 'Type the fix',
    onDone: () => {
      if (job !== thisJob) return;
      applyFixLocally(job.doctor, p);
      setStepTag(`${job.doctor.i + 1}/${job.doctor.problems.length}`, 'Nice, fixed!', { done: true });
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
  const message = d.fixed === n ? `All ${n === 1 ? 'fixed' : `${n} fixed`}! Run your code to see it work.${autoOn() ? ' (Ctrl+Z undoes a fix.)' : ''}`
    : d.fixed ? `Fixed ${d.fixed} of ${n}. The rest is up to you!` : `That's all ${n === 1 ? 'of it' : n}. Fix them whenever you're ready.`;
  api.log(`doctor: done, ${d.fixed} of ${n} fixed`);
  stopGuide(message);
  retreatToCorner();
}

api.onCaret(async (caret) => {
  const g = job && job.ghost;
  if (!g || g.done || !caret.inFront) { if (g) ghostEl.classList.remove('show'); return; }
  const waited = Date.now() - g.since > NO_LN_COL_MS;
  if (!caret.line) {
    ghostEl.classList.remove('show');
    // A known editor with the focus in a side panel just needs a click back into the code. An app that never
    // reports a cursor line is not somewhere Lefty can draw at all.
    if (waited && !LeftyEditors.isKnown(caret.process)) { codeInChat(g.code, noCursorHint(caret.process)); return; }
    setStepTag('', 'Click in your code file');
    return;
  }
  if (!caret.ln) {
    if (waited) codeInChat(g.code, noCursorHint(caret.process));
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
    setStepTag(`${view.row + 1}/${view.total}`, 'Type along');
  }
});

// Acts on a decision; false means "nothing to do yet, look again".
function act(decision, event) {
  if (decision.done) { finish(decision); return true; }
  if (decision.giveUp) { api.log(`gave up: ${decision.giveUp}`); stopGuide(decision.giveUp); return true; }
  if (decision.say) { api.log(`said: ${decision.say}`); stopGuide(decision.say); return true; }
  if (decision.thinking) { showThinking(); return true; }
  if (decision.kind === 'open') { job.thinking = false; openApp(decision); return true; }
  if (decision.kind === 'code') { job.thinking = false; if (autoOn()) writeCode(decision); else startGhost(decision); return true; }
  if (decision.kind === 'doctor') { startDoctor(job.goal); return true; }
  if (decision.kind === 'focus') { startFocus(decision); return true; }
  if (decision.kind === 'build') { startBuild(decision); return true; }
  if (decision.target || decision.kind === 'tell') { job.thinking = false; apply(decision, event); return true; }
  return false;
}

// After the user did something: look again (a few times, the screen may still be changing) and decide.
async function reconsider(event) {
  if (!job || job.paused || job.ghost || job.doctor || job.coding) return; // waiting for the user's answer, ghost code, the code doctor, or writing code
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
    stopGuide(stuck || "I lost track of the screen. Call me again when you're ready.");
  } finally {
    if (look === lookToken) looking = false;
  }
}

// Between the user's actions: progress made from the keyboard (Enter in a dialog, shortcuts) still counts.
async function watch() {
  if (!job || looking || job.paused || job.ghost || job.doctor || job.coding || job.autoBusy) return; // ghost code follows the cursor instead (onCaret)
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
    stopGuide('Okay, cancelled. What next?');
    return;
  }
  const done = decision.message || 'Done!';
  setStepTag('', done, { done: true });
  const token = lookToken;
  setTimeout(() => { // let the green tag show first, then Lefty steps out of the way, ready for the next goal
    if (token !== lookToken) return;
    stopPointing();
    addMessage((decision.message || autoOn()) ? `${done} What next?` : `${done} You did it. What next?`, 'lefty'); // before placing, so the bubble is measured at its new height
    retreatToCorner();
    tuckBubble(false);
  }, 1200);
}

// After a goal Lefty moves to the bottom-right corner, so his chat never covers the user's work.
function retreatToCorner() {
  const x = screenArea.width - leftySize.w - GAP * 3;
  const y = screenArea.height - leftySize.h - GAP * 5;
  leftyEl.classList.add('glide');
  bubble.classList.add('glide');
  place({ x: x - 12, y: y - 12, width: screenArea.width, height: screenArea.height });
}

// A screen read that failed (some apps refuse for a moment while they redraw), as an empty but usable read: the
// brain works from the screenshot, and the skill keeps the last target instead of thinking it vanished.
const asSeen = (seen) => (seen && seen.ok ? seen : { ok: true, unread: true, elements: [], title: '', app: '' });

// VS Code and its cousins, where Lefty can follow the text cursor and read the code.
// Any editor Lefty knows, by the app's name or its window title: where "find the error" goes straight to the
// code doctor, and where his greeting offers to fix the problems the editor is showing.
const isCodeEditor = (seen) => Boolean(seen && seen.ok) && LeftyEditors.isCodeEditor(seen);

// The AI is told the mode, so in Do it mode it says exactly what to type. It says which language the user speaks,
// which Lefty's voice and his explanations follow.
let lastLang = '';
async function think(request) {
  const answer = await api.think({ ...request, auto: autoOn(), earlier: chat.earlier.slice(0, -1) });
  if (answer && answer.ok && answer.lang) lastLang = answer.lang;
  return answer;
}

// A job for this skill on the screen as seen: the goal loop takes it from here.
function beginJob(skill, goal) {
  const thisJob = { skill, goal, memory: {}, decision: null, hinted: false, startedAt: Date.now() };
  thisJob.memory.wake = () => { if (job === thisJob) watch(); };
  job = thisJob;
  return thisJob;
}

// The first decision is shown and Lefty watches from then on (nothing to show yet: he looks again).
function runJob(first) {
  if (!act(first, null)) {
    if (first.stuck || first.giveUp) { stopGuide(first.stuck || first.giveUp); return; }
    reconsider(null);
  }
  if (!job) return;
  tuckBubble(true);
  api.focusApp(); // the next move is in the app: many apps ignore the first click while inactive
  watchTimer = setInterval(watch, WATCH_EVERY_MS);
}

// The installed app reads %APPDATA%\lefty\.env (run from the code, the .env next to package.json works too).
const NO_KEY_HINT = 'Get a free key at aistudio.google.com/apikey and put GEMINI_API_KEY=your-key in a .env file in %APPDATA%\\lefty, then ask again.';

async function ask(goal) {
  addMessage(goal, 'user');
  input.value = '';
  cancelJob();
  stopPointing();
  hideTip();
  tuckBubble(false); // replies show in the chat; it tucks away again only if a guide starts
  const token = lookToken;

  // "Focus 30 minutes on Chrome": handled here, no brain needed.
  const focusAsk = LeftyFocus.parse(goal);
  if (focusAsk) { startFocus(focusAsk.stop ? { minutes: 0 } : focusAsk); return; }

  const brainOn = await api.brainReady();
  if (token !== lookToken) return;
  if (LeftyMatch.isStuck(goal) && !brainOn) {
    addMessage(`The AI isn't connected yet. ${NO_KEY_HINT} For now, try "save this", or a path like File > Save as.`, 'lefty');
    return;
  }
  const steps = LeftyMatch.parsePlan(goal);
  if (!steps.length) return;

  const typing = showTyping();
  let seen = await contextReady;
  typing.remove();
  if (token !== lookToken) return; // Lefty was closed, or asked something else, meanwhile

  if (!seen.ok && !brainOn) {
    addMessage("I couldn't read this app's buttons, sorry. Try clicking into the app and calling me again.", 'lefty');
    return;
  }
  const unreadable = !seen.ok; // the brain still sees the screenshot, so it can guide anyway
  if (unreadable) seen = asSeen(seen);
  // Free and instant first: saving, a typed path, or a short button name found on screen. Anything else
  // (a question, a task in words, or a button that isn't there) goes to the brain.
  const startJob = (skill, { decide = true } = {}) => {
    beginJob(skill, goal);
    return decide ? LeftySkills.decide(job, seen) : null;
  };
  // "Find the error" in a code editor: straight to the code doctor, no first trip to the brain.
  if (brainOn && !unreadable && isCodeEditor(seen) && LeftySkills.isCodeCheckGoal(goal)) {
    startJob(LeftySkills.aiSkill(goal, think), { decide: false });
    startDoctor(goal);
    return;
  }
  const longRequest = steps.length === 1 && goal.split(/\s+/).length > 3;
  let first = null;
  if (!unreadable && !(brainOn && (LeftyMatch.isStuck(goal) || (longRequest && !LeftySkills.isSaveGoal(goal))))) {
    first = startJob(steps.length === 1 && LeftySkills.isSaveGoal(goal) ? LeftySkills.saveSkill(goal) : LeftySkills.pathSkill(steps));
    if (!first.target && brainOn && steps.length === 1) first = null; // not found the simple way: ask the brain
  }
  if (!first) first = startJob(LeftySkills.aiSkill(goal, think));
  if (!first.target && !first.thinking && first.kind !== 'tell') {
    const notFound = job.skill.name === 'path'
      ? (steps.length === 1
        ? `I can't spot "${goal}" on this screen. ${brainOn ? '' : `Connect the AI and I'll plan every step for you. ${NO_KEY_HINT}`}`
        : `I can't spot "${steps[0]}" on this screen.`)
      : (first.giveUp || first.stuck || "I can't see how to do that here yet.");
    stopGuide(notFound.trim());
    return;
  }
  runJob(first);
}

// A goal said out loud: the recording goes to the brain with the screen, which says what it heard (shown in the
// chat in place of "…") and the first step, in the language it was said in.
async function askVoice(audio) {
  const said = addMessage('Voice request…', 'user');
  input.value = '';
  cancelJob();
  stopPointing();
  hideTip();
  tuckBubble(false);
  const token = lookToken;
  const typing = showTyping();
  const seen = asSeen(await contextReady);
  typing.remove();
  if (token !== lookToken) return;
  const thisJob = beginJob(null, '');
  thisJob.skill = LeftySkills.aiSkill('', think, {
    audio,
    onHeard: (words) => {
      said.textContent = words;
      if (job === thisJob) job.goal = words; // e.g. the code doctor reads the goal
    },
  });
  api.log('voice: goal sent to the brain');
  runJob(LeftySkills.decide(job, seen));
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

let lastSeenApp = { app: '', title: '', private: false };

function rememberSeen(seen) {
  if (!seen || !seen.ok) return;
  lastSeen = seen.elements;
  lastSeenAt = Date.now();
  if (seen.app) lastSeenApp = { app: seen.app, title: seen.title || '', private: Boolean(seen.private) };
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
  guardTag.textContent = `${risk.warning}`;
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
  const point = { x: event.clientX + screenArea.originX, y: event.clientY + screenArea.originY };
  if (tip && !near(tip.element.rect, point, TIP_KEEP_PX)) hideTip(); // moved away from the explained button
  if (picking) { previewPick(point); return; }
  if (!leftyEl.classList.contains('show') || (job && (job.ghost || job.doctor))) return; // no screen reads while ghost code follows the cursor
  if (focusBlock && focusBlock.quiet) return; // only passing by to close something: not summoned
  if (bubble.contains(event.target) && !bubble.classList.contains('tucked')) { hideGuard(); return; } // over Lefty's own chat
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
  reportRegions();
  setTimeout(() => input.focus(), 60);
  setTimeout(() => api.log(`bubble buttons: ${[...bubble.querySelectorAll('.bubble-head button, .ask button, .chips button')].map((b) => `"${b.textContent}" ${whereIs(b)}`).join(', ')}`), 700);
});

api.onContext((seen) => {
  if (seen.seq !== currentSeq) return;
  rememberSeen(seen);
  if (seen.ok && greeting && greeting.isConnected) {
    greeting.textContent = seen.private
      ? `Hi! I can see ${seen.app}. It's on your private list, so I'll work from its buttons only, with no screenshots. What's your goal?`
      : `Hi! I can see ${seen.app}. What's your goal?`;
    // The editor's own problem count ("Errors: 1, Warnings: 2"): offer to find and fix them.
    const problems = isCodeEditor(seen) ? seen.elements.map((el) => /^(?:Errors?|Warnings?): (\d+)/.exec(el.name || '')).filter(Boolean)
      .reduce((sum, m) => sum + Number(m[1]), 0) : 0;
    if (problems) {
      greeting.textContent = `Hi! I spot ${problems} problem${problems === 1 ? '' : 's'} in your code. Want me to find ${problems === 1 ? 'it' : 'them'}?`;
      addChoicesTo(greeting, [{ label: 'Find & fix', primary: true, pick: () => ask('find the errors in my code') }]);
    }
  }
  resolveContext(seen);
});

// A goal typed in the home screen's chat: Lefty is up over the app in front; an opened chat continues where it
// stopped (its last few messages show again, and a project built in it is the one a change goes to).
api.onAsk(async ({ goal, chatId }) => {
  if (chatId) {
    const r = await api.chatGet(chatId).catch(() => null);
    const old = r && r.ok && r.chat;
    if (old) {
      if (greeting && greeting.isConnected) greeting.remove();
      for (const m of old.messages.slice(-4)) addMessage(m.text, m.role === 'user' ? 'user' : 'lefty', { say: false, save: false });
      chat = { id: old.id, ready: Promise.resolve(old.id), earlier: old.messages.slice(-12).map((m) => `${m.role === 'user' ? 'User' : 'Lefty'}: ${String(m.text).slice(0, 600)}`) };
      if (old.project) lastProject = old.project;
    }
  }
  ask(goal);
});

api.onHide(() => {
  cancelJob();
  hush();
  hideTip();
  endPick();
  stopListening(false);
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
  if (event.key !== 'Escape') return;
  if (picking) { endPick(); return; }
  if (listening) { stopListening(false); return; }
  if (tip) { hideTip(); return; }
  if (autoWorking()) return; // Esc never stops him mid-task, and never hides the Stop button: that's Ctrl+Space
  else api.requestHide();
});

/* ---------- Speaking ----------
   With "Lefty talks" on, his chat replies, each new step and his explanations are read out with a Windows voice: in
   the user's language when the AI said which (or the words' own script shows it), else the default voice. */
let lastSpoken = ''; // for the self-test
function speak(text, lang = lastLang) {
  if (settings.speak !== 'on' || !window.speechSynthesis) return;
  const said = LeftyVoice.speakable(text);
  if (!said) return;
  try {
    speechSynthesis.cancel(); // only the newest thing is worth hearing
    const utterance = new SpeechSynthesisUtterance(said);
    const want = LeftyVoice.voiceLang(said, lang);
    const voice = LeftyVoice.pickVoice(speechSynthesis.getVoices(), want);
    if (voice) utterance.voice = voice;
    if (want) utterance.lang = voice ? voice.lang : want;
    utterance.rate = 1.05;
    speechSynthesis.speak(utterance);
    lastSpoken = said;
    api.log(`speaking ${said.length} characters${voice ? ` (${voice.name})` : ''}`);
  } catch { /* no voices on this PC: Lefty stays quiet */ }
}

function hush() {
  try { if (window.speechSynthesis) speechSynthesis.cancel(); } catch { /* nothing was speaking */ }
}

/* ---------- "What does this do?" ----------
   F1 with the mouse on a control (main sends the point), or "What's this?" in the bubble and then a click: Lefty rings
   the control and explains it beside it in a sentence or two. The brain sees its name, the controls around it and a
   small picture of that part of the screen (never in a private app). No goal needed, and a running guide carries on. */
const tipEl = document.getElementById('tip');
const tipRing = document.getElementById('tip-ring');
const pickLayer = document.getElementById('picklayer');
const pickHint = document.getElementById('pickhint');
const TIP_PAD = 3;
const TIP_KEEP_PX = 60;      // the explanation stays while the mouse is this close to the control
const TIP_SHOW_MS = 20000;
const NEARBY_PX = { x: 220, y: 120 };
let tip = null;              // { element, token, timer }
let tipToken = 0;
let picking = false;
let pickWasTucked = false;

const near = (rect, point, pad) => point.x >= rect.x - pad && point.x <= rect.x + rect.w + pad && point.y >= rect.y - pad && point.y <= rect.y + rect.h + pad;

// The names of the controls around one (what the AI needs to tell a "Close" in a dialog from a "Close" on a tab).
function nearbyNames(element, elements) {
  const cx = element.rect.x + element.rect.w / 2;
  const cy = element.rect.y + element.rect.h / 2;
  const names = elements.filter((el) => el !== element && el.rect && String(el.name || '').trim()
    && Math.abs(el.rect.x + el.rect.w / 2 - cx) <= NEARBY_PX.x && Math.abs(el.rect.y + el.rect.h / 2 - cy) <= NEARBY_PX.y)
    .map((el) => String(el.name).trim().slice(0, 60));
  return [...new Set(names)].slice(0, 12);
}

function showTip(element, text, { waiting = false, risky = false } = {}) {
  hideGuard();
  clearTimeout(tip && tip.timer);
  const token = ++tipToken;
  tip = { element, token, timer: setTimeout(() => { if (tip && tip.token === token) hideTip(); }, TIP_SHOW_MS) };
  const r = { x: element.rect.x - screenArea.originX, y: element.rect.y - screenArea.originY, w: element.rect.w, h: element.rect.h };
  setPosition(tipRing, r.x - TIP_PAD, r.y - TIP_PAD);
  tipRing.style.width = `${r.w + TIP_PAD * 2}px`;
  tipRing.style.height = `${r.h + TIP_PAD * 2}px`;
  tipRing.classList.add('show');
  setTipText(text, { waiting, risky });
  api.raise();
  return token;
}

// The explanation goes below the control, or above it when there's no room.
function setTipText(text, { waiting = false, risky = false } = {}) {
  if (!tip) return;
  tipEl.textContent = text;
  tipEl.classList.toggle('waiting', waiting);
  tipEl.classList.toggle('risky', risky);
  tipEl.classList.add('show');
  const r = { x: tip.element.rect.x - screenArea.originX, y: tip.element.rect.y - screenArea.originY, w: tip.element.rect.w, h: tip.element.rect.h };
  const w = tipEl.offsetWidth || 260;
  const h = tipEl.offsetHeight || 40;
  const below = r.y + r.h + TIP_PAD + 8;
  const y = below + h <= screenArea.height - GAP ? below : r.y - TIP_PAD - h - 8;
  const box = clampToScreen({ x: r.x - TIP_PAD, y, w, h });
  setPosition(tipEl, box.x, box.y);
}

function hideTip() {
  if (!tip) return;
  clearTimeout(tip.timer);
  tip = null;
  tipToken += 1; // an answer still on its way is not shown
  tipEl.classList.remove('show', 'waiting', 'risky');
  tipRing.classList.remove('show');
}

const TYPE_WORDS = { Button: 'button', SplitButton: 'button', MenuItem: 'menu item', TabItem: 'tab', ListItem: 'item', TreeItem: 'item',
  Hyperlink: 'link', CheckBox: 'tick box', RadioButton: 'option', ComboBox: 'drop-down', Edit: 'text box', Slider: 'slider', Document: 'text area' };

async function explainAt(point) {
  if (!leftyEl.classList.contains('show')) return;
  if (Date.now() - lastSeenAt > GUARD_STALE_MS) rememberSeen(await api.rescan({ quiet: true }));
  const element = LeftyGuard.elementAt(point, lastSeen);
  if (!element) {
    showTip({ rect: { x: point.x - 12, y: point.y - 12, w: 24, h: 24 } }, "Rest the mouse on a button, then press F1 and I'll tell you what it does.");
    return;
  }
  const token = showTip(element, 'Let me look…', { waiting: true });
  api.log(`explain: ${element.type} "${element.name}"`);
  const result = await api.explain({
    element: { name: element.name, type: element.type, rect: element.rect }, nearby: nearbyNames(element, lastSeen),
    app: lastSeenApp.app, title: lastSeenApp.title, lang: lastLang,
  });
  if (!tip || tip.token !== token) return; // the mouse moved on, or another button was asked about
  const name = String(element.name || '').trim();
  const what = `${name ? `"${name}"` : 'This'} ${name ? `is a ${TYPE_WORDS[element.type] || 'control'}` : `is a ${TYPE_WORDS[element.type] || 'control'} without a name`}`;
  const text = result.ok ? result.text
    : result.error === 'no-brain' ? `${what}. Connect the AI and I'll tell you what it does.`
      : result.error === 'nothing' ? "I can't tell what's there." : result.error;
  setTipText(result.ok && result.risky ? `${text}` : text, { risky: Boolean(result.ok && result.risky) });
  api.log(`explain: answered (${result.ok ? 'brain' : result.error})`);
  speak(text);
}
api.onExplain((point) => { if (picking) endPick(); explainAt(point); });

// "What's this?" in the bubble: the next click anywhere picks the control (and doesn't reach the app).
function startPick() {
  if (picking || !leftyEl.classList.contains('show')) return;
  picking = true;
  hideTip();
  hideGuard();
  pickWasTucked = bubble.classList.contains('tucked');
  tuckBubble(true);
  pickLayer.classList.add('show');
  pickHint.classList.add('show');
  api.setPicking(true);
  api.log('explain: picking a control');
  api.rescan({ quiet: true }).then(rememberSeen).catch(() => {});
}

function endPick() {
  if (!picking) return;
  picking = false;
  pickLayer.classList.remove('show');
  pickHint.classList.remove('show');
  tipRing.classList.remove('show');
  api.setPicking(false);
  if (!pickWasTucked) tuckBubble(false);
}

function previewPick(point) {
  const element = LeftyGuard.elementAt(point, lastSeen);
  if (!element) { tipRing.classList.remove('show'); return; }
  const r = element.rect;
  setPosition(tipRing, r.x - screenArea.originX - TIP_PAD, r.y - screenArea.originY - TIP_PAD);
  tipRing.style.width = `${r.w + TIP_PAD * 2}px`;
  tipRing.style.height = `${r.h + TIP_PAD * 2}px`;
  tipRing.classList.add('show');
}

pickLayer.addEventListener('click', (event) => {
  const point = { x: event.clientX + screenArea.originX, y: event.clientY + screenArea.originY };
  endPick();
  explainAt(point);
});
document.getElementById('whats-this').addEventListener('click', startPick);

/* ---------- Focus mode ----------
   "Focus 30 minutes on Chrome and physics", typed or said: until the time is up, main closes anything else that comes
   to the front, and Lefty pops up to say why. Without a list of work apps or tabs, Lefty asks (suggesting the app he
   was called over). */
let focusState = { on: false };
let focusNoticeTimer = null;
const FOCUS_NOTICE_MS = 6000; // a "not now" pops up and goes again by itself, unless the user starts typing
const BLOCKED_LINES = [
  'That can wait until you complete your work.',
  'Not now. Please finish your work first.',
  'That can wait until your focus session ends.',
];
api.getFocus().then((state) => { focusState = state; }).catch(() => {});
api.onFocus((state) => { focusState = state; });

const focusLeft = () => LeftyFocus.timeLeft(focusState.until - Date.now());
const workAppSuggestion = () => (/^(your desktop|the taskbar|this app)$/.test(lastSeenApp.app || '') ? '' : lastSeenApp.app || '');

async function startFocus({ minutes, allow = [] }) {
  cancelJob();
  stopPointing();
  tuckBubble(false);
  if (!minutes) { // "stop focus mode"
    if (focusState.on) { await api.stopFocus(); addMessage('Focus mode is off.', 'lefty'); } else addMessage("Focus mode isn't on.", 'lefty');
    return;
  }
  if (!allow.length) { askFocusApps(minutes); return; }
  const result = await api.startFocus({ minutes, allow });
  if (!result.ok) { addMessage(`${result.error}`, 'lefty'); return; }
  api.log(`focus: on for ${minutes} min`);
  addMessage(`Focus mode on for ${LeftyFocus.timeLeft(minutes * 60000)}. Only ${allow.join(', ')} until then; I'll close anything else. Say "stop focus mode" to end it early.`, 'lefty');
}

// A small answer box inside a message: the text, a main button and optional extras. onSubmit gets the text.
function askInMessage(el, { value = '', placeholder = '', label, button, extras = [], onSubmit }) {
  const row = document.createElement('form');
  row.className = 'namebox';
  const box = document.createElement('input');
  box.value = value;
  box.placeholder = placeholder;
  box.maxLength = 300;
  box.spellcheck = false;
  box.setAttribute('aria-label', label);
  const go = document.createElement('button');
  go.type = 'submit';
  go.className = 'primary';
  go.textContent = button;
  const parts = extras.map((extra) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = extra.label;
    b.title = extra.title || '';
    b.addEventListener('click', () => extra.pick(box));
    return b;
  });
  const done = () => [box, go, ...parts].forEach((x) => { x.disabled = true; });
  row.addEventListener('submit', (event) => {
    event.preventDefault();
    if (go.disabled || !box.value.trim()) return;
    done();
    onSubmit(box.value.trim());
  });
  row.append(box, ...parts, go);
  el.append(row);
  keepBubbleOnScreen();
  api.focusSelf();
  setTimeout(() => { box.focus(); box.select(); }, 80);
  return box;
}

function askFocusApps(minutes) {
  const el = addMessage(`${LeftyFocus.timeLeft(minutes * 60000)} of focus. Which apps or tabs are for your work? (e.g. VS Code, physics)`, 'lefty');
  askInMessage(el, {
    value: workAppSuggestion(), placeholder: 'VS Code, Chrome, notes', label: 'Apps for your work', button: 'Start',
    onSubmit: (text) => startFocus({ minutes, allow: text.split(/,|\band\b/).map((s) => s.trim()).filter(Boolean) }),
  });
}

// The session is over: Lefty comes up and says so.
api.onFocusNotice(({ kind, minutes }) => {
  clearTimeout(focusNoticeTimer);
  if (kind !== 'done') return;
  if (greeting && greeting.isConnected && messages.children.length === 1) greeting.remove();
  addMessage(`Time's up. You stayed focused for ${LeftyFocus.timeLeft(minutes * 60000)}. Time for a break.`, 'lefty');
  focusNoticeTimer = setTimeout(() => { if (!input.value && !job && !listening) api.requestHide(); }, FOCUS_NOTICE_MS);
});
input.addEventListener('input', () => clearTimeout(focusNoticeTimer));

// Something that isn't the work came up: Lefty appears without his chat, glides to its close button and presses it,
// and the small dark tag beside him says why (main closes it as he presses). With his chat already open, the chat
// steps aside meanwhile.
let focusBlock = null; // { quiet }
api.onFocusBlock(({ quiet, app, left, rect, area, cursor }) => {
  if (job || picking) return; // busy with the user's own goal: main still closes it, quietly
  focusBlock = { quiet };
  if (quiet) {
    screenArea = area;
    stopPointing();
    leftyEl.classList.remove('glide');
    place(cursor);
    leftyEl.classList.add('show');
    leftyEl.classList.remove('hide');
  } else {
    clearTimeout(focusNoticeTimer);
    tuckBubble(true);
  }
  const line = BLOCKED_LINES[Math.floor(Math.random() * BLOCKED_LINES.length)];
  const say = `${line} ${LeftyFocus.timeLeft(left)} left.`;
  requestAnimationFrame(() => {
    if (rect) pointAt({ rect });
    stepTag.classList.add('wrap');
    setStepTag('', say);
    speak(line);
    if (rect) setTimeout(() => { playBody('press'); ring.classList.add('hit'); }, 650);
  });
  api.log(`focus: showed Lefty closing ${app || 'an app'}`);
});

api.onFocusBlockEnd(({ quiet }) => {
  if (!focusBlock) return;
  focusBlock = null;
  stopPointing();
  stepTag.classList.remove('wrap');
  if (quiet) {
    leftyEl.classList.remove('show');
    leftyEl.classList.add('hide');
  } else {
    tuckBubble(false);
  }
});

/* ---------- Building a project ----------
   "Build me a portfolio website": Lefty asks which folder (a new one under Documents\Lefty Projects, typed, or
   picked with Browse), the AI writes the files and main saves them there. A change to what he just built ("add a
   contact page", "make it dark") offers the same folder, so the AI changes that project; anything else is a new
   project in a new folder, with a button to update the last one instead. */
let lastProject = '';

// A short name for the project's folder, from what to build: "a portfolio website for me" -> "portfolio website".
const projectName = (request) => String(request || '').toLowerCase().replace(/[^a-z0-9\s-]/g, ' ')
  .split(/\s+/).filter((w) => w.length > 2 && !/^(build|make|create|write|code|please|for|the|and|with|that|this|simple|new|using|want|need|can|you|lefty)$/.test(w))
  .slice(0, 3).join(' ');

// "add a contact page", "make it dark", "fix the menu": a change to the project Lefty just built, not a new one.
const CHANGE_WORDS = /^(?:please\s+|now\s+|can you\s+)*(?:add|change|update|edit|fix|improve|remove|delete|rename|replace|move|also|make\s+(?:it|the|this|that|them))\b|\b(?:the site|the website|the page|the app|the game|the project|my project)\b/i;

async function startBuild(decision) {
  const request = decision.request;
  const goal = String((job && job.goal) || request).trim(); // the user's own words (cancelJob forgets them)
  cancelJob();
  stopPointing();
  tuckBubble(false);
  const change = Boolean(lastProject) && CHANGE_WORDS.test(goal) && !/\b(?:new|another|fresh|separate)\b/i.test(goal);
  const fresh = await api.suggestFolder(projectName(request));
  const el = addMessage(change
    ? "I'll change the project I built last time. Is this the right folder?"
    : "I'll build it as a new project and write the files myself. Which folder should I use?", 'lefty');
  askInMessage(el, {
    value: change ? lastProject : fresh, placeholder: 'C:\\Users\\you\\Documents\\my-project', label: 'Project folder', button: 'Build',
    extras: [
      { label: 'Browse…', title: 'Pick a folder', pick: async (box) => { const picked = await api.pickFolder(box.value); if (picked.ok) box.value = picked.folder; api.focusSelf(); box.focus(); } },
    ],
    onSubmit: (chosen) => runBuild(chosen, request),
  });
}

async function runBuild(folder, request) {
  addMessage('Building… a whole project takes a minute or two.', 'lefty');
  const typing = showTyping();
  api.log('build: started');
  const result = await api.buildProject({ folder, request, lang: lastLang });
  typing.remove();
  if (!result.ok) {
    api.log(`build: failed (${result.error})`);
    addMessage(result.error === 'no-brain' ? `The AI isn't connected yet. ${NO_KEY_HINT}` : `${result.error}`, 'lefty');
    return;
  }
  lastProject = result.folder;
  if (chat.ready) chat.ready.then((id) => { if (id) api.chatProject({ chatId: id, folder: result.folder }); });
  api.log(`build: ${result.files.length} file(s), ${result.changed} replaced`);
  const n = result.files.length;
  const lines = [
    result.summary || 'Done.',
    `${n} file${n === 1 ? '' : 's'} in ${result.folder}${result.changed ? ` (${result.changed} changed; the old ones are in .lefty-backup)` : ''}`,
    result.run ? `To run it: ${result.run}` : '',
    'Tell me what to change and I\'ll update it.',
  ].filter(Boolean);
  const choices = [{ label: 'Open in VS Code', primary: true, pick: () => api.openProject({ folder: result.folder, how: 'code' }) }];
  if (result.hasIndex) choices.push({ label: 'Open in browser', pick: () => api.openProject({ folder: result.folder, how: 'browser' }) });
  choices.push({ label: 'Show folder', pick: () => api.openProject({ folder: result.folder, how: 'folder' }) });
  addChoices(lines.join('\n'), choices);
}

/* ---------- Voice ----------
   Hold Ctrl+Space (main says when it goes down and comes up), or click the microphone: Lefty records while he
   listens, turns it into a small WAV file and sends it to the brain as the goal, and he gets to work. It goes when the
   keys come up, when the microphone is clicked again, or by itself once the user stops talking. Nothing is recorded
   until then, and typing always works, microphone or not. */
const MAX_LISTEN_MS = 30000;
const MIN_LISTEN_MS = 400;
const QUIET_AFTER_CLICK_MS = 1500; // the microphone button: this much quiet after talking sends it
const QUIET_WHILE_HELD_MS = 2500;  // holding the keys: a longer pause, since letting go sends it anyway
const LEVEL_EVERY_MS = 100;
let listening = null; // { stream, recorder, chunks, startedAt, timer, note, held, meter }

function setListening(on, text) {
  micButton.classList.toggle('listening', on);
  leftyEl.classList.toggle('listening', on);
  if (listening && listening.note && listening.note.isConnected && text) listening.note.textContent = text;
}

async function startListening({ held = false } = {}) {
  if (listening || !leftyEl.classList.contains('show')) return;
  const state = { chunks: [], startedAt: Date.now(), stream: null, recorder: null, timer: null, note: null, held, meter: null };
  listening = state;
  tuckBubble(false);
  state.note = addMessage('One moment…', 'lefty', { say: false });
  state.note.classList.add('listening-msg');
  setListening(true);
  hush(); // Lefty mustn't hear himself
  if (!(await api.brainReady())) {
    endListening(state);
    addMessage(`I need the AI connected to understand speech. ${NO_KEY_HINT}`, 'lefty');
    return;
  }
  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw Object.assign(new Error('no media devices'), { name: 'NotFoundError' });
    state.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  } catch (error) {
    endListening(state);
    api.log(`voice: no microphone (${error.name})`);
    addMessage(error.name === 'NotAllowedError'
      ? "Windows didn't let me use the microphone. Turn it on in Settings > Privacy & security > Microphone, or type instead."
      : "I can't find a microphone. You can type your goal instead.", 'lefty');
    return;
  }
  if (listening !== state) { // let go before the microphone was ready: nothing was heard yet
    state.stream.getTracks().forEach((t) => t.stop());
    if (state.letGo) addMessage('Keep holding Ctrl+Space a moment longer, and start talking when I say “Listening”.', 'lefty');
    return;
  }
  state.recorder = new MediaRecorder(state.stream);
  state.recorder.ondataavailable = (event) => { if (event.data && event.data.size) state.chunks.push(event.data); };
  state.stopped = new Promise((resolve) => { state.recorder.onstop = resolve; });
  state.recorder.start(250);
  state.startedAt = Date.now();
  state.timer = setTimeout(() => stopListening(true), MAX_LISTEN_MS);
  watchForQuiet(state);
  setListening(true, held ? "Listening… let go when you're done" : "Listening… I'll go when you stop talking");
  api.log('voice: listening');
}

// Lefty sends it himself once the user has spoken and then gone quiet.
function watchForQuiet(state) {
  try {
    const context = new AudioContext();
    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    context.createMediaStreamSource(state.stream).connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    const ear = LeftyVoice.endOfSpeech({ quietMs: state.held ? QUIET_WHILE_HELD_MS : QUIET_AFTER_CLICK_MS });
    const timer = setInterval(() => {
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const v of samples) sum += v * v;
      if (ear.hear(Math.sqrt(sum / samples.length), Date.now()) && listening === state) {
        api.log('voice: quiet after talking, sending');
        stopListening(true);
      }
    }, LEVEL_EVERY_MS);
    state.meter = { context, timer };
  } catch { /* no meter: the keys or the button still send it */ }
}

function endListening(state) {
  if (listening === state) listening = null;
  clearTimeout(state.timer);
  if (state.meter) { clearInterval(state.meter.timer); state.meter.context.close().catch(() => {}); state.meter = null; }
  setListening(false);
  if (state.note && state.note.isConnected) state.note.remove();
}

async function stopListening(send) {
  const state = listening;
  if (!state) return;
  endListening(state);
  if (!state.recorder) { state.letGo = send; return; } // the microphone wasn't open yet: startListening lets it go
  if (state.recorder.state !== 'inactive') state.recorder.stop();
  await state.stopped;
  state.stream.getTracks().forEach((t) => t.stop());
  if (!send) { api.log('voice: cancelled'); return; }
  if (Date.now() - state.startedAt < MIN_LISTEN_MS || !state.chunks.length) {
    addMessage("I didn't catch that. Hold Ctrl+Space (or click) while you talk.", 'lefty');
    return;
  }
  let audio;
  try {
    const blob = new Blob(state.chunks, { type: state.recorder.mimeType || 'audio/webm' });
    const context = new AudioContext();
    const sound = await context.decodeAudioData(await blob.arrayBuffer());
    context.close();
    const channels = Array.from({ length: sound.numberOfChannels }, (_, c) => sound.getChannelData(c));
    if (!LeftyVoice.heardSomething(channels[0], sound.sampleRate)) {
      api.log('voice: only silence');
      addMessage("I couldn't hear anything. Is your microphone on and close enough?", 'lefty');
      return;
    }
    audio = { mime: 'audio/wav', data: LeftyVoice.base64(LeftyVoice.toWav(channels, sound.sampleRate)) };
    api.log(`voice: ${sound.duration.toFixed(1)} s recorded`);
  } catch (error) {
    api.log(`voice: could not read the recording (${error.message})`);
    addMessage('Something went wrong with the recording. Try again, or type instead.', 'lefty');
    return;
  }
  askVoice(audio);
}

micButton.addEventListener('click', () => { if (listening) stopListening(true); else startListening(); });
api.onVoiceHold(({ on }) => { if (on) startListening({ held: true }); else stopListening(true); });

// Only catch the mouse while it's over Lefty, the bubble or the chip; everywhere else clicks reach the app below.
// Main watches the mouse against these rects (global DIPs); they're re-measured often, since the bubble glides.
const REGIONS_EVERY_MS = 100;
let lastRegions = '';
function reportRegions() {
  const rects = [];
  const add = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width && r.height) rects.push({ x: r.left + screenArea.originX, y: r.top + screenArea.originY, w: r.width, h: r.height });
  };
  // The chat has no panel: only its bubbles take clicks, and the gaps between them let clicks through to the app.
  if (bubble.classList.contains('show') && !bubble.classList.contains('tucked')) {
    for (const el of [bubble.querySelector('.bubble-head'), ...messages.children, form, ...bubble.querySelectorAll('.chips button')]) if (el) add(el);
  }
  if (leftyEl.classList.contains('show') && !leftyEl.classList.contains('pointing')) add(leftyEl); // never while on a target
  if (modeChip.classList.contains('show')) add(modeChip);
  const key = JSON.stringify(rects.map((r) => [r.x, r.y, r.w, r.h].map(Math.round)));
  if (key === lastRegions) return;
  lastRegions = key;
  api.setRegions(rects);
}
setInterval(reportRegions, REGIONS_EVERY_MS);

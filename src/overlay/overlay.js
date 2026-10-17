// Lefty's on-screen body: appears next to the mouse when the shortcut is pressed.
// He reads the app you're in and points at the button you name. No AI brain yet: anything
// he can't find on screen gets a placeholder reply.

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
  ring.classList.remove('show', 'hit');
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

function showTyping() {
  const el = document.createElement('div');
  el.className = 'msg lefty-msg typing';
  el.append(document.createElement('i'), document.createElement('i'), document.createElement('i'));
  messages.append(el);
  return el;
}

/* ---------- Guiding: plan -> find -> point -> check the click -> next step ----------
   The steps come from what the user typed ("File > Save as"); later the AI brain writes them.
   After each finished step Lefty looks at the screen again, because the step itself changes it. */

// Menus and dialogs take a moment to appear after a click, so Lefty looks a few times before giving up.
const LOOK_AGAIN_DELAYS_MS = [150, 250, 400, 600, 800, 1000];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let plan = null;        // { steps: [...], index, target, hinted }
let planToken = 0;      // bumped whenever the plan changes, so older async work stops quietly
let checkingMiss = false;

function cancelPlan() {
  plan = null;
  planToken += 1;
  checkingMiss = false;
}

function reset() {
  cancelPlan();
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
  cancelPlan();
  stopPointing();
  addMessage(message, 'lefty');
  tuckBubble(false);
}

function point(target) {
  if (!isOnScreen(target.rect)) {
    stopGuide(`Found "${target.name}", but it's on your other screen. 👀`);
    return;
  }
  plan.target = target;
  pointAt(target);
  setStepTag(plan.steps.length > 1 ? `${plan.index + 1}/${plan.steps.length}` : '', target.name || target.type);
  api.setTarget(target.rect);
  api.log(`step ${plan.index + 1}/${plan.steps.length}: pointing at ${target.type} "${target.name}" (${Math.round(target.rect.x)},${Math.round(target.rect.y)} ${Math.round(target.rect.w)}x${Math.round(target.rect.h)})`);
}

// Looks at the screen again until `step` shows up. Returns { target }, {} when it never appears, or { cancelled }.
async function lookFor(steps, token) {
  for (const delay of LOOK_AGAIN_DELAYS_MS) {
    await sleep(delay);
    if (token !== planToken) return { cancelled: true };
    const seen = await api.rescan();
    rememberSeen(seen);
    if (token !== planToken) return { cancelled: true };
    if (!seen.ok) continue;
    for (const [offset, step] of steps.entries()) {
      const target = LeftyMatch.findTarget(step, seen.elements);
      if (target) return { target, offset };
    }
  }
  return {};
}

async function ask(goal) {
  addMessage(goal, 'user');
  input.value = '';
  cancelPlan();
  stopPointing();
  tuckBubble(false); // replies show in the chat; it tucks away again only if a guide starts
  const token = planToken;

  if (LeftyMatch.isStuck(goal)) {
    addMessage("Once my brain is connected, I'll read your screen and show you the next step. 🧠 For now, name a button, or a path like File > Save as.", 'lefty');
    return;
  }
  const steps = LeftyMatch.parsePlan(goal);
  if (!steps.length) return;

  const typing = showTyping();
  const seen = await contextReady;
  typing.remove();
  if (token !== planToken) return; // Lefty was closed or asked something else meanwhile

  if (!seen.ok) {
    addMessage("I couldn't read this app's buttons, sorry. 😕 Try clicking into the app and calling me again.", 'lefty');
    return;
  }
  const target = LeftyMatch.findTarget(steps[0], seen.elements);
  if (!target) {
    addMessage(steps.length === 1
      ? `I can't spot "${goal}" on this screen. Once my brain is connected, I'll plan every step for you. 🧠`
      : `I can't spot "${steps[0]}" on this screen. 🤔`, 'lefty');
    return;
  }
  plan = { steps, index: 0, target: null, hinted: false };
  point(target);
  if (!plan) return;
  tuckBubble(true);
  api.focusApp(); // the next move is a click in the app: many apps ignore the first click while inactive
}

function finish() {
  api.log(`goal finished: ${plan.steps.join(' > ')}`);
  cancelPlan();
  api.setTarget(null);
  setStepTag('', '🎉 Done!', { done: true });
  const token = planToken;
  setTimeout(() => { // let the green ring and tag show first, then the chat comes back for the next goal
    if (token !== planToken) return;
    stopPointing();
    addMessage('🎉 Done! You did it. What next?', 'lefty');
    tuckBubble(false);
  }, 1200);
}

async function onStepDone() {
  ring.classList.add('hit');
  api.setTarget(null);
  plan.index += 1;
  if (plan.index >= plan.steps.length) { finish(); return; }

  checkingMiss = false;
  planToken += 1; // a click on the target wins over any look-again still running from a miss
  const token = planToken;
  const found = await lookFor([plan.steps[plan.index]], token);
  if (found.cancelled) return;
  if (found.target) { point(found.target); return; }
  stopGuide(`✅ Nice! But I can't see "${plan.steps[plan.index]}" yet. Call me again when it's on screen.`);
}

// A click somewhere else: the screen may have changed, or the user did the step another way (a shortcut key).
async function onMissedClick() {
  if (checkingMiss) return;
  checkingMiss = true;
  const token = planToken;
  const remaining = plan.steps.slice(plan.index, plan.index + 2); // this step, then the next one
  const found = await lookFor(remaining, token);
  if (found.cancelled) return;
  checkingMiss = false;

  if (!found.target) {
    stopGuide(`I lost sight of "${plan.steps[plan.index]}". Call me again when it's on screen. 👀`);
    return;
  }
  if (found.offset === 1) { // the current step got done without clicking it: move on
    plan.index += 1;
    point(found.target);
    return;
  }
  // Still the same step: follow it if it moved, and wiggle the tag once to catch the user's eye.
  const moved = !sameRect(found.target.rect, plan.target.rect);
  if (moved) point(found.target);
  if (moved || !plan.hinted) {
    plan.hinted = true;
    nudgeStepTag();
  }
}

api.onClick(({ hit, free }) => {
  if (free) { refreshSeenSoon(); return; } // not pointing at anything: just keep the guard's picture of the screen fresh
  if (!plan) return;
  if (hit) onStepDone();
  else onMissedClick();
});

/* ---------- Click guard ----------
   While Lefty is on screen, resting the mouse on a button that throws work away ("Delete", "Don't Save",
   "Empty Recycle Bin") flags it before the click. It uses the latest screen read, so it costs no extra
   work per mouse move; the read is refreshed after the user's clicks, since clicks change the screen. */
const GUARD_REST_MS = 250;
const GUARD_PAD = 3;
const guardRing = document.getElementById('guard-ring');
const guardTag = document.getElementById('guard-tag');
let lastSeen = [];       // elements of the latest screen read
let guarded = null;      // the element currently flagged
let guardTimer = null;
let refreshTimer = null;

function rememberSeen(seen) {
  if (seen && seen.ok) lastSeen = seen.elements;
}

function refreshSeenSoon() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => rememberSeen(await api.rescan()), 500);
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
  api.log(`guard: "${element.name}" (${risk.level})`);
}

function checkGuard(point) {
  const element = LeftyGuard.elementAt(point, lastSeen);
  const risk = element && LeftyGuard.riskOf(element);
  if (!risk) { hideGuard(); return; }
  if (guarded === element) return;
  showGuard(element, risk);
}

// The overlay ignores clicks but still receives mouse moves over the whole screen.
document.addEventListener('mousemove', (event) => {
  clearTimeout(guardTimer);
  if (!leftyEl.classList.contains('show')) return;
  if (bubble.contains(event.target) && !bubble.classList.contains('tucked')) { hideGuard(); return; } // over Lefty's own chat
  const point = { x: event.clientX + screenArea.originX, y: event.clientY + screenArea.originY };
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
  }
  resolveContext(seen);
});

api.onHide(() => {
  cancelPlan();
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

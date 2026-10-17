// Lefty's on-screen body: appears next to the mouse when the shortcut is pressed.
// He reads the app you're in and points at the button you name. No AI brain yet: anything
// he can't find on screen gets a placeholder reply.

const api = window.lefty;
// Not named `lefty`: that name is taken by the window.lefty bridge from preload.js.
const leftyEl = document.getElementById('lefty');
const bubble = document.getElementById('bubble');
const ring = document.getElementById('ring');
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

// Lefty's tip lands inside the target; the bubble goes wherever it covers neither the target nor Lefty.
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
  ring.classList.remove('show');
  void ring.offsetWidth; // replay the entrance when pointing at a new target
  ring.classList.add('show');

  const tipX = r.x + Math.min(r.w * 0.65, r.w - 4);
  const tipY = r.y + Math.min(r.h * 0.65, r.h - 4);
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
  ring.classList.remove('show');
  leftyEl.classList.remove('glide', 'pointing');
  bubble.classList.remove('glide');
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

function reset() {
  stopPointing();
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

async function ask(goal) {
  addMessage(goal, 'user');
  input.value = '';
  const seq = currentSeq;
  const typing = showTyping();
  const seen = await contextReady;
  if (seq !== currentSeq) return; // Lefty was closed and summoned again meanwhile
  typing.remove();

  if (!seen.ok) {
    addMessage("I couldn't read this app's buttons, sorry. 😕 Try clicking into the app and calling me again.", 'lefty');
    return;
  }
  const target = LeftyMatch.findTarget(goal, seen.elements);
  if (!target) {
    stopPointing();
    addMessage(`I can't spot "${goal}" on this screen. Once my brain is connected, I'll plan every step for you. 🧠`, 'lefty');
    return;
  }
  if (!isOnScreen(target.rect)) {
    addMessage(`Found "${target.name}", but it's on your other screen. 👀`, 'lefty');
    return;
  }
  addMessage(`Here it is! 👉 ${target.name}`, 'lefty');
  pointAt(target);
  api.log(`pointing at ${target.type} "${target.name}" (${Math.round(target.rect.x)},${Math.round(target.rect.y)} ${Math.round(target.rect.w)}x${Math.round(target.rect.h)})`);
}

function setVisible(visible) {
  for (const el of [leftyEl, bubble]) {
    el.classList.toggle('show', visible);
    el.classList.toggle('hide', !visible);
  }
  if (!visible) ring.classList.remove('show');
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
  if (seen.ok && greeting && greeting.isConnected) {
    greeting.textContent = `👋 Hi! I can see ${seen.app}. What's your goal?`;
  }
  resolveContext(seen);
});

api.onHide(() => setVisible(false));

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

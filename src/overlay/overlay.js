// Lefty's on-screen body: appears next to the mouse when the shortcut is pressed.
// No backend yet, so Lefty only acknowledges goals instead of guiding.

const api = window.lefty;
// Not named `lefty`: that name is taken by the window.lefty bridge from preload.js.
const leftyEl = document.getElementById('lefty');
const bubble = document.getElementById('bubble');
const messages = document.getElementById('messages');
const form = document.getElementById('ask');
const input = document.getElementById('goal');

const LEFTY_WIDTH = 64;
const LEFTY_HEIGHT = 90;
const BUBBLE_WIDTH = 320;
const GAP = 14;
const MAX_MESSAGES = 4;

function place({ x, y, width, height }) {
  // Sit just below-right of the real mouse pointer so it isn't covered.
  const leftyX = Math.min(x + 12, width - LEFTY_WIDTH - GAP);
  const leftyY = Math.min(y + 12, height - LEFTY_HEIGHT - GAP);
  leftyEl.style.left = `${leftyX}px`;
  leftyEl.style.top = `${leftyY}px`;

  // Bubble goes to the right of Lefty, or flips left near the screen edge.
  const fitsRight = leftyX + LEFTY_WIDTH + GAP + BUBBLE_WIDTH < width - GAP;
  const bubbleX = fitsRight ? leftyX + LEFTY_WIDTH + GAP : Math.max(GAP, leftyX - BUBBLE_WIDTH - GAP);
  const bubbleHeight = bubble.offsetHeight || 230;
  const bubbleY = Math.max(GAP, Math.min(leftyY - 10, height - bubbleHeight - GAP));
  bubble.style.left = `${bubbleX}px`;
  bubble.style.top = `${bubbleY}px`;
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
  messages.replaceChildren();
  addMessage("👋 Hi! What's your goal?", 'lefty');
  input.value = '';
}

function ask(goal) {
  addMessage(goal, 'user');
  input.value = '';
  const typing = showTyping();
  setTimeout(() => { // stands in for the future AI call
    typing.remove();
    addMessage(`Got it! Once my brain is connected, I'll point you to every step for "${goal}". 🧠`, 'lefty');
  }, 900);
}

function setVisible(visible) {
  for (const el of [leftyEl, bubble]) {
    el.classList.toggle('show', visible);
    el.classList.toggle('hide', !visible);
  }
}

api.onShow((position) => {
  reset();
  place(position);
  setVisible(true);
  setTimeout(() => input.focus(), 60);
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

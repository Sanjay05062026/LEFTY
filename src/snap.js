// Making the AI's pointing land on real things. The AI sometimes guesses a spot on the screenshot even when the
// button is in the list Windows gave us (Paint's "Red" colour, ~800 px off), or picks a real but wrong element
// (VS Code's top "Search files by name" bar for "Click Search Extensions"). Windows knows every button's name and
// exact place, so the step's own words are matched against those names:
//   - a step pointed from the screenshot snaps to the element whose name fits the step ("Red" for "Click the red
//     color"), or else to the element the guess landed inside;
//   - a picked element whose name has nothing to do with the step gives way to one whose name fits it fully.
// Some boxes are hidden from Windows altogether: VS Code's Extensions search box is an editor that reports nothing,
// but the "Clear Extensions Search Results" button sits at its right end, so the box is added from that.
// Pure functions: used by the main process (screen reads) and the brain, and by Node tests.

const STOP_WORDS = new Set([
  'click', 'tap', 'press', 'select', 'choose', 'pick', 'open', 'go', 'find', 'use', 'enter', 'hit', 'type', 'write',
  'the', 'a', 'an', 'on', 'in', 'at', 'to', 'into', 'of', 'for', 'and', 'or', 'with', 'from', 'your', 'this', 'that',
  'it', 'its', 'here', 'now', 'then', 'there', 'button', 'icon', 'tab', 'menu', 'item', 'option', 'box', 'field',
  'color', 'colour', 'link', 'area', 'bar', 'panel', 'section', 'ctrl', 'shift', 'alt', 'top', 'left', 'right',
]);
const INPUT_TYPES = new Set(['Edit', 'ComboBox']);
const BIG_AREA = 0.15; // a "container" covering this much of the screen is no target (a whole page, a canvas)

// Words of a name or step, lowercased, without keyboard hints in brackets: "Extensions (Ctrl+Shift+X)" -> extensions.
const words = (text) => String(text || '').toLowerCase().replace(/\([^)]*\)/g, ' ').match(/[a-z0-9]+/g) || [];

// What the step is about: its words minus filler and minus what is to be typed ("Type python" is about no element).
function keyWords(instruction, typed) {
  const skip = new Set(words(typed));
  return [...new Set(words(instruction).filter((w) => w.length > 1 && !STOP_WORDS.has(w) && !skip.has(w)))];
}

// 100+ when every word of the element's name is in the step ("Red" for "click the red color"), 50+ when every key
// word of the step is in the name ("Extensions (Ctrl+Shift+X) - 1 requires update" for "click extensions"; 60+ when
// the name starts with it), else 0.
function fitScore(element, keys) {
  const name = [...new Set(words(element.name).filter((w) => !STOP_WORDS.has(w)))];
  if (!name.length || !keys.length) return 0;
  const shared = keys.filter((k) => name.includes(k)).length;
  if (!shared) return 0;
  if (name.every((w) => keys.includes(w))) return 100 + name.length;
  // A name that starts with the step's word is that thing ("Extensions (Ctrl+Shift+X)"); one that only mentions it
  // is something about it ("Filter Extensions...").
  if (shared === keys.length) return 50 + shared + (keys.includes(name[0]) ? 10 : 0);
  return 0;
}

const centre = (rect) => ({ x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 });
const distance = (a, b) => Math.hypot(centre(a).x - centre(b).x, centre(a).y - centre(b).y);
const asTarget = (el, from) => ({ name: el.name, type: el.type, rect: el.rect, snappedFrom: from });

// target: { name, type, rect } as the AI chose it (type "Spot" = a guessed point), or null.
// screen: { w, h } of the display, to skip huge containers. Returns the target to point at.
function snapTarget(target, { instruction, text, action, elements, screen }) {
  if (!target || !target.rect) return target;
  const keys = keyWords(instruction, text);
  const area = screen ? screen.w * screen.h : Infinity;
  const pool = elements.filter((el) => el.rect && el.rect.w * el.rect.h < area * BIG_AREA && (action !== 'type' || INPUT_TYPES.has(el.type)));
  let best = null;
  let bestScore = 0;
  let ambiguous = false; // two different things fit equally ("Install on Python": an Install button, the Python tab)
  for (const el of pool) {
    const score = fitScore(el, keys);
    if (!score || score < bestScore) continue;
    if (score > bestScore) {
      best = el;
      bestScore = score;
      ambiguous = false;
    } else if (String(el.name).toLowerCase() !== String(best.name).toLowerCase()) {
      ambiguous = true;
    } else if (distance(el.rect, target.rect) < distance(best.rect, target.rect)) {
      best = el; // the same thing several times (Install buttons): the one nearest the AI's choice
    }
  }
  const guessed = target.type === 'Spot';
  const current = guessed ? 0 : fitScore(target, keys);
  if (best && !ambiguous && bestScore > current && (guessed || current === 0)) return asTarget(best, guessed ? 'a guessed spot' : `${target.type} "${target.name}"`);
  // No name fits. A step that names nothing ("Click here") takes the smallest element the guess landed inside; one
  // that names something ("Pick red") does not: landing on another thing (Paint's pinkish Opacity slider) is a miss.
  if (guessed && !keys.length) {
    const point = centre(target.rect);
    const inside = pool.filter((el) => point.x >= el.rect.x && point.x <= el.rect.x + el.rect.w && point.y >= el.rect.y && point.y <= el.rect.y + el.rect.h);
    if (inside.length) return asTarget(inside.reduce((a, b) => (a.rect.w * a.rect.h <= b.rect.w * b.rect.h ? a : b)), 'a guessed spot');
  }
  return target;
}

// Search boxes Windows can't see, worked out from the "Clear ... Search Results" button at their right end. The box
// runs from the left edge of the panel (the row right below it that reaches across to the button, so not the icon
// bar beside the panel) to that button.
function addHiddenBoxes(elements) {
  const added = [];
  for (const el of elements) {
    const m = el.type === 'Button' && el.rect && /^clear (.+?) search(?: results)?$/i.exec(String(el.name || '').trim());
    if (!m) continue;
    const r = el.rect;
    const sameRow = (o) => Math.abs(centre(o.rect).y - centre(r).y) < r.h;
    if (elements.some((o) => o.rect && INPUT_TYPES.has(o.type) && sameRow(o) && o.rect.x < r.x && o.rect.x + o.rect.w > r.x - 80)) continue; // Windows sees a box there
    const below = elements.filter((o) => o !== el && o.rect && o.rect.y > r.y && o.rect.y < r.y + 300
      && o.rect.x < r.x && o.rect.x > r.x - 500 && o.rect.x + o.rect.w > r.x - 20);
    const nearest = below.length ? below.reduce((a, b) => (b.rect.y < a.rect.y ? b : a)) : null; // the row right under the box
    const left = nearest ? nearest.rect.x : r.x - 200;
    added.push({ name: `Search ${m[1]}`, type: 'Edit', enabled: true, rect: { x: left, y: r.y - 2, w: Math.max(40, r.x - left - 4), h: r.h + 4 }, guessed: true });
  }
  return added.length ? [...elements, ...added] : elements;
}

module.exports = { snapTarget, addHiddenBoxes, keyWords, fitScore };

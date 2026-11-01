// Checks Do it mode's decisions: what Lefty does himself, what he asks about first, and what stays the user's.
// Also checks the settings file. Run: npm run test:auto

const fs = require('fs');
const os = require('os');
const path = require('path');
const { plan, needsOk, isPrivateBox, keysFor } = require('../src/overlay/auto');
const { createSettings, DEFAULTS } = require('../src/settings');

let failed = 0;
function check(condition, message) {
  if (!condition) failed += 1;
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${message}`);
}

const r = (x, y, w, h) => ({ x, y, w, h });
const el = (name, type = 'Button') => ({ name, type, rect: r(100, 100, 80, 30), enabled: true });
const step = (extra) => ({ id: 'ai:0', kind: 'click', label: 'Click it 👆', ...extra });

// --- plain clicks ---
let p = plan(step({ target: el('Scientific', 'ListItem'), label: 'Pick Scientific 🧪' }));
check(p.act === 'click' && p.button === 'left' && p.count === 1 && !p.ask, 'a harmless click: Lefty clicks it, no question');
p = plan(step({ target: el('Bold'), action: 'double_click' }));
check(p.act === 'click' && p.count === 2, 'double_click: two clicks');
p = plan(step({ target: el('Desktop', 'ListItem'), action: 'right_click' }));
check(p.act === 'click' && p.button === 'right', 'right_click: the right button');
p = plan(step({ target: el('File', 'MenuItem'), label: 'File' }));
check(p.act === 'click' && !p.ask, 'a path step (File): clicked');
p = plan(step({ target: el('Save as', 'MenuItem'), label: 'Save as' }));
check(p.act === 'click' && !p.ask, 'Save as is not risky');
p = plan(step({ target: { name: 'Click the red colour', type: 'Spot', rect: r(5, 5, 36, 36) }, label: 'Click the red colour 🎨' }));
check(p.act === 'click' && !p.ask, 'a guessed spot with a harmless step: clicked');
p = plan(step({ target: el('Results'), action: 'scroll', label: 'Scroll down ⬇️' }));
check(p.act === 'scroll' && p.notches < 0, 'scroll down: the wheel turns down');
p = plan(step({ target: el('Results'), action: 'scroll', label: 'Scroll up ⬆️' }));
check(p.act === 'scroll' && p.notches > 0, 'scroll up: the wheel turns up');

// --- only losing work is asked about; everything else Lefty just does ---
const risky = [
  ['Delete', 'Button'], ["Don't Save", 'Button'], ['Empty Recycle Bin', 'MenuItem'], ['Uninstall', 'Button'],
  ['Delete permanently', 'Button'], ['Discard changes', 'Button'], ['Reset settings', 'Button'],
];
for (const [name, type] of risky) {
  p = plan(step({ target: el(name, type), label: `Click ${name}` }));
  check(p.act === 'click' && Boolean(p.ask), `"${name}" is asked about first: ${p.ask}`);
}
// A task that stops to ask every other step is not doing the task. Lefty gets on with all of these.
const justDoIt = [
  ['Buy now', 'Button'], ['Place order', 'Button'], ['Send', 'Button'], ['Install', 'Button'], ['Submit', 'Button'],
  ['Sign out', 'MenuItem'], ['Download', 'Button'], ['Accept all', 'Button'], ['Pay $12.00', 'Button'], ['Post', 'Button'],
  ['Cancel subscription', 'Button'], ['Restart now', 'Button'], ['Share', 'Button'], ['Subscribe', 'Button'],
  ['Confirm', 'Button'], ['Allow', 'Button'], ['Sign up', 'Button'],
];
for (const [name, type] of justDoIt) {
  p = plan(step({ target: el(name, type), label: `Click ${name}` }));
  check(p.act === 'click' && !p.ask, `"${name}" is just done, no question`);
}
p = plan(step({ target: { name: 'here', type: 'Spot', rect: r(5, 5, 36, 36) }, label: 'Click Buy now 🛒' }));
check(!p.ask, 'a guessed spot whose step says "Buy now" is clicked too');
p = plan(step({ target: el(''), label: 'Delete the file 🗑️' }));
check(Boolean(p.ask), 'an unnamed button whose step says "Delete" is still asked about');
const harmless = ['Undo delete', 'Cancel', 'Cancel download', 'Back', 'Keep', 'Reset zoom', 'Remove filter', 'Close', 'Save',
  'Open', 'Settings', 'Book1', 'Sort order', 'Bold', 'Insert', 'Scientific', 'Search Extensions', 'Clear search'];
for (const name of harmless) {
  p = plan(step({ target: el(name), label: `Click ${name}` }));
  check(p.act === 'click' && !p.ask, `"${name}" needs no question`);
}

p = plan(step({ target: { ...el('Close'), titleBar: true }, label: 'Close the tab ❌' }));
check(p.act === 'click' && /whole window/.test(p.ask || ''), `the window's own Close button is asked about first: ${p.ask}`);
p = plan(step({ target: { ...el('Close Calculator'), titleBar: true }, label: 'Close it' }));
check(p.act === 'click' && /"Close Calculator" shuts the whole window/.test(p.ask || ''), `a Close button with the app's name in it is asked about too: ${p.ask}`);
p = plan(step({ target: { ...el('Minimize'), titleBar: true }, label: 'Minimize it' }));
check(p.act === 'click' && !p.ask, 'its Minimize button is not');

// --- typing ---
p = plan({ id: 'ai:1', kind: 'type', label: 'Search for Python 🔎', target: el('Search Extensions', 'Edit'), action: 'type', text: 'python' });
check(p.act === 'type' && p.text === 'python' && p.click && !p.ask, 'a typing step with its text: Lefty clicks the box and types it');
p = plan({ id: 'dialog:name', kind: 'type', label: 'Name it anything ✏️', target: el('File name:', 'Edit') });
check(p.yourTurn === 'choice', "the file's name is the user's choice: their turn");
p = plan({ id: 'ai:2', kind: 'type', label: 'Type your password 🔑', target: el('Password', 'Edit'), action: 'type', text: 'x' });
check(p.yourTurn === 'private', 'a password box is never typed into by Lefty');
p = plan({ id: 'ai:2', kind: 'type', label: 'Enter the card number 💳', target: el('', 'Edit'), action: 'type', text: '4111' });
check(p.yourTurn === 'private', 'a card number box stays the user\'s');
p = plan({ id: 'ai:2', kind: 'type', label: 'Type your PIN', target: el('PIN', 'Edit'), action: 'type', text: '1' });
check(p.yourTurn === 'private', 'a PIN box stays the user\'s');
p = plan({ id: 'ai:3', kind: 'type', label: 'Search forgot password', target: el('Search', 'Edit'), action: 'type', text: 'forgot password' });
check(p.yourTurn === 'private' || p.act === 'type', 'a search for "forgot password" never crashes the planner');
p = plan({ id: 'ai:4', kind: 'tell', label: 'Type hello 👋', action: 'type', text: 'hello' });
check(p.act === 'type' && !p.click, 'typing with nothing to click: typed where the keyboard is');
check(isPrivateBox(el('Confirm password', 'Edit'), '') && !isPrivateBox(el('Search', 'Edit'), 'Type python'), 'private boxes are spotted by name');

// --- keys ---
p = plan({ id: 'ai:5', kind: 'tell', label: 'Press Ctrl+B ⌨️', action: 'key', text: 'Ctrl+B' });
check(p.act === 'keys' && p.keys[0] === 'ctrl+b' && !p.ask, 'a shortcut step: Lefty presses Ctrl+B');
p = plan({ id: 'ai:5', kind: 'tell', label: 'Close the window', action: 'key', text: 'Alt+F4' });
check(p.act === 'keys' && Boolean(p.ask), 'Alt+F4 is asked about first');
p = plan({ id: 'ai:5', kind: 'tell', label: 'Delete it for good', action: 'key', text: 'Shift+Delete' });
check(Boolean(p.ask), 'Shift+Delete is asked about first');
p = plan({ id: 'ai:5', kind: 'tell', label: 'Press Enter to send ✉️', action: 'key', text: 'Enter' });
check(p.act === 'keys' && !p.ask, 'Enter that sends a message is just pressed: sending is not losing work');
p = plan({ id: 'ai:5', kind: 'tell', label: 'Press Enter ⏎', action: 'key', text: 'Enter' });
check(p.act === 'keys' && !p.ask, 'a plain Enter is just pressed');
p = plan({ id: 'ai:5', kind: 'tell', label: 'Use the magic key', action: 'key', text: 'Hyper+Q' });
check(p.yourTurn === 'nothing', "a key Lefty can't press stays the user's");
p = plan({ id: 'ai:6', kind: 'tell', label: 'Look at the top bar' });
check(p.yourTurn === 'nothing', 'a step with nothing to do or point at stays the user\'s');

const keyCases = [
  ['Ctrl+Shift+S', 'ctrl+shift+s'], ['ctrl + s', 'ctrl+s'], ['Ctrl++', 'ctrl+plus'], ['Ctrl+Plus', 'ctrl+plus'],
  ['Ctrl+-', 'ctrl+minus'], ['Ctrl+=', 'ctrl+='], ['Alt+F4', 'alt+f4'], ['Win+E', 'win+e'], ['Enter', 'enter'],
  ['Esc', 'escape'], ['F5', 'f5'], ['Ctrl+Alt+Del', 'ctrl+alt+delete'], ['Shift+Tab', 'shift+tab'], ['PgDn', 'pagedown'],
  ['Ctrl+,', 'ctrl+,'], ['Ctrl+`', 'ctrl+`'],
];
for (const [combo, want] of keyCases) check((keysFor(combo) || [])[0] === want, `keys: "${combo}" -> ${want} (${JSON.stringify(keysFor(combo))})`);
for (const bad of ['', 'Ctrl+', 'Ctrl+Shift', 'Hyper+Q', 'Ctrl+Space bar thing']) check(keysFor(bad) === null, `keys: "${bad}" can't be pressed`);

// --- guessed spots: only clicked when what's under them fits the step ---
const { spotOk } = require('../src/overlay/auto');

// An app that tells Windows nothing about itself (a JetBrains IDE, anything drawn in Java) reads as one big
// pane. Refusing to click there would hand back every single step, so the AI's own look at the screenshot wins.
const blindSpot = { name: 'here', type: 'Spot', rect: r(400, 300, 36, 36) };
const pane = { name: 'WelcomeScreen', type: 'Pane' };
check(!spotOk('Click main.py tab', pane), 'with a readable screen, a spot on an unrelated pane is refused');
check(spotOk('Click main.py tab', pane, true), "...but in an app Windows can't read, Lefty clicks it anyway");
check(spotOk('Click main.py tab', { name: 'main.py', type: 'Pane' }), 'a pane that does carry the name is fine either way');

check(!spotOk("Click Don't Save 🛑", { name: 'Text editor', type: 'Document' }), 'an imagined "Don\'t Save" over the text editor is not clicked');
check(spotOk("Click Don't Save 🛑", { name: "Don't save", type: 'Button' }), 'a real button under the guess is fine');
check(spotOk('Click the canvas', { name: 'Canvas', type: 'Pane' }), 'a canvas the step names is fine');
check(!spotOk('Draw a line ✏️', { name: 'Canvas', type: 'Pane' }), 'a drag-type step on a canvas is handed over (a click is not a drag)');
check(spotOk('Click here 👆', { name: 'Text editor', type: 'Document' }), '"Click here" names nothing: fine');
check(spotOk('Click the red colour', null), "couldn't look: the helper's own checks still apply");

// --- the rest ---
check(plan({ id: 'dialog:folder', kind: 'choose', label: 'Pick any folder 📁', target: { name: 'Folders', type: 'Area', rect: r(0, 0, 9, 9) } }).act === 'skip', '"Pick any folder": the folder the dialog shows is fine');
check(plan({ id: 'ai:7', kind: 'open', app: 'VS Code' }).act === 'open', 'opening an app: Lefty does it');
check(plan({ id: 'ai:8', kind: 'code', code: 'x = 1' }).act === 'code', 'code: Lefty writes it in');
check(plan({ id: 'ai:9', kind: 'doctor' }).act === 'doctor', 'the code doctor: Lefty fixes');
check(plan({ id: 'ai:10', kind: 'click', label: 'Click it' }).yourTurn === 'nothing', 'a click with nothing to click: the user\'s turn');
check(plan(null).yourTurn === 'nothing', 'no step: nothing to do');
check(needsOk(null, '') === null && needsOk(el('OK'), 'Click OK') === null, 'OK buttons need no question');

// --- settings file ---
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lefty-settings-'));
  const file = path.join(dir, 'settings.json');
  let settings = createSettings(file);
  check(JSON.stringify(settings.get()) === JSON.stringify(DEFAULTS), 'settings: Learn and normal size the first time');
  settings.set({ mode: 'auto', size: 'large', other: 'x' });
  settings = createSettings(file); // as after a restart
  check(settings.get().mode === 'auto' && settings.get().size === 'large' && !('other' in settings.get()), 'settings: saved and read back after a restart, unknown keys dropped');
  settings.set({ mode: 'robot', size: 'huge' });
  check(settings.get().mode === 'auto' && settings.get().size === 'large', 'settings: values that aren\'t allowed are ignored');
  fs.writeFileSync(file, '{ broken');
  check(createSettings(file).get().mode === 'learn', 'settings: a damaged file falls back to Learn');
  fs.writeFileSync(file, JSON.stringify({ mode: 'auto', size: 'gigantic' }));
  const mixed = createSettings(file).get();
  check(mixed.mode === 'auto' && mixed.size === 'normal', 'settings: a damaged value only resets that value');

  // Talking and private apps
  settings = createSettings(file);
  check(settings.get().speak === 'off' && settings.get().privateApps.length === 0, 'settings: Lefty is quiet and no app is private at first (nothing blocked without the user\'s choice)');
  settings.set({ speak: 'on', privateApps: ['KeePass.exe', ' keepass ', '1Password', 'my bank (beta)', '', '../../etc', '<script>', 42, null] });
  settings = createSettings(file);
  check(settings.get().speak === 'on', 'settings: "Lefty talks" is saved');
  check(JSON.stringify(settings.get().privateApps) === JSON.stringify(['keepass', '1password', 'my bank (beta)']), `settings: private apps are cleaned: lower case, no .exe, no doubles, no junk (${JSON.stringify(settings.get().privateApps)})`);
  check(settings.isPrivate('KeePass') && settings.isPrivate('keepass.exe') && !settings.isPrivate('notepad') && !settings.isPrivate('') && !settings.isPrivate(null), 'settings: "is this app private?" ignores case and .exe');
  settings.set({ privateApps: 'keepass' });
  check(settings.get().privateApps.length === 3, 'settings: a list that is not a list changes nothing');
  settings.set({ speak: 'loud', privateApps: Array.from({ length: 80 }, (_, i) => `app${i}`) });
  check(settings.get().speak === 'on' && settings.get().privateApps.length === 50, 'settings: a bad "talks" value is ignored, and the private list stops at 50');
  const copy = settings.get();
  copy.privateApps.push('sneaky');
  check(!settings.isPrivate('sneaky'), 'settings: changing a copy changes nothing saved');
  settings.set({ privateApps: [] });
  check(settings.get().privateApps.length === 0, 'settings: the private list can be emptied');
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll Do it checks passed.');
process.exit(failed ? 1 : 0);

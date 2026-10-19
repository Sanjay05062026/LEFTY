// Checks that the AI's pointing lands on real things (src/snap.js), using element lists read from real apps.
// Run: npm run test:snap

const { snapTarget, addHiddenBoxes, keyWords } = require('../src/snap');

let failed = 0;
function check(condition, message) {
  if (!condition) failed += 1;
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${message}`);
}

const el = (type, name, x, y, w, h) => ({ type, name, rect: { x, y, w, h } });
const spot = (name, x, y) => ({ type: 'Spot', name, rect: { x: x - 18, y: y - 18, w: 36, h: 36 } });
const screen = { w: 1920, h: 1080 };

// Paint with its toolbar shown (read with Lefty's eyes on Windows 11).
const paint = [
  el('MenuItem', 'File', 85, 77, 52, 40), el('Button', 'Hide toolbar', 508, 78, 155, 37), el('Button', 'Colour picker', 436, 184, 40, 40),
  el('RadioButton', 'Colour 1: Black', 944, 132, 45, 45), el('ListItem', 'Black', 997, 133, 30, 30), el('ListItem', 'Dark red', 1057, 133, 30, 30),
  el('ListItem', 'Red', 1087, 133, 30, 30), el('ListItem', 'Yellow', 1147, 133, 30, 30), el('ListItem', 'Light yellow', 1147, 163, 30, 30),
  el('Slider', 'Size', 100, 309, 41, 382), el('Document', 'Canvas', 0, 0, 1920, 1020),
];
let t = snapTarget(spot('Click the red color 🔴', 245, 299), { instruction: 'Click the red color 🔴', action: 'click', elements: paint, screen });
check(t.name === 'Red' && t.type === 'ListItem' && t.snappedFrom === 'a guessed spot', `a guessed spot far from "Red" snaps to the Red swatch (got ${t.type} "${t.name}")`);
t = snapTarget(spot('Pick dark red', 400, 400), { instruction: 'Pick dark red 🟥', action: 'click', elements: paint, screen });
check(t.name === 'Dark red', `"dark red" picks Dark red, not Red (got "${t.name}")`);
t = snapTarget(spot('Pick yellow', 1150, 170), { instruction: 'Choose yellow 🟡', action: 'click', elements: paint, screen });
check(t.name === 'Yellow', `"yellow" picks Yellow over Light yellow (got "${t.name}")`);
t = snapTarget(spot('Draw here', 800, 500), { instruction: 'Draw a line ✏️', action: 'click', elements: paint, screen });
check(t.type === 'Spot', 'a guess on the canvas with no fitting name stays a spot (the whole canvas is no target)');
t = snapTarget(spot('Click this', 1000, 146), { instruction: 'Click here 👆', action: 'click', elements: paint, screen });
check(t.name === 'Black', `a step that names nothing snaps to the small element the guess landed inside (got "${t.name}")`);
const hiddenToolbar = paint.filter((e) => e.type !== 'ListItem').concat([el('Slider', 'Opacity', 160, 307, 41, 384)]);
t = snapTarget(spot('Pick red color', 180, 400), { instruction: 'Pick red color 🔴', action: 'click', elements: hiddenToolbar, screen });
check(t.type === 'Spot', `"Pick red" with the colours hidden is not snapped onto the Opacity slider it landed on (got ${t.type} "${t.name}")`);

// VS Code with the Extensions panel open: the search box itself is invisible to Windows.
const vscode = [
  el('Button', 'Open Quick Access', 628, 8, 665, 28), el('Edit', 'Search files by name (append : to go to line or @ to go to symbol)', 475, 13, 588, 27),
  el('TabItem', 'Extensions (Ctrl+Shift+X) - 1 requires update', 9, 268, 46, 46), el('TabItem', 'Python', 9, 323, 46, 46),
  el('Button', 'Refresh', 270, 51, 28, 28), el('Button', 'Clear Extensions Search Results', 270, 92, 28, 28), el('Button', 'Filter Extensions...', 297, 92, 29, 28),
  el('Button', 'Installed Section', 66, 136, 265, 35), el('ListItem', 'SQL Server (mssql), 1.46.0', 66, 206, 265, 90), el('Button', 'Install', 267, 266, 51, 22),
  el('Document', 'Untitled-5 - python - Visual Studio Code', 0, 0, 1920, 1020),
];
const withBox = addHiddenBoxes(vscode);
const box = withBox.find((e) => e.name === 'Search Extensions');
check(box && box.type === 'Edit' && box.rect.x === 66 && box.rect.x + box.rect.w <= 270 && Math.abs(box.rect.y - 92) <= 2, `the hidden Extensions search box is added left of its Clear button (${box && JSON.stringify(box.rect)})`);
check(addHiddenBoxes(withBox.concat([el('Edit', 'Search', 66, 92, 200, 28)])).filter((e) => e.name === 'Search Extensions').length === 1, 'no box is added where Windows already sees one');
check(addHiddenBoxes(paint) === paint, 'apps without such buttons are left alone');

const searchFiles = withBox[1];
t = snapTarget(searchFiles, { instruction: 'Click Search Extensions 🔍', action: 'click', elements: withBox, screen });
check(t.name === 'Search Extensions', `"Search Extensions" picked on the top search bar moves to the Extensions box (got "${t.name}")`);
t = snapTarget(spot('Search Extensions', 160, 300), { instruction: 'Click Search Extensions 🔍', action: 'click', elements: withBox, screen });
check(t.name === 'Search Extensions', 'a guessed spot for it lands on the box too');
t = snapTarget(withBox.find((e) => e.name === 'Search Extensions'), { instruction: 'Type python 🔍', text: 'python', action: 'type', elements: withBox, screen });
check(t.name === 'Search Extensions', 'typing "python" into the box is not pulled to the "Python" tab');
t = snapTarget(spot('Click Extensions icon', 30, 200), { instruction: 'Click Extensions icon 🧩', action: 'click', elements: withBox, screen });
check(t.type === 'TabItem' && /^Extensions/.test(t.name), `"Extensions icon" snaps to the Extensions tab (got "${t.name}")`);
const install = withBox.find((e) => e.name === 'Install');
t = snapTarget(install, { instruction: 'Install Python extension ⬇️', action: 'click', elements: withBox, screen });
check(t === install, 'a pick that already fits the step is kept (Install, even with a "Python" tab around)');
t = snapTarget(spot('Click Install on Python', 40, 340), { instruction: 'Click Install on Python ⬇️', action: 'click', elements: withBox, screen });
check(t.type === 'Spot', `"Install on Python" fits an Install button and the Python tab equally: the guess is left alone (got ${t.type} "${t.name}")`);
const twoInstalls = withBox.concat([el('Button', 'Install', 267, 356, 51, 22)]);
t = snapTarget(spot('Click Install', 290, 360), { instruction: 'Click Install ⬇️', action: 'click', elements: twoInstalls, screen });
check(t.name === 'Install' && t.rect.y === 356, 'several buttons with the same name: the one nearest the guess');
const manage = el('Button', 'Manage', 9, 929, 46, 46);
t = snapTarget(manage, { instruction: 'Open the gear ⚙️', action: 'click', elements: withBox.concat([manage]), screen });
check(t === manage, 'a pick is never moved when no other name fits the step');

check(keyWords('Type python in the box ✏️', 'python').length === 0, 'what is to be typed is not what the step points at');
check(snapTarget(null, { instruction: 'x', elements: paint, screen }) === null, 'no target stays no target');

console.log(failed ? `\n${failed} check(s) failed` : '\nAll snap checks passed.');
process.exit(failed ? 1 : 0);

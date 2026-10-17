// Checks that Lefty picks the right element for what the user typed. Run: npm run test:match

const { findTarget, parsePlan, isStuck } = require('../src/overlay/match');

const el = (name, type = 'Button', enabled = true) => ({ name, type, enabled, rect: { x: 0, y: 0, w: 10, h: 10 } });
const screen = [
  el('Start'), el('Search'), el('Task View'), el('File Explorer pinned'),
  el('Save'), el('Save a copy'), el('Settings', 'MenuItem'), el('Close tab'), el('Close'),
  el('index.html', 'Document'), el('Run', 'Button', false), el('Run', 'MenuItem'),
  el('New File...', 'MenuItem'), el('Refactor', 'MenuItem'), el(''),
];

const cases = [
  ['start', 'Start'],
  ['click the Start button', 'Start'],
  ['where is search', 'Search'],
  ['open file explorer', 'File Explorer pinned'],
  ['save', 'Save'],
  ['sett', 'Settings'],
  ['close', 'Close'],
  ['run', 'Run', 'MenuItem'],          // enabled one wins over the greyed-out one
  ['new file', 'New File...'],
  ['REFACTOR', 'Refactor'],
  ['rename a file in pycharm', null],  // not on this screen: no wild guess
  ['xyz', null],
  ['', null],
  ['the', null],
];

let failed = 0;
for (const [goal, expectedName, expectedType] of cases) {
  const found = findTarget(goal, screen);
  const ok = expectedName === null
    ? found === null
    : found && found.name === expectedName && (!expectedType || found.type === expectedType);
  if (!ok) failed += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} "${goal}" -> ${found ? `${found.type} "${found.name}"` : 'nothing'}`);
}
const plans = [
  ['File > Save as', ['File', 'Save as']],
  ['click file then save as', ['click file', 'save as']],
  ['file -> edit → view', ['file', 'edit', 'view']],
  ['open settings and then privacy', ['open settings', 'privacy']],
  ['Create a JSON file', ['Create a JSON file']],
  ['Theme, then dark', ['Theme', 'dark']],
  ['view, and then zoom', ['view', 'zoom']],
  ['  save  ', ['save']],
  ['> >', []],
];
for (const [goal, expected] of plans) {
  const steps = parsePlan(goal);
  const ok = JSON.stringify(steps) === JSON.stringify(expected);
  if (!ok) failed += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} plan "${goal}" -> ${JSON.stringify(steps)}`);
}

const stuck = [["I'm stuck, what do I do next?", true], ['what next', true], ['help me', true], ['save', false], ['Create a JSON file', false]];
for (const [goal, expected] of stuck) {
  const ok = isStuck(goal) === expected;
  if (!ok) failed += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} stuck? "${goal}" -> ${isStuck(goal)}`);
}

console.log(failed ? `\n${failed} match checks failed.` : '\nAll match checks passed.');
process.exitCode = failed ? 1 : 0;

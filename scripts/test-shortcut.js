// Checks that holding Ctrl+Space toggles Lefty once, not on every key repeat.
// Run: npm run test:shortcut

const { createGate } = require('../src/shortcut-gate');

let failures = 0;
function check(condition, message) {
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${message}`);
  if (!condition) failures += 1;
}

let clock = 0;
const gate = createGate({ now: () => clock, idleMs: 1000 });
const press = () => gate.press();

check(press(), 'first press toggles');
let repeats = 0;
for (let i = 0; i < 60; i += 1) { clock += 33; if (press()) repeats += 1; } // two seconds of a held key
check(repeats === 0, 'two seconds of key repeats toggle nothing');
gate.release();
clock += 100;
check(press(), 'a new press after letting go toggles');
gate.release();
clock += 80;
check(press(), 'a quick second tap toggles again (show, then hide)');

// The key-up was missed: a pause in the repeats counts as letting go.
clock += 1500;
check(press(), 'after a missed key-up, the next press still works');
clock += 500;
check(!press(), 'but a repeat within the pause does not');

console.log(failures ? `\n${failures} check(s) failed` : '\nAll shortcut checks passed.');
process.exit(failures ? 1 : 0);

// Checks which buttons the click guard flags. Run: npm run test:guard

const { riskOf, elementAt } = require('../src/overlay/guard');

const el = (name, type = 'Button', enabled = true) => ({ name, type, enabled });

const cases = [
  // [name, expected level or null, optional type, optional enabled]
  ['Delete', 'medium'],
  ['Delete permanently', 'high'],
  ['Empty Recycle Bin', 'high'],
  ["Don't Save", 'medium'],
  ['Don’t Save', 'medium'],
  ['Do not save', 'medium'],
  ['Discard changes', 'medium'],
  ['Uninstall', 'medium'],
  ['Replace All', 'medium'],
  ['Factory reset', 'high'],
  ['Reset', 'medium'],
  ['Force push', 'high'],
  ['Remove', 'medium'],
  ['Clear all', 'medium'],
  ['Format', null],              // Word's Format menu, not a disk format
  ['Format Painter', null],
  ['Reset zoom', null],
  ['Remove filter', null],
  ['Clear search', null],
  ['Undo delete', null],
  ['Restore', null],
  ['Cancel', null],
  ['Replace', null],
  ['Save', null],
  ['Save As...', null],
  ['Settings', null],
  ['Recycle Bin', null],
  ['Sign out', null],
  ['', null],
  ['Delete', null, 'Button', false],      // greyed out: can't be clicked
  ['delete_me.txt', null, 'Document'],    // a file name, not an action
  ['notes about remove.txt', null, 'Edit'],
];

let failed = 0;
for (const [name, expected, type, enabled] of cases) {
  const risk = riskOf(el(name, type, enabled));
  const ok = expected === null ? risk === null : risk && risk.level === expected;
  if (!ok) failed += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} "${name}"${type ? ` (${type}${enabled === false ? ', disabled' : ''})` : ''} -> ${risk ? `${risk.level}: ${risk.warning}` : 'safe'}`);
}

const r = (x, y, w, h) => ({ x, y, w, h });
const screen = [
  { name: 'Toolbar', type: 'Button', rect: r(0, 0, 500, 40) },
  { name: 'Delete', type: 'Button', rect: r(100, 5, 60, 30) },
  { name: 'Save', type: 'Button', rect: r(200, 5, 60, 30) },
];
const hits = [
  [{ x: 120, y: 20 }, 'Delete'],   // inside both the toolbar and Delete: the smaller one wins
  [{ x: 230, y: 20 }, 'Save'],
  [{ x: 400, y: 20 }, 'Toolbar'],
  [{ x: 600, y: 20 }, null],
];
for (const [point, expected] of hits) {
  const found = elementAt(point, screen);
  const ok = (found ? found.name : null) === expected;
  if (!ok) failed += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} element at ${point.x},${point.y} -> ${found ? found.name : 'nothing'}`);
}

console.log(failed ? `\n${failed} guard checks failed.` : '\nAll guard checks passed.');
process.exitCode = failed ? 1 : 0;

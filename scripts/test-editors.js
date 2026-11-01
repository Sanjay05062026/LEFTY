// The editors Lefty knows: which process is which editor, how each one goes to a line, and what its text looks
// like. These are the rules that let ghost code and the code doctor work outside VS Code. Run: npm run test:editors

const editors = require('../src/editors');

let failed = 0;
function check(condition, message) {
  if (!condition) failed += 1;
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${message}`);
}
const assert = {
  equal: (a, b, m) => check(a === b, m || `${JSON.stringify(a)} === ${JSON.stringify(b)}`),
  notEqual: (a, b, m) => check(a !== b, m || `${JSON.stringify(a)} !== ${JSON.stringify(b)}`),
  deepEqual: (a, b, m) => check(JSON.stringify(a) === JSON.stringify(b), m || `${JSON.stringify(a)} = ${JSON.stringify(b)}`),
  match: (a, re, m) => check(re.test(String(a)), m || `${JSON.stringify(a)} matches ${re}`),
  ok: (a, m) => check(Boolean(a), m || 'is true'),
};
function test(name, body) { body(); }

test('every editor Lefty knows is recognised by its process name', () => {
  const cases = [
    ['code', 'vscode', 'VS Code'],
    ['Code', 'vscode', 'VS Code'],                       // Windows reports it capitalised
    ['code.exe', 'vscode', 'VS Code'],                   // and sometimes with the extension
    ['cursor', 'vscode', 'Cursor'],
    ['code - insiders', 'vscode', 'VS Code Insiders'],
    ['windsurf', 'vscode', 'Windsurf'],
    ['vscodium', 'vscode', 'VSCodium'],
    ['notepad', 'notepad', 'Notepad'],
    ['notepad++', 'notepadpp', 'Notepad++'],
    ['sublime_text', 'sublime', 'Sublime Text'],
    ['pycharm64', 'jetbrains', 'PyCharm'],
    ['idea64', 'jetbrains', 'IntelliJ IDEA'],
    ['webstorm64', 'jetbrains', 'WebStorm'],
    ['studio64', 'jetbrains', 'Android Studio'],
    ['devenv', 'visualstudio', 'Visual Studio'],
  ];
  for (const [process, id, label] of cases) {
    assert.equal(editors.find(process).id, id, process);
    assert.equal(editors.describe(process), label, `${process} should read as "${label}"`);
    assert.equal(editors.isKnown(process), true, process);
  }
});

test('an app Lefty has no entry for is not claimed to be an editor', () => {
  for (const process of ['chrome', 'winword', 'explorer', 'spotify', '', null]) {
    assert.equal(editors.find(process), null, String(process));
    assert.equal(editors.isKnown(process), false, String(process));
  }
});

test('but an unknown editor still gets usable numbers to work from', () => {
  const generic = editors.findOrGeneric('some-new-editor');
  assert.equal(generic.id, 'generic');
  assert.equal(editors.describe('some-new-editor'), 'your editor');
  assert.ok(generic.font.fontSize > 0 && generic.font.lineHeight > 0, 'the generic entry can still draw');
  assert.deepEqual(editors.gotoKeys('some-new-editor', 12), ['ctrl+g', 'wait:150', 'text:12', 'wait:80', 'enter', 'wait:150']);
});

test('going to a line uses what each editor\'s Go To box accepts', () => {
  // VS Code and the JetBrains IDEs take "line:column" in one box.
  assert.deepEqual(editors.gotoKeys('code', 12, 5).filter((key) => key.startsWith('text:')), ['text:12:5']);
  assert.deepEqual(editors.gotoKeys('pycharm64', 12, 5).filter((key) => key.startsWith('text:')), ['text:12:5']);
  assert.equal(editors.canGotoColumn('code'), true);
  assert.equal(editors.canGotoColumn('pycharm64'), true);
  // The others have a line box only, so the column is left off rather than typed in as junk.
  for (const process of ['notepad', 'notepad++', 'sublime_text', 'devenv']) {
    assert.deepEqual(editors.gotoKeys(process, 12, 5).filter((key) => key.startsWith('text:')), ['text:12'], process);
    assert.equal(editors.canGotoColumn(process), false, process);
  }
});

test('go-to-line always starts with Ctrl+G and ends with Enter, with time to react', () => {
  for (const process of ['code', 'notepad++', 'devenv', 'unknown']) {
    const keys = editors.gotoKeys(process, 3);
    assert.equal(keys[0], 'ctrl+g', process);
    assert.ok(keys.includes('enter'), process);
    assert.ok(keys.some((key) => key.startsWith('wait:')), `${process} needs a pause for the box to open`);
  }
});

test('only the editors that keep a settings file Lefty can read have a folder', () => {
  assert.equal(editors.settingsFolder('code'), 'Code');
  assert.equal(editors.settingsFolder('cursor'), 'Cursor');
  assert.equal(editors.settingsFolder('code - insiders'), 'Code - Insiders');
  for (const process of ['notepad', 'notepad++', 'sublime_text', 'pycharm64', 'devenv', 'unknown']) {
    assert.equal(editors.settingsFolder(process), null, process);
  }
});

test('the editor\'s own font is used when its settings say nothing', () => {
  const vscode = editors.fontOf('code', {});
  assert.equal(vscode.fontSize, 14);
  assert.equal(vscode.lineHeight, 19);
  assert.match(vscode.fontFamily, /Consolas/);
  assert.equal(vscode.light, false);
  const jetbrains = editors.fontOf('pycharm64', {});
  assert.match(jetbrains.fontFamily, /JetBrains Mono/, 'each editor starts from its own defaults');
  assert.notEqual(jetbrains.fontSize, vscode.fontSize);
});

test('VS Code settings are read the way VS Code applies them', () => {
  assert.equal(editors.fontOf('code', { 'editor.fontSize': 18 }).fontSize, 18);
  assert.equal(editors.fontOf('code', { 'editor.fontFamily': 'Fira Code' }).fontFamily, 'Fira Code');
  // lineHeight 0 means "work it out from the font size"; under 8 it is a multiple of it; 8 or more is exact.
  assert.equal(editors.fontOf('code', { 'editor.fontSize': 20, 'editor.lineHeight': 0 }).lineHeight, 27);
  assert.equal(editors.fontOf('code', { 'editor.fontSize': 20, 'editor.lineHeight': 1.5 }).lineHeight, 30);
  assert.equal(editors.fontOf('code', { 'editor.fontSize': 20, 'editor.lineHeight': 32 }).lineHeight, 32);
  assert.equal(editors.fontOf('code', { 'editor.letterSpacing': 1.5 }).letterSpacing, 1.5);
  assert.equal(editors.fontOf('code', { 'workbench.colorTheme': 'Default Light Modern' }).light, true);
  assert.equal(editors.fontOf('code', { 'workbench.colorTheme': 'Monokai Dark' }).light, false);
});

test('the window zoom level scales everything, as the editor does', () => {
  const normal = editors.fontOf('code', { 'editor.fontSize': 10, 'editor.lineHeight': 20, 'editor.letterSpacing': 1 });
  const zoomed = editors.fontOf('code', { 'editor.fontSize': 10, 'editor.lineHeight': 20, 'editor.letterSpacing': 1, 'window.zoomLevel': 1 });
  assert.ok(Math.abs(zoomed.fontSize / normal.fontSize - 1.2) < 1e-9, 'one zoom step is 1.2x');
  assert.ok(Math.abs(zoomed.lineHeight / normal.lineHeight - 1.2) < 1e-9);
  assert.ok(Math.abs(zoomed.letterSpacing / normal.letterSpacing - 1.2) < 1e-9);
  assert.ok(editors.fontOf('code', { 'window.zoomLevel': -1 }).fontSize < normal.fontSize + 14, 'zooming out shrinks it');
});

test('nonsense in a settings file falls back instead of drawing nothing', () => {
  const font = editors.fontOf('code', { 'editor.fontSize': 'big', 'editor.lineHeight': null, 'window.zoomLevel': 'x', 'editor.letterSpacing': 'wide' });
  assert.equal(font.fontSize, 14);
  assert.equal(font.lineHeight, 19);
  assert.equal(font.letterSpacing, 0);
  assert.ok(Number.isFinite(editors.fontOf(null, undefined).fontSize), 'no editor and no settings still gives a font');
});

test('a bigger font keeps the editor\'s line spacing in proportion', () => {
  const small = editors.fontOf('notepad++', {});
  const big = editors.fontOf('notepad++', { 'editor.fontSize': small.fontSize * 2 });
  assert.ok(big.lineHeight > small.lineHeight * 1.5, 'the lines have to grow with the text, or the code overlaps');
  assert.ok(big.lineHeight >= big.fontSize * 1.15, 'and never sit closer than the text is tall');
});

test('an editor is spotted from the window title alone', () => {
  const cases = [
    ['add.py - python - Visual Studio Code', 'vscode'],
    ['index.js - my-app - Cursor', 'vscode'],
    ['notes.txt - Notepad', 'notepad'],
    ['C:\\work\\main.c - Notepad++', 'notepadpp'],
    ['main.rs — Sublime Text', 'sublime'],
    ['app.py - lefty - PyCharm', 'jetbrains'],
    ['Lefty - Microsoft Visual Studio', 'visualstudio'],
  ];
  for (const [title, id] of cases) assert.equal(editors.fromTitle(title).id, id, title);
  for (const title of ['Inbox - Outlook', 'Calculator', 'python - Google Chrome', '', null]) {
    assert.equal(editors.fromTitle(title), null, String(title));
  }
});

test('an editor is spotted from the name Lefty reads off the app too', () => {
  assert.equal(editors.fromAppName('VS Code').id, 'vscode');
  assert.equal(editors.fromAppName('PyCharm').id, 'jetbrains');
  assert.equal(editors.fromAppName('notepad++').id, 'notepadpp', 'the name is matched whatever its case');
  assert.equal(editors.fromAppName('Chrome'), null);
  assert.equal(editors.isCodeEditor({ app: 'VS Code', title: '' }), true);
  assert.equal(editors.isCodeEditor({ app: 'the taskbar', title: 'add.py - Notepad++' }), true);
  assert.equal(editors.isCodeEditor({ app: 'Paint', title: 'Untitled - Paint' }), false);
  assert.equal(editors.isCodeEditor({}), false);
});

test('the JetBrains IDEs carry the hint their users need when they stay silent', () => {
  const jetbrains = editors.find('pycharm64');
  assert.match(jetbrains.needsAccessibility, /accessibility/i);
  // Nothing else should claim to need setting up, or Lefty would tell people to fix a working editor.
  for (const editor of editors.EDITORS) {
    if (editor.id !== 'jetbrains') assert.equal(editor.needsAccessibility, undefined, editor.id);
  }
});

test('the registry itself holds together', () => {
  const seen = new Map();
  for (const editor of editors.EDITORS) {
    assert.ok(editor.id && editor.label, 'every editor needs an id and a name');
    assert.ok(editor.processes.length, `${editor.id} needs at least one process name`);
    assert.ok(['line', 'line-col'].includes(editor.goto), `${editor.id} has an unknown Go To style`);
    assert.ok(editor.font.fontSize > 0 && editor.font.lineHeight > 0, `${editor.id} needs a font to fall back on`);
    for (const process of editor.processes) {
      assert.equal(process, process.toLowerCase(), `${process} must be lower case to be matched`);
      assert.equal(seen.get(process), undefined, `${process} is claimed by both ${seen.get(process)} and ${editor.id}`);
      seen.set(process, editor.id);
    }
    for (const process of Object.keys(editor.labels || {})) {
      assert.ok(editor.processes.includes(process), `${editor.id} names "${process}" but does not list it`);
    }
    for (const process of Object.keys(editor.folders || {})) {
      assert.ok(editor.processes.includes(process), `${editor.id} has a settings folder for "${process}" but does not list it`);
    }
  }
});

console.log(failed ? `\n${failed} editor check(s) failed.` : '\nAll editor checks passed.');
process.exitCode = failed ? 1 : 0;

// Walks Lefty's goal loop through realistic screen sequences. Run: npm run test:skills

const { decide, noteEvent, pathSkill, saveSkill, isSaveGoal, looksUnsaved } = require('../src/overlay/skills');

let failed = 0;
function check(condition, message) {
  if (!condition) failed += 1;
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${message}`);
}

const r = (x, y, w, h) => ({ x, y, w, h });
const el = (name, type, rect, enabled = true) => ({ name, type, rect, enabled });
const centre = (rect) => ({ x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 });

// Screens of Notepad while saving.
const menuBar = [el('File', 'MenuItem', r(10, 40, 40, 30)), el('Edit', 'MenuItem', r(55, 40, 40, 30)), el('View', 'MenuItem', r(100, 40, 40, 30))];
const notepad = (title) => ({ ok: true, title, elements: menuBar });
const fileMenu = (title) => ({ ok: true, title, elements: [...menuBar,
  el('New tab', 'MenuItem', r(10, 80, 200, 30)), el('Save', 'MenuItem', r(10, 120, 200, 30)),
  el('Save as', 'MenuItem', r(10, 160, 200, 30)), el('Save all', 'MenuItem', r(10, 200, 200, 30))] });
const saveDialog = { ok: true, title: 'Save as', elements: [
  el('Desktop', 'TreeItem', r(300, 200, 150, 28)), el('Documents', 'TreeItem', r(300, 230, 150, 28)), el('Downloads', 'TreeItem', r(300, 260, 150, 28)),
  el('notes.txt', 'ListItem', r(480, 200, 300, 24)),
  el('File name:', 'ComboBox', r(480, 500, 400, 28)), el('File name:', 'Edit', r(482, 502, 380, 24)),
  el('Save as type:', 'ComboBox', r(480, 540, 400, 28)),
  el('Save', 'Button', r(700, 600, 90, 30)), el('Cancel', 'Button', r(800, 600, 90, 30))] };

const newJob = (skill) => ({ skill, memory: {} });
const click = (job, d, seen, extra = {}) => noteEvent(job, {
  type: 'click', hit: true, point: centre(d.target.rect), element: d.target, elements: seen.elements, decisionId: d.id, targetName: d.target.name, ...extra,
});

// --- "save this" on a new document: all the way to a real save ---
{
  const job = newJob(saveSkill('save this file'));
  let d = decide(job, notepad('Untitled - Notepad'));
  check(d.id === 'save:file' && d.target.name === 'File', 'save: starts at the File menu');
  click(job, d, notepad('Untitled - Notepad'));
  d = decide(job, fileMenu('Untitled - Notepad'));
  check(d.id === 'save:save' && d.target.name === 'Save', 'save: menu open -> points at Save');
  click(job, d, fileMenu('Untitled - Notepad'));
  d = decide(job, notepad('Untitled - Notepad'));
  check(d.wait === true, 'save: right after clicking Save it waits for the dialog');
  d = decide(job, saveDialog);
  check(d.id === 'dialog:folder' && d.kind === 'choose' && d.target.type === 'Area', 'save: dialog -> "Pick any folder" around the folder list');
  check(d.target.rect.x === 300 && d.target.rect.y === 200 && d.target.rect.h === 88, 'save: the folder area covers all visible folders');
  const documents = saveDialog.elements[1];
  noteEvent(job, { type: 'click', hit: true, point: centre(documents.rect), element: documents, elements: saveDialog.elements, decisionId: d.id });
  d = decide(job, saveDialog);
  check(d.id === 'dialog:name' && d.target.type === 'Edit', 'save: folder picked -> "Name it anything" on the File name box');
  noteEvent(job, { type: 'typing' });
  d = decide(job, saveDialog);
  check(d.id === 'dialog:confirm' && d.target.name === 'Save' && d.target.type === 'Button', 'save: typed a name -> points at the Save button');
  click(job, d, saveDialog);
  d = decide(job, notepad('my notes.txt - Notepad'));
  check(d.done === true && /Saved/.test(d.message), 'save: dialog closed and the title has a real name -> done, "Saved!"');
}

// --- a dialog that names its folder pane: the whole pane is ringed ---
{
  const withPane = { ...saveDialog, elements: [el('Navigation Pane', 'Tree', r(290, 190, 180, 300)), ...saveDialog.elements] };
  const job = newJob(saveSkill('save'));
  const d = decide(job, withPane);
  check(d.id === 'dialog:folder' && d.target.rect.x === 290 && d.target.rect.w === 180, 'save: rings the whole Navigation Pane when the dialog has one');
}

// --- cancelling the dialog: Lefty goes round again instead of claiming success ---
{
  const job = newJob(saveSkill('save'));
  let d = decide(job, fileMenu('Untitled - Notepad'));
  click(job, d, fileMenu('Untitled - Notepad'));
  d = decide(job, saveDialog);
  check(d.id === 'dialog:folder', 'cancel: dialog coached');
  const cancel = saveDialog.elements.find((e) => e.name === 'Cancel');
  noteEvent(job, { type: 'click', hit: false, point: centre(cancel.rect), element: cancel, elements: saveDialog.elements, decisionId: d.id });
  d = decide(job, notepad('Untitled - Notepad'));
  check(!d.done && d.id === 'save:file', 'cancel: not saved, so Lefty starts again at File');
}

// --- a document that already has a name: Save works without a dialog ---
{
  const job = newJob(saveSkill('save my work'));
  let d = decide(job, fileMenu('report.txt - Notepad'));
  click(job, d, fileMenu('report.txt - Notepad'));
  d = decide(job, notepad('report.txt - Notepad'));
  check(d.wait === true, 'named: waits briefly in case a dialog opens');
  job.memory.saveAt -= 2000; // time passes, no dialog
  d = decide(job, notepad('report.txt - Notepad'));
  check(d.done === true, 'named: no dialog and a saved title -> done');
}

// --- Ctrl+S instead of clicking ---
{
  const job = newJob(saveSkill('save'));
  decide(job, notepad('Untitled - Notepad'));
  noteEvent(job, { type: 'key', combo: 'Ctrl+S' });
  let d = decide(job, notepad('Untitled - Notepad'));
  check(d.wait === true, 'ctrl+s: counts as a save, waits for the dialog');
  d = decide(job, saveDialog);
  check(d.id === 'dialog:folder', 'ctrl+s: then coaches the dialog');
}

// --- typing a name first skips the folder step ---
{
  const job = newJob(saveSkill('save'));
  decide(job, saveDialog);
  noteEvent(job, { type: 'typing' });
  const d = decide(job, saveDialog);
  check(d.id === 'dialog:confirm', 'typing first: the folder is fine as it is, straight to Save');
}

// --- "save as" prefers Save as ---
{
  const job = newJob(saveSkill('save it as'));
  const d = decide(job, fileMenu('notes.txt - Notepad'));
  check(d.target.name === 'Save as', 'save as: picks "Save as" over "Save"');
}

// --- a typed path still works, and its dialog is coached to the end ---
{
  const job = newJob(pathSkill(['file', 'save as']));
  let d = decide(job, notepad('Untitled - Notepad'));
  check(d.id === 'path:0' && d.count === '1/2' && d.target.name === 'File', 'path: 1/2 File');
  click(job, d, notepad('Untitled - Notepad'));
  d = decide(job, fileMenu('Untitled - Notepad'));
  check(d.id === 'path:1' && d.count === '2/2' && d.target.name === 'Save as', 'path: 2/2 Save as');
  click(job, d, fileMenu('Untitled - Notepad'));
  d = decide(job, notepad('Untitled - Notepad'));
  check(d.wait === true, 'path: "Save as" may open a dialog, so it waits instead of saying Done');
  d = decide(job, saveDialog);
  check(d.id === 'dialog:folder', 'path: the dialog is coached too');
  noteEvent(job, { type: 'typing' });
  d = decide(job, saveDialog);
  click(job, d, saveDialog);
  d = decide(job, notepad('notes.txt - Notepad'));
  check(d.done === true && !d.cancelled, 'path: done once the dialog is finished');
}

// --- a click on a later step counts for the steps before it ---
{
  const screen = { ok: true, title: 'x', elements: [el('Start', 'Button', r(0, 0, 40, 40)), el('Search', 'Button', r(50, 0, 200, 40))] };
  const job = newJob(pathSkill(['start', 'search']));
  const d = decide(job, screen);
  noteEvent(job, { type: 'click', hit: false, point: { x: 100, y: 20 }, element: screen.elements[1], elements: screen.elements, decisionId: d.id });
  check(decide(job, screen).done === true, 'skip ahead: clicking Search while Lefty points at Start finishes the path');
}

// --- a path step that is not on screen ---
{
  const job = newJob(pathSkill(['rename']));
  check(Boolean(decide(job, notepad('Untitled - Notepad')).stuck), 'path: a missing step is reported as stuck, not guessed');
}

check(isSaveGoal('save this') && isSaveGoal('I want to save my file') && !isSaveGoal('open settings'), 'goal: recognises save goals');
check(looksUnsaved('Untitled - Notepad') && looksUnsaved('● index.js - VS Code') && looksUnsaved('Document1 - Word')
  && !looksUnsaved('notes.txt - Notepad') && !looksUnsaved('Report.docx - Word'), 'title: tells unsaved documents from saved ones');

console.log(failed ? `\n${failed} skill checks failed.` : '\nAll skill checks passed.');
process.exitCode = failed ? 1 : 0;

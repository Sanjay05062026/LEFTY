// Walks Lefty's goal loop through realistic screen sequences. Run: npm run test:skills

const { decide, noteEvent, pathSkill, saveSkill, aiSkill, isSaveGoal, looksUnsaved } = require('../src/overlay/skills');

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
check(isSaveGoal('sav ths') && isSaveGoal('svae it') && isSaveGoal('saev my file') && isSaveGoal('plz sve'), 'goal: save typed with spelling mistakes still counts');
check(!isSaveGoal('make it safe') && !isSaveGoal('same as before') && !isSaveGoal('have a look') && !isSaveGoal('ave'), 'goal: real words one letter from save do not');
check(looksUnsaved('Untitled - Notepad') && looksUnsaved('● index.js - VS Code') && looksUnsaved('Document1 - Word')
  && !looksUnsaved('notes.txt - Notepad') && !looksUnsaved('Report.docx - Word'), 'title: tells unsaved documents from saved ones');

// --- the AI brain as a skill, with a fake AI: one step at a time until the AI sees it's done ---
async function aiChecks() {
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  const word = { ok: true, title: 'Document1 - Word', elements: [
    el('Home', 'TabItem', r(10, 40, 60, 30)), el('Insert', 'TabItem', r(80, 40, 60, 30)),
    el('Table', 'Button', r(10, 90, 60, 60)), el('Page body', 'Document', r(0, 160, 1500, 700))] };
  const insertTab = { ...word, elements: [...word.elements.filter((e) => e.name !== 'Table'),
    el('Table', 'SplitButton', r(200, 90, 60, 60)), el('Pictures', 'Button', r(270, 90, 60, 60))] };

  // The AI's answers, in order; each request is recorded so we can check what Lefty told it.
  const requests = [];
  const answers = [
    { ok: true, status: 'step', action: 'click', instruction: 'Open Insert ➕', target: el('Insert', 'TabItem', r(80, 40, 60, 30)) },
    { ok: true, status: 'step', action: 'click', instruction: 'Click Table 📊', target: el('Table', 'SplitButton', r(200, 90, 60, 60)) },
    { ok: true, status: 'step', action: 'key', instruction: 'Undo that', text: 'Ctrl+Z', target: null },
    { ok: true, status: 'step', action: 'type', instruction: 'Type a title ✏️', text: 'Hello', target: el('Page body', 'Document', r(0, 160, 1500, 700)) },
    { ok: true, status: 'done', message: 'Your table is in!' },
  ];
  let clock = 1000000; // a fake clock (Date.now-like)
  const think = (request) => { requests.push(request); return Promise.resolve(answers[requests.length - 1]); };
  const job = newJob(aiSkill('add a table', think, { now: () => clock }));
  let woke = 0;
  job.memory.wake = () => { woke += 1; };

  let d = decide(job, word);
  check(d.wait && d.thinking && requests.length === 1, 'ai: the first look asks the AI and shows thinking');
  check(decide(job, word).thinking && requests.length === 1, 'ai: no second call while one is on its way');
  await tick();
  check(woke === 1, 'ai: Lefty is woken when the answer lands');
  d = decide(job, word);
  check(d.id === 'ai:0' && d.target.name === 'Insert' && d.label === 'Open Insert ➕', 'ai: points at the target the AI chose, with its words on the tag');

  noteEvent(job, { type: 'click', hit: false, point: { x: 600, y: 600 }, element: word.elements[3], elements: word.elements, decisionId: d.id });
  check(decide(job, word).id === 'ai:0' && requests.length === 1, 'ai: one stray click keeps the step (no new AI call)');
  click(job, d, word);
  check(decide(job, insertTab).thinking && requests.length === 2, 'ai: a click on the target asks for the next step');
  check(/Open Insert/.test(requests[1].history[0]) && requests[1].goal === 'add a table', 'ai: the AI is told the goal and the step that was done');
  await tick();

  // The ribbon moved Table: Lefty follows the element by name, not the old position.
  d = decide(job, insertTab);
  check(d.id === 'ai:1' && d.target.rect.x === 200, 'ai: finds the chosen target on the current screen');
  // The target vanishes (a dialog covered it): after a few looks Lefty asks the AI again.
  const covered = { ...word, elements: word.elements.filter((e) => e.name !== 'Table') };
  decide(job, covered); decide(job, covered);
  check(decide(job, covered).wait && !decide(job, covered).id, 'ai: a missing target makes Lefty look again');
  check(requests.length === 3 && /screen changed/.test(requests[2].note), 'ai: ...and then ask the AI afresh, saying the screen changed');
  await tick();

  d = decide(job, word);
  check(d.kind === 'tell' && !d.target && /Ctrl\+Z/.test(d.label), 'ai: a shortcut step shows on the tag with nothing to point at');
  noteEvent(job, { type: 'click', hit: false, point: { x: 900, y: 10 }, elements: [], decisionId: d.id });
  check(decide(job, word).id === d.id && requests.length === 3, 'ai: a stray click does not finish a shortcut step');
  noteEvent(job, { type: 'key', combo: 'shortcut', decisionId: d.id });
  check(decide(job, word).thinking && requests.length === 4, 'ai: pressing a shortcut finishes a shortcut step');
  await tick();

  d = decide(job, word);
  check(d.kind === 'type' && d.label === 'Type a title ✏️: "Hello"', 'ai: a typing step says what to type');
  click(job, d, word);
  check(decide(job, word).id === d.id, 'ai: clicking into the box is not the end of a typing step');
  noteEvent(job, { type: 'typing' });
  clock += 1000;
  check(decide(job, word).id === d.id, 'ai: still typing');
  clock += 2000;
  check(decide(job, word).thinking && requests.length === 5, 'ai: a pause after typing finishes the step');
  await tick();
  d = decide(job, word);
  check(d.done && d.message === '🎉 Your table is in!', 'ai: done only when the AI sees the goal achieved');

  // The AI says the user must decide, or can't do it: Lefty stops and says why.
  const stopJob = newJob(aiSkill('pay the bill', () => Promise.resolve({ ok: true, status: 'need_user', message: 'Enter your card details yourself.' })));
  decide(stopJob, word); await tick();
  check(decide(stopJob, word).say === 'Enter your card details yourself.', 'ai: "need the user" stops the guide and says why in the chat');
  const vagueJob = newJob(aiSkill('tell', () => Promise.resolve({ ok: true, status: 'need_user', message: 'What should I help you with?' })));
  decide(vagueJob, word); await tick();
  check(decide(vagueJob, word).say === 'What should I help you with?' && !decide(vagueJob, word).done, 'ai: a vague goal gets a question back, never a fake "done"');
  const answerJob = newJob(aiSkill('what is this app', () => Promise.resolve({ ok: true, status: 'answer', message: 'This is Word, a document editor.' })));
  decide(answerJob, word); await tick();
  check(decide(answerJob, word).say === 'This is Word, a document editor.', 'ai: a question gets its answer in the chat');

  // Asked from the desktop about another app: first "open that app", and once it's in front the goal carries on.
  const appAnswers = [
    { ok: true, status: 'step', action: 'open_app', app: 'Visual Studio Code', instruction: 'Open VS Code 🚀', target: null },
    { ok: true, status: 'step', action: 'click', instruction: 'Open Extensions 🧩', target: el('Extensions', 'TabItem', r(7, 214, 37, 38)) },
  ];
  const appRequests = [];
  const appJob = newJob(aiSkill('download the python extension in vscode', (q) => { appRequests.push(q); return Promise.resolve(appAnswers[appRequests.length - 1]); }));
  const desktop = { ok: true, title: 'Program Manager', elements: [el('Start', 'Button', r(700, 820, 40, 40))] };
  decide(appJob, desktop); await tick();
  const open = decide(appJob, desktop);
  check(open.kind === 'open' && open.app === 'Visual Studio Code' && open.label === 'Open VS Code 🚀' && !open.target, 'ai: "open that app" is a step of its own, with nothing to point at');
  check(decide(appJob, desktop).id === open.id && appRequests.length === 1, 'ai: while the app is opening, no new question goes to the brain');
  noteEvent(appJob, { type: 'opened', app: 'VS Code', decisionId: open.id });
  check(decide(appJob, desktop).thinking && appRequests.length === 2 && /VS Code is now in front/.test(appRequests[1].history[0]), 'ai: once the app is in front, the brain is told and asked for the next step');
  await tick();
  const vscodeScreen = { ok: true, title: 'basics.py - Visual Studio Code', elements: [el('Extensions', 'TabItem', r(7, 214, 37, 38))] };
  check(decide(appJob, vscodeScreen).target.name === 'Extensions', 'ai: the next step is pointed at in the new app');

  // "Single linked list" in VS Code: the code becomes ghost text to type over; only typing all of it finishes it.
  const codeRequests = [];
  const codeJob = newJob(aiSkill('single linked list', (q) => { codeRequests.push(q); return Promise.resolve({ ok: true, status: 'step', action: 'write_code', instruction: 'Type along with me 👻', code: 'class Node:\n    pass', target: null }); }));
  const editor = { ok: true, title: 'Untitled-1 - Visual Studio Code', elements: [] };
  decide(codeJob, editor); await tick();
  const ghostStep = decide(codeJob, editor);
  check(ghostStep.kind === 'code' && ghostStep.code === 'class Node:\n    pass' && ghostStep.label === 'Type along with me 👻' && !ghostStep.target, 'ai: code to write is a ghost-code step');
  noteEvent(codeJob, { type: 'key', combo: 'Enter', decisionId: ghostStep.id });
  noteEvent(codeJob, { type: 'key', combo: 'Escape', decisionId: ghostStep.id });
  noteEvent(codeJob, { type: 'click', hit: false, point: { x: 5, y: 5 }, elements: [], decisionId: ghostStep.id });
  noteEvent(codeJob, { type: 'click', hit: false, point: { x: 9, y: 9 }, elements: [], decisionId: ghostStep.id });
  check(decide(codeJob, editor).id === ghostStep.id && codeRequests.length === 1, 'ai: Enter, Escape and clicks while typing code do not end the code step');
  noteEvent(codeJob, { type: 'coded', decisionId: ghostStep.id });
  const coded = decide(codeJob, editor);
  check(coded.done && /wrote it/.test(coded.message) && codeRequests.length === 1, 'ai: typing all the code finishes the goal');
  const emptyCode = newJob(aiSkill('code', () => Promise.resolve({ ok: true, status: 'step', action: 'write_code', instruction: 'Type 👻', code: '', target: null })));
  decide(emptyCode, editor); await tick();
  check(/couldn't write/.test(decide(emptyCode, editor).giveUp || ''), 'ai: a code step with no code says so instead of showing nothing');

  // "Find the error": a request for the code doctor, typos and all; requests for new code are not.
  const { isCodeCheckGoal } = require('../src/overlay/skills');
  check(['find the error', 'there is an eror', 'fix my code', 'why isnt this working', 'debug it', 'whats wrong here', 'probelm on line 4'].every(isCodeCheckGoal)
    && !['single linked list', 'write a function to fix strings', 'open the terminal', 'make the text bigger'].some(isCodeCheckGoal),
    'ai: error and bug questions go to the code doctor, new-code requests and other goals do not');
  const doctorJob = newJob(aiSkill('why does my code fail', () => Promise.resolve({ ok: true, status: 'step', action: 'check_code', instruction: 'Checking your code 🩺', target: null })));
  decide(doctorJob, editor); await tick();
  const doctorStep = decide(doctorJob, editor);
  check(doctorStep.kind === 'doctor' && doctorStep.label === 'Checking your code 🩺' && !doctorStep.target, 'ai: the brain can hand a goal to the code doctor');

  // The app refused to be read (VS Code does this for a moment after a menu click): Lefty keeps the last target.
  const unreadJob = newJob(aiSkill('add a table', () => Promise.resolve({ ok: true, status: 'step', action: 'click', instruction: 'Open Insert ➕', target: el('Insert', 'TabItem', r(80, 40, 60, 30)) })));
  decide(unreadJob, word); await tick();
  const unread = { ok: true, unread: true, elements: [], title: '' };
  const kept = decide(unreadJob, unread);
  check(kept.target && kept.target.name === 'Insert' && decide(unreadJob, unread).id === kept.id && decide(unreadJob, unread).id === kept.id,
    'ai: an unreadable screen keeps pointing at the chosen target (no "it vanished", no new call)');
  const failJob = newJob(aiSkill('x', () => Promise.resolve({ ok: false, error: 'My API key was refused.' })));
  decide(failJob, word); await tick();
  check(decide(failJob, word).giveUp === 'My API key was refused.', 'ai: a brain error is shown, not swallowed');
  const throwJob = newJob(aiSkill('x', () => Promise.reject(new Error('boom'))));
  decide(throwJob, word); await tick(); await tick();
  check(/hiccup/.test(decide(throwJob, word).giveUp), 'ai: a crash in the brain call becomes a friendly message');

  // A cap on calls per goal, so a confused loop can't run up a bill.
  let calls = 0;
  const loopJob = newJob(aiSkill('x', () => { calls += 1; return Promise.resolve({ ok: true, status: 'step', action: 'click', instruction: 'Again', target: null }); }));
  for (let i = 0; i < 500; i += 1) {
    const step = decide(loopJob, word);
    if (step.giveUp) break;
    await tick();
    const shown = decide(loopJob, word);
    if (shown.id) noteEvent(loopJob, { type: 'click', hit: false, point: { x: 1, y: 1 }, elements: [], decisionId: shown.id });
  }
  check(calls === 200 && /round in circles/.test(decide(loopJob, word).giveUp), `ai: only a runaway loop is stopped, after 200 calls (made ${calls})`);
}

aiChecks().then(() => {
  console.log(failed ? `\n${failed} skill checks failed.` : '\nAll skill checks passed.');
  process.exitCode = failed ? 1 : 0;
});

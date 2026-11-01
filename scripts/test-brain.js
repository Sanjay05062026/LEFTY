// Checks what Lefty sends the AI and how its answer becomes a target on screen, with a fake network:
// no API key needed and nothing is sent anywhere. Run: npm run test:brain

const brain = require('../src/brain');

let failed = 0;
function check(condition, message) {
  if (!condition) failed += 1;
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${message}`);
}

// A second screen to the right of the first, so coordinates must be converted between screen and global.
const display = { id: 2, bounds: { x: 1536, y: 0, width: 1536, height: 864 }, size: { width: 1536, height: 864 } };
const elements = [
  { name: 'File', type: 'MenuItem', enabled: true, rect: { x: 1546, y: 40, w: 40, h: 30 } },
  { name: 'Bold', type: 'Button', enabled: false, rect: { x: 1736, y: 90, w: 30, h: 30 } },
];
const jpeg = Buffer.from('fake image');

(async () => {
  // --- Gemini, the free brain: plain REST with a fake network ---
  delete process.env.LEFTY_MODEL;
  process.env.GEMINI_API_KEY = 'test-key';
  check(brain.provider() === 'gemini' && brain.ready(), 'a Gemini key makes Gemini the brain');
  const reply = (status, body) => ({ ok: status < 400, status, json: async () => body });
  const geminiAnswer = (answer) => reply(200, { candidates: [{ content: { parts: [{ text: JSON.stringify(answer) }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } });
  const busy = () => reply(503, { error: { message: 'This model is currently experiencing high demand.' } });
  const modelList = reply(200, { models: [
    'gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite', 'gemini-3.8-flash-tts',
  ].map((name) => ({ name: `models/${name}`, supportedGenerationMethods: ['generateContent'] })) });
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // Each model has its own queue of replies (with an optional delay); anything unplanned is "busy".
  let plan = {};
  let calls = [];
  let listCalls = 0;
  const fakeFetch = async (url, options = {}) => {
    if (url.includes('/models?')) { listCalls += 1; return modelList; }
    const model = url.match(/models\/([^:]+):/)[1];
    const call = { model, url, options, body: JSON.parse(options.body) };
    calls.push(call);
    const next = (plan[model] || []).shift();
    if (!next) return busy();
    if (next.timeout) throw Object.assign(new Error('aborted'), { name: 'AbortError' }); // as if its time ran out
    if (next.delay) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, next.delay);
        options.signal.addEventListener('abort', () => { clearTimeout(timer); call.aborted = true; reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); });
      });
    }
    return next.reply;
  };
  brain.useFetch(fakeFetch);
  const ask = (extra = {}) => brain.nextStep({ goal: 'open a file', history: [], elements, display, jpeg, ...extra });

  // What Lefty sends, and how the answer becomes a target on screen.
  plan = { 'gemini-3.6-flash': [{ reply: geminiAnswer({ status: 'step', action: 'click', element_id: 1, instruction: 'Make it bold 🅱️' }) }] };
  let step = await brain.nextStep({ goal: 'make this bold', history: ['Select the text'], note: 'the user clicked it', app: 'Word', title: 'Doc1 - Word', elements, display, jpeg });
  const parts = calls[0].body.contents[0].parts;
  const text = parts.find((part) => part.text).text;
  check(parts[0].inlineData && parts[0].inlineData.data === jpeg.toString('base64'), 'the screenshot is sent as an image');
  check(/Goal: make this bold/.test(text) && /1\. Select the text/.test(text) && /Since then: the user clicked it/.test(text), 'the goal, steps done and the latest move are in the prompt');
  check(/0 MenuItem "File" \(10,40 40x30\)/.test(text), 'elements are listed in screenshot coordinates (second screen offset removed)');
  check(/1 Button "Bold" disabled/.test(text), 'disabled elements are marked');
  check(step.target && step.target.name === 'Bold' && step.target.rect.x === 1736, 'element_id becomes that element, in global coordinates');
  check(step.instruction === 'Make it bold' && step.status === 'step', 'the instruction comes through, without emoji');
  plan = { 'gemini-3.6-flash': [1, 2].map(() => ({ reply: geminiAnswer({ status: 'step', action: 'click', element_id: 7, instruction: 'Nope' }) })) };
  step = await ask({ goal: 'x' });
  check(step.target === null, 'an element id that does not exist points at nothing (never a wrong element)');
  plan = { 'gemini-3.6-flash': [{ reply: geminiAnswer({ status: 'done', message: 'All bold now!' }) }] };
  step = await ask({ goal: 'x' });
  check(step.status === 'done' && step.message === 'All bold now!', 'done comes back with its message');
  check(!/Mode: Do it/.test(calls[calls.length - 1].body.contents[0].parts[1].text), 'Learn mode adds nothing to the prompt');
  // "Done" while pointing at something nobody clicked: asked once more, and the step wins.
  let before = calls.length;
  plan = { 'gemini-3.6-flash': [
    { reply: geminiAnswer({ status: 'done', action: 'click', element_id: 0, instruction: 'Switched 🔢', message: 'Done!' }) },
    { reply: geminiAnswer({ status: 'step', action: 'click', element_id: 0, instruction: 'Open File 📂' }) }] };
  step = await ask({ goal: 'open the file menu', history: ['Open menu (done: Lefty clicked "Open Navigation")'] });
  check(calls.length - before === 2 && /said done but also pointed at "File"/.test(calls[calls.length - 1].body.contents[0].parts[1].text) && step.status === 'step' && step.target.name === 'File',
    'a "done" that points at an unclicked File is asked again, and the real step comes back');
  before = calls.length;
  plan = { 'gemini-3.6-flash': [{ reply: geminiAnswer({ status: 'done', action: 'click', element_id: 0, instruction: 'Open 📂', message: 'Open!' }) }] };
  step = await ask({ goal: 'open the file menu', history: ['Open File (done: Lefty clicked "File")'] });
  check(calls.length - before === 1 && step.status === 'done', 'a "done" pointing at what was just clicked is believed (no second call)');
  plan = { 'gemini-3.6-flash': [{ reply: geminiAnswer({ status: 'done', message: 'ok' }) }] };
  await ask({ goal: 'search for python', auto: true });
  check(/Mode: Do it\. Lefty clicks and types for the user/.test(calls[calls.length - 1].body.contents[0].parts[1].text), 'Do it mode tells the AI to say exactly what to type');
  // A box worked out from its neighbours (VS Code's hidden search box) keeps that flag, so Do it mode doesn't expect its name.
  const hidden = [...elements, { name: 'Search Extensions', type: 'Edit', enabled: true, rect: { x: 1600, y: 200, w: 200, h: 24 }, guessed: true }];
  plan = { 'gemini-3.6-flash': [{ reply: geminiAnswer({ status: 'step', action: 'type', element_id: 2, text: 'python', instruction: 'Search python 🔎' }) }] };
  step = await ask({ goal: 'find python', elements: hidden });
  check(step.target && step.target.name === 'Search Extensions' && step.target.guessed === true, 'a worked-out box keeps its "guessed" flag');
  calls = [];

  // Quality first: the best model is asked alone, and when it answers in time nobody else is asked.
  brain.useHedge(80);
  plan = { 'gemini-3.6-flash': [{ delay: 10, reply: geminiAnswer({ status: 'step', action: 'click', element_id: 0, instruction: 'Open File 📂' }) }] };
  step = await ask();
  await sleep(120);
  check(calls.map((c) => c.model).join(',') === 'gemini-3.6-flash', `the best model is asked first, alone (asked ${calls.map((c) => c.model).join(', ')})`);
  check(step.instruction === 'Open File' && step.target && step.target.name === 'File', 'its answer is used');
  const call = calls[0];

  // The best model is slow today: the backup is asked too, the first good answer wins, the slow one is cancelled.
  calls = [];
  plan = {
    'gemini-3.6-flash': [{ delay: 400, reply: geminiAnswer({ status: 'step', action: 'click', element_id: 1, instruction: 'Slow answer' }) }],
    'gemini-3.7-flash': [{ delay: 20, reply: geminiAnswer({ status: 'step', action: 'click', element_id: 0, instruction: 'Fast backup' }) }],
  };
  step = await ask();
  check(calls.map((c) => c.model).join(',') === 'gemini-3.6-flash,gemini-3.7-flash' && step.instruction === 'Fast backup', 'when the best model is slow, the backup is asked too and wins');
  await sleep(10);
  check(calls[0].aborted === true, 'the slow request is cancelled');
  check(/3\.7-flash/.test(brain.label()), 'the log shows which model answered');
  calls = [];
  plan = { 'gemini-3.6-flash': [{ reply: geminiAnswer({ status: 'done', message: 'ok' }) }] };
  await ask();
  check(calls[0].model === 'gemini-3.6-flash', 'next time the best model still goes first (the backup winning once changes nothing)');
  check(call.options.headers['x-goog-api-key'] === 'test-key' && !call.url.includes('test-key'), 'the key goes in a header, never in the URL');
  check(call.body.contents[0].parts[0].inlineData.mimeType === 'image/jpeg' && call.body.contents[0].parts[0].inlineData.data === jpeg.toString('base64'), 'the screenshot is sent inline');
  check(call.body.generationConfig.thinkingConfig.thinkingLevel === 'minimal', 'minimal thinking: a quick look is enough for one step');
  const schema = call.body.generationConfig.responseSchema;
  check(call.body.generationConfig.responseMimeType === 'application/json' && schema.type === 'OBJECT'
    && schema.properties.status.type === 'STRING' && schema.properties.status.enum.includes('done'),
    'the answer is forced into JSON with Gemini-style schema types');

  // A model that can't think that little is asked again one level up, and remembered.
  calls = [];
  plan = {
    'gemini-3.5-flash-lite': [{ reply: reply(400, { error: { message: 'Thinking level MINIMAL is not supported for this model.' } }) }, { reply: geminiAnswer({ status: 'done', message: 'ok' }) }],
  };
  step = await ask();
  const lite = calls.filter((c) => c.model === 'gemini-3.5-flash-lite').map((c) => c.body.generationConfig.thinkingConfig.thinkingLevel).join(',');
  check(step.status === 'done' && lite === 'minimal,low', `a model that refuses minimal thinking is asked with low (asked: ${lite})`);
  calls = [];
  plan = { 'gemini-3.5-flash-lite': [{ reply: geminiAnswer({ status: 'done', message: 'ok' }) }] };
  await ask();
  check(calls.find((c) => c.model === 'gemini-3.5-flash-lite').body.generationConfig.thinkingConfig.thinkingLevel === 'low', '...and next time it is asked with low straight away');

  // Both fast models busy: the next two are tried.
  calls = [];
  plan = { 'gemini-3.8-flash': [{ reply: geminiAnswer({ status: 'step', action: 'click', point: { x: 500, y: 250 }, instruction: 'Click here' }) }] };
  step = await ask();
  check(calls.map((c) => c.model).slice(0, 3).join(',') === 'gemini-3.6-flash,gemini-3.7-flash,gemini-3.8-flash' && step.instruction === 'Click here', 'when the fast models are busy, the next Flash models answer (Flash-Lite only last)');
  check(step.target && step.target.rect.x + step.target.rect.w / 2 === 1536 + 768 && step.target.rect.y + step.target.rect.h / 2 === 216,
    "Gemini's 0-1000 point is converted to the right place on screen");
  check(listCalls === 1, "the key's model list is fetched only once");
  check(!calls.some((c) => /tts/.test(c.model)), 'only Flash and Flash-Lite models are used (not speech models)');

  // Everything busy: one clear error after a few tries.
  calls = [];
  plan = {};
  let error = null;
  try { await ask(); } catch (e) { error = e; }
  check(error && error.status === 503 && calls.length <= 8, `when every model is busy, Lefty tries once more after a pause, then gives up after ${calls.length} tries with a "busy" error`);

  // A model too slow to answer: the next ones are asked instead of giving up.
  calls = [];
  plan = {
    'gemini-3.6-flash': [{ timeout: true }],
    'gemini-3.7-flash': [{ timeout: true }],
    'gemini-3.8-flash': [{ reply: geminiAnswer({ status: 'step', action: 'click', element_id: 1, instruction: 'Click File' }) }],
  };
  step = await ask();
  check(step.instruction === 'Click File' && calls.length === 3, 'when models are too slow (timed out), the next one answers');

  // All of them slow: the error says so (main turns it into "busy, try again"), not a network problem.
  calls = [];
  plan = Object.fromEntries(['gemini-3.6-flash', 'gemini-3.7-flash', 'gemini-3.8-flash', 'gemini-3.5-flash-lite'].map((m) => [m, [{ timeout: true }, { timeout: true }]]));
  error = null;
  try { await ask(); } catch (e) { error = e; }
  check(error && error.timeout === true, 'when every model is too slow, the error is marked as a timeout');

  // Google says "slow down" on every model: Lefty waits as long as it asks, then tries again.
  calls = [];
  const slowDown = () => ({ reply: reply(429, { error: { message: 'Resource exhausted', details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '0.05s' }] } }) });
  plan = {
    'gemini-3.5-flash-lite': [slowDown()], 'gemini-3.6-flash': [slowDown()], 'gemini-3.8-flash': [slowDown()], 'gemini-3.7-flash': [slowDown(), { reply: geminiAnswer({ status: 'done', message: 'Waited and done' }) }],
  };
  const waitStarted = Date.now();
  step = await ask();
  check(step.message === 'Waited and done' && Date.now() - waitStarted >= 45, `a rate limit means wait and retry, not give up (${calls.length} calls, ${Date.now() - waitStarted} ms)`);

  const failsWith = async (replyFor) => {
    plan = { 'gemini-3.5-flash-lite': [{ reply: replyFor() }], 'gemini-3.6-flash': [{ reply: replyFor() }], 'gemini-3.7-flash': [{ reply: replyFor() }] };
    try { await ask(); } catch (e) { return e; }
    return null;
  };
  error = await failsWith(() => reply(400, { error: { message: 'API key not valid. Please pass a valid API key.' } }));
  check(error && error.status === 401, 'a bad key is reported as a refused key');
  error = await failsWith(() => reply(200, { candidates: [{ content: { parts: [{ text: 'not json' }] } }] }));
  check(error && /broken format/.test(error.message), 'a broken answer is an error, not a wrong pointer');

  // Models sometimes wrap the JSON or leak their reasoning into a field: Lefty keeps only what belongs on the tag.
  plan = { 'gemini-3.7-flash': [{ reply: reply(200, { candidates: [{ content: { parts: [{ text: '```json\n{"status":"step","action":"key","text":"Ctrl+Plus Anders... wait, standard shortcut is","instruction":""}\n```' }] } }] }) }] };
  step = await ask();
  check(step.text === 'Ctrl+Plus' && step.instruction === 'Press Ctrl+Plus', `a fenced answer is read and leaked reasoning is cut (got "${step.text}" / "${step.instruction}")`);
  plan = { 'gemini-3.7-flash': [{ reply: geminiAnswer({ status: 'step', action: 'key', text: 'Ctrl+PlusFunctionality: zooms in text', instruction: 'Press Ctrl+Plus ➕\nContext: user wants...' }) }] };
  step = await ask();
  check(step.text === 'Ctrl+Plus' && step.instruction === 'Press Ctrl+Plus', `a combo glued to reasoning falls back to the instruction (got "${step.text}" / "${step.instruction}")`);

  // The screenshot is sent smaller than the screen: the element list uses the screenshot's pixels.
  calls = [];
  plan = { 'gemini-3.7-flash': [{ reply: geminiAnswer({ status: 'step', action: 'click', element_id: 1, instruction: 'Bold 🅱️' }) }] };
  step = await ask({ imageSize: { width: 768, height: 432 } });
  const sent = calls.find((c) => c.model === 'gemini-3.7-flash').body.contents[0].parts[1].text;
  check(/Screenshot: 768x432/.test(sent) && /1 Button "Bold" disabled \(100,45 15x15\)/.test(sent), 'with a half-size screenshot, element positions are halved too');
  check(step.target && step.target.rect.x === 1736, '...but the target Lefty points at stays in screen coordinates');

  // Warm-up when Lefty is summoned: a tiny text-only request (no screenshot) to the two models a real ask would
  // use, at most once every two minutes.
  brain.useFetch(fakeFetch); // also forgets the last warm-up
  calls = [];
  plan = {};
  await brain.warmUp();
  check(calls.length === 2 && calls.every((c) => c.body.contents[0].parts.every((p) => !p.inlineData)), `the warm-up asks two models with text only, no screenshot (asked ${calls.length})`);
  calls = [];
  await brain.warmUp();
  check(calls.length === 0, 'a second summon soon after sends no warm-up');

  // The goal is about another app: the brain is told what's open and can answer "open_app".
  calls = [];
  plan = { 'gemini-3.6-flash': [{ reply: geminiAnswer({ status: 'step', action: 'open_app', app: 'Visual Studio Code', instruction: 'Open VS Code 🚀' }) }] };
  step = await ask({ goal: 'download the python extension in vscode', app: 'your desktop', openApps: [{ app: 'VS Code', title: 'basics.py - python - Visual Studio Code' }, { app: 'Spotify', title: 'Spotify Premium' }] });
  const prompt = calls[0].body.contents[0].parts[1].text;
  check(/App in front: your desktop/.test(prompt) && /Other open apps: VS Code \("basics\.py - python - Visual Studio Code"\), Spotify/.test(prompt), 'the brain is told which app is in front and which others are open');
  check(step.action === 'open_app' && step.app === 'Visual Studio Code' && step.target === null, 'an "open_app" answer names the app and points at nothing');
  check(/"text box \(unlabelled\)"/.test(brain.describeElements([{ name: 'The editor is not accessible at this time. To enable screen reader...', type: 'Edit', rect: { x: 0, y: 0, w: 10, h: 10 } }], display.bounds ? { ...display, bounds: { x: 0, y: 0 } } : display)),
    'a text box with a useless name is described as a text box');

  // Code to write: the whole code comes back, cleaned for typing over (fences, tabs, trailing spaces, blank ends).
  calls = [];
  plan = { 'gemini-3.6-flash': [{ reply: geminiAnswer({ status: 'step', action: 'write_code', instruction: 'Type along with me 👻', element_id: 0, code: '```python\nclass Node:\n\tdef __init__(self):   \n\t\tself.next = None\n```\n' }) }] };
  step = await ask({ goal: 'single linked list', app: 'VS Code', title: 'Untitled-1 - Visual Studio Code' });
  check(step.action === 'write_code' && step.code === 'class Node:\n    def __init__(self):\n        self.next = None' && step.target === null,
    'a code answer comes back as plain code to type: no fences, 4-space indents, nothing to point at');
  check(/write_code/.test(calls[0].body.systemInstruction.parts[0].text) && /ghost text/.test(calls[0].body.systemInstruction.parts[0].text), 'the brain is told how to answer a request for code');
  check(brain.cleanCode('a\\n    b') === 'a\n    b' && brain.cleanCode('\n\nx = 1  \n\n') === 'x = 1', 'line breaks sent as "\\n" text and blank ends are fixed');
  calls = [];
  plan = { 'gemini-3.6-flash': [
    { reply: geminiAnswer({ status: 'step', action: 'write_code', instruction: 'Type 👻', code: '' }) },
    { reply: geminiAnswer({ status: 'step', action: 'write_code', instruction: 'Type 👻', code: 'print(1)' }) },
  ] };
  step = await ask({ goal: 'hello world' });
  check(calls.length === 2 && /code was empty/.test(calls[1].body.contents[0].parts[1].text) && step.code === 'print(1)', 'a code answer without code is asked again');

  // Code doctor: the file goes with line numbers; answers are checked against it.
  calls = [];
  const buggy = 'a = 2\nb==2\n\na + b';
  plan = { 'gemini-3.6-flash': [{ reply: geminiAnswer({
    problems: [
      { line: 4, message: 'b is undefined here', fixed: 'a + b' },                             // changes nothing: dropped
      { line: 2, end_line: 2, message: '== compares; use = to give b a value', fixed: '```python\n2| b = 2\n```' },
      { line: 9, message: 'past the end', fixed: 'x' },                                         // not a line of the file: dropped
    ],
    summary: 'One slip: == instead of =.',
  }) }] };
  const doctor = await brain.checkCode({ code: buggy, fileName: 'add.py', hint: 'Warnings: 2' });
  const doctorPrompt = calls[0].body.contents[0].parts[0].text;
  check(/1\| a = 2\n2\| b==2\n3\| \n4\| a \+ b/.test(doctorPrompt) && /File: add\.py/.test(doctorPrompt) && /The editor says: Warnings: 2/.test(doctorPrompt) && !calls[0].body.contents[0].parts.some((p) => p.inlineData),
    'the doctor sends the numbered file, its name and the editor\'s problem count (no screenshot)');
  check(/only the\s+cause/.test(calls[0].body.systemInstruction.parts[0].text), 'the doctor is told to report only the cause of a chain of errors');
  check(doctor.problems.length === 1 && doctor.problems[0].line === 2 && doctor.problems[0].endLine === 2 && doctor.problems[0].fixed === 'b = 2' && doctor.summary === 'One slip: == instead of =.',
    `fixes are cleaned (fences, copied line numbers) and fixes that change nothing or point past the file are dropped (${JSON.stringify(doctor.problems)})`);
  calls = [];
  plan = { 'gemini-3.6-flash': [{ reply: geminiAnswer({ problems: [
    { line: 1, end_line: 2, message: 'two lines', fixed: 'x = 1\ny = 2' }, { line: 2, message: 'overlaps', fixed: 'z' },
  ] }) }] };
  const overlapping = await brain.checkCode({ code: 'x=\ny=\nprint(x)' });
  check(overlapping.problems.length === 1 && overlapping.problems[0].endLine === 2, 'a fix overlapping the one before it is dropped');
  check(brain.cleanFix('  10| if x:\n  11|     go()') === 'if x:\n    go()' && brain.cleanFix('keep  \r\nthis') === 'keep\nthis', 'line numbers copied back and \\r endings are removed from fixes');

  // "Click Install" with nothing to point at: Lefty asks once more, telling the model to point.
  calls = [];
  plan = { 'gemini-3.6-flash': [
    { reply: geminiAnswer({ status: 'step', action: 'click', instruction: 'Click Install 📥' }) },
    { reply: geminiAnswer({ status: 'step', action: 'click', element_id: 0, instruction: 'Click Install 📥' }) },
  ] };
  step = await ask();
  check(calls.length === 2 && /gave no element_id or point/.test(calls[1].body.contents[0].parts[1].text) && step.target && step.target.name === 'File',
    'a click with nothing to point at is asked again, and the second answer points');

  // A guessed spot for a named thing that isn't in the list (Paint's colours behind "Show toolbar"): asked again,
  // told it's probably hidden; the second answer points at what reveals it.
  calls = [];
  plan = { 'gemini-3.6-flash': [
    { reply: geminiAnswer({ status: 'step', action: 'click', instruction: 'Pick red color 🔴', point: { x: 500, y: 500 } }) },
    { reply: geminiAnswer({ status: 'step', action: 'click', element_id: 0, instruction: 'Show the toolbar 🛠️' }) },
  ] };
  step = await ask({ goal: 'chose red colr' });
  check(calls.length === 2 && /nothing in the clickable list matches it/.test(calls[1].body.contents[0].parts[1].text) && step.target.name === 'File' && step.instruction === 'Show the toolbar',
    'a guessed spot for something not on the list is asked again as "probably hidden"');

  // A model out of quota rests for a while instead of being asked (and waited on) every time.
  brain.useFetch(fakeFetch); // a fresh start: no model resting from the tests above
  calls = [];
  plan = { 'gemini-3.6-flash': [{ reply: reply(429, { error: { message: 'You exceeded your current quota' } }) }], 'gemini-3.7-flash': [{ reply: geminiAnswer({ status: 'done', message: 'ok' }) }] };
  await ask();
  calls = [];
  plan = { 'gemini-3.7-flash': [{ reply: geminiAnswer({ status: 'done', message: 'ok' }) }] };
  await ask();
  check(calls[0].model === 'gemini-3.7-flash', 'a model that ran out of quota is skipped next time');

  // A private app: no screenshot goes out, the AI is told to use the list, and a point (a place in a picture it never
  // got) means nothing.
  brain.useFetch(fakeFetch);
  calls = [];
  plan = { 'gemini-3.6-flash': [
    { reply: geminiAnswer({ status: 'step', action: 'click', point: { x: 500, y: 500 }, instruction: 'Click OK' }) },
    { reply: geminiAnswer({ status: 'step', action: 'click', element_id: 0, instruction: 'Open File 📂' }) },
  ] };
  step = await ask({ jpeg: null, app: 'KeePass' });
  check(calls.every((c) => c.body.contents[0].parts.every((p) => !p.inlineData)), 'a private app: no picture in any request');
  check(/Screenshot: none \(a private app: use the clickable list only\)/.test(calls[0].body.contents[0].parts[0].text) && /no screenshot/.test(calls[0].body.systemInstruction.parts[0].text),
    'the AI is told there is no screenshot and to use the list');
  check(calls.length === 2 && /gave no element_id or point/.test(calls[1].body.contents[0].parts[0].text) && step.target && step.target.name === 'File',
    'a point without a picture is ignored and asked again; the list answer is used');
  check(/0 MenuItem "File" \(10,40 40x30\)/.test(calls[0].body.contents[0].parts[0].text), 'the list is in screen units when there is no screenshot to scale to');

  // A spoken goal: the recording goes with the screenshot in the same request, and the answer says what was heard.
  calls = [];
  const audio = { mime: 'audio/wav', data: Buffer.from('RIFF fake wav').toString('base64') };
  plan = { 'gemini-3.6-flash': [{ reply: geminiAnswer({ status: 'step', action: 'click', element_id: 0, instruction: 'फ़ाइल खोलें 📂', heard: 'फ़ाइल मेनू खोलो', lang: 'hi' }) }] };
  step = await ask({ goal: '', audio });
  let voiceParts = calls[0].body.contents[0].parts;
  check(voiceParts[0].inlineData.mimeType === 'image/jpeg' && voiceParts[1].inlineData.mimeType === 'audio/wav' && voiceParts[1].inlineData.data === audio.data,
    'a spoken goal: the screenshot and the recording go in one request');
  check(/Goal: spoken in the voice recording/.test(voiceParts[2].text), 'the prompt says the goal is in the recording');
  check(step.heard === 'फ़ाइल मेनू खोलो' && step.lang === 'hi' && step.instruction === 'फ़ाइल खोलें' && step.target.name === 'File', 'the answer says what was heard, in which language, and the step in that language');
  check(/language of the goal/.test(calls[0].body.systemInstruction.parts[0].text) && calls[0].body.generationConfig.responseSchema.properties.heard, 'the AI is asked to answer in the user\'s language and to say what it heard');
  calls = [];
  plan = { 'gemini-3.6-flash': [{ reply: geminiAnswer({ status: 'done', message: 'ok', heard: 'made up', lang: 'english please' }) }] };
  step = await ask({ goal: 'open the file' });
  check(step.heard === '' && step.lang === '', 'a typed goal never has a "heard", and a language that is not a code is dropped');
  check(calls[0].body.contents[0].parts.length === 2, 'a typed goal sends no audio');
  plan = { 'gemini-3.6-flash': [{ reply: geminiAnswer({ status: 'done', message: 'ok' }) }] };
  calls = [];
  await ask({ goal: 'x', audio: { mime: 'text/html', data: 'PGI+' } });
  check(calls[0].body.contents[0].parts.every((p) => !p.inlineData || p.inlineData.mimeType === 'image/jpeg'), 'something that is not audio is never sent as the recording');
  calls = [];
  plan = { 'gemini-3.6-flash': [{ reply: geminiAnswer({ status: 'step', action: 'click', element_id: 0, instruction: 'Open File', heard: 'open file' }) }] };
  await ask({ goal: '', audio, jpeg: null });
  voiceParts = calls[0].body.contents[0].parts;
  check(voiceParts.length === 2 && voiceParts[0].inlineData.mimeType === 'audio/wav', 'spoken in a private app: the recording goes, the screenshot does not');

  // "What does this do?"
  calls = [];
  plan = { 'gemini-3.6-flash': [{ reply: geminiAnswer({ explanation: '  Empties the  Recycle Bin for good.\nYou cannot get the files back. ', risky: true }) }] };
  let said = await brain.explain({ app: 'File Explorer', title: 'Recycle Bin', element: { name: 'Empty Recycle Bin', type: 'Button' }, nearby: ['Restore all items', 'Properties'], jpeg, spot: { x: 170.4, y: 90.2, w: 120, h: 30 }, lang: 'en' });
  const explainCall = calls[0];
  const explainText = explainCall.body.contents[0].parts[1].text;
  check(explainCall.body.contents[0].parts[0].inlineData.data === jpeg.toString('base64'), 'explain: the picture of the area goes with it');
  check(/The control: Button "Empty Recycle Bin"/.test(explainText) && /Around it: "Restore all items", "Properties"/.test(explainText) && /at 170,90 \(120x30 pixels\)/.test(explainText) && /App: File Explorer/.test(explainText),
    'explain: the control, what is around it and where it is in the picture');
  check(said.text === 'Empties the Recycle Bin for good. You cannot get the files back.' && said.risky === true, 'explain: one tidy answer, flagged as risky');
  check(/one or two short, plain sentences/.test(explainCall.body.systemInstruction.parts[0].text), 'explain: asked for one or two plain sentences');
  calls = [];
  plan = { 'gemini-3.6-flash': [{ reply: geminiAnswer({ explanation: 'Guarda el archivo.' }) }] };
  said = await brain.explain({ app: 'KeePass', element: { name: 'Save', type: 'Button' }, jpeg: null, lang: 'es' });
  check(calls[0].body.contents[0].parts.length === 1 && /No picture/.test(calls[0].body.contents[0].parts[0].text) && /lang: es/.test(calls[0].body.contents[0].parts[0].text) && said.risky === false,
    'explain in a private app: no picture, and the answer in the user\'s language');
  plan = { 'gemini-3.6-flash': [{ reply: geminiAnswer({ explanation: '   ' }) }] };
  error = await brain.explain({ element: { name: 'Save', type: 'Button' } }).catch((e) => e);
  check(error instanceof Error && /no explanation/.test(error.message), 'explain: an empty answer is an error, not a blank tip');

  // Focus mode: the time and the work apps come back tidy, and nothing is pointed at.
  calls = [];
  plan = { 'gemini-3.6-flash': [{ reply: geminiAnswer({ status: 'step', action: 'focus', instruction: 'Focus mode 🎯', element_id: 1, minutes: 900, allow: ['Chrome', '  physics tab  ', '', ...Array.from({ length: 12 }, (_, i) => `app${i}`)] }) }] };
  step = await ask({ goal: 'focus for 15 hours on chrome and my physics tab' });
  check(step.action === 'focus' && step.minutes === 480 && step.allow.length === 10 && step.allow[1] === 'physics tab' && step.target === null,
    'focus: at most 8 hours and 10 work apps, nothing to point at');
  check(/action "focus" with minutes/.test(calls[0].body.systemInstruction.parts[0].text), 'focus: the AI is told how to start focus mode');

  // Building a project: the whole request comes back as what to build.
  plan = { 'gemini-3.6-flash': [{ reply: geminiAnswer({ status: 'step', action: 'build_project', instruction: 'Building it 🛠️', text: 'A portfolio website.\nDark theme, with a contact form.' }) }] };
  step = await ask({ goal: 'build me a portfolio website, dark theme, with a contact form' });
  check(step.action === 'build_project' && /Dark theme, with a contact form/.test(step.text) && step.target === null, 'build_project: the full description of what to build');

  // The files of a project: whole files, every path inside the folder.
  calls = [];
  plan = { 'gemini-3.6-flash': [{ reply: geminiAnswer({ summary: 'A dark portfolio site.', run: 'Open index.html in your browser.\nThen enjoy.', files: [
    { path: 'index.html', content: '<!doctype html>\r\n<title>Me</title>' },
    { path: 'css\\style.css', content: 'body { background: #111; }' },
    { path: '../outside.txt', content: 'nope' },
    { path: 'C:/Windows/evil.txt', content: 'nope' },
    { path: '.env', content: 'KEY=1' },
    { path: '.git/config', content: 'nope' },
    { path: 'con.txt', content: 'nope' },
    { path: 'js/app.js', content: 42 },
  ] }) }] };
  const built = await brain.buildProject({ request: 'a portfolio site', files: [{ path: 'README.md', content: '# Old readme' }], lang: 'en' });
  const buildText = calls[0].body.contents[0].parts[0].text;
  check(built.files.map((f) => f.path).join('|') === 'index.html|css/style.css' && built.files[0].content === '<!doctype html>\n<title>Me</title>',
    'build: only files inside the folder are kept (no .., drives, .env, .git or Windows names), with plain line breaks');
  check(built.summary === 'A dark portfolio site.' && built.run === 'Open index.html in your browser.', 'build: a summary and one line on how to run it');
  check(/Build: a portfolio site/.test(buildText) && /--- README\.md\n# Old readme/.test(buildText), 'build: the AI sees what to build and the files already there');
  check(calls[0].body.generationConfig.maxOutputTokens === 65536 && calls[0].body.generationConfig.thinkingConfig.thinkingLevel === 'high', 'build: room for many files, and the model\'s best thinking');
  // A step on screen has one right answer; a design does not. At the step temperature the same request came
  // back as near enough the same files every time, which is why "make it better" changed nothing.
  check(calls[0].body.generationConfig.temperature > 0.8, `build: room to come back with something different (${calls[0].body.generationConfig.temperature})`);
  plan = { 'gemini-3.6-flash': [{ reply: geminiAnswer({ summary: 'x', files: [{ path: '/etc/passwd', content: 'x' }] }) }] };
  error = await brain.buildProject({ request: 'x' }).catch((e) => e);
  check(error instanceof Error && /no files/.test(error.message), 'build: an answer with no usable file is an error');
  check(brain.safePath('src\\app.js') === 'src/app.js' && brain.safePath('./a.css') === 'a.css' && brain.safePath('a/../b') === '' && brain.safePath('~/x') === '' && brain.safePath('x/.env.local') === '',
    'safePath: backslashes and ./ are fine; .., home folders and .env files are not');

  // LEFTY_MODEL pins one model.
  process.env.LEFTY_MODEL = 'gemini-3.6-flash';
  calls = [];
  plan = { 'gemini-3.6-flash': [{ reply: geminiAnswer({ status: 'done', message: 'ok' }) }] };
  await ask();
  check(calls.length === 1 && calls[0].model === 'gemini-3.6-flash', 'LEFTY_MODEL pins the model');
  delete process.env.LEFTY_MODEL;
  delete process.env.GEMINI_API_KEY;

  console.log(failed ? `\n${failed} brain checks failed.` : '\nAll brain checks passed.');
  process.exitCode = failed ? 1 : 0;
})();

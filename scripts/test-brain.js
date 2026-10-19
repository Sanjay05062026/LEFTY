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
  check(step.instruction === 'Make it bold 🅱️' && step.status === 'step', 'the instruction comes through');
  plan = { 'gemini-3.6-flash': [1, 2].map(() => ({ reply: geminiAnswer({ status: 'step', action: 'click', element_id: 7, instruction: 'Nope' }) })) };
  step = await ask({ goal: 'x' });
  check(step.target === null, 'an element id that does not exist points at nothing (never a wrong element)');
  plan = { 'gemini-3.6-flash': [{ reply: geminiAnswer({ status: 'done', message: 'All bold now!' }) }] };
  step = await ask({ goal: 'x' });
  check(step.status === 'done' && step.message === 'All bold now!', 'done comes back with its message');
  calls = [];

  // Quality first: the best model is asked alone, and when it answers in time nobody else is asked.
  brain.useHedge(80);
  plan = { 'gemini-3.6-flash': [{ delay: 10, reply: geminiAnswer({ status: 'step', action: 'click', element_id: 0, instruction: 'Open File 📂' }) }] };
  step = await ask();
  await sleep(120);
  check(calls.map((c) => c.model).join(',') === 'gemini-3.6-flash', `the best model is asked first, alone (asked ${calls.map((c) => c.model).join(', ')})`);
  check(step.instruction === 'Open File 📂' && step.target && step.target.name === 'File', 'its answer is used');
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
  check(error && error.status === 503 && calls.length <= 4, `when every model is busy, Lefty gives up after ${calls.length} tries with a "busy" error`);

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
  check(step.text === 'Ctrl+Plus' && step.instruction === 'Press Ctrl+Plus ⌨️', `a fenced answer is read and leaked reasoning is cut (got "${step.text}" / "${step.instruction}")`);
  plan = { 'gemini-3.7-flash': [{ reply: geminiAnswer({ status: 'step', action: 'key', text: 'Ctrl+PlusFunctionality: zooms in text', instruction: 'Press Ctrl+Plus ➕\nContext: user wants...' }) }] };
  step = await ask();
  check(step.text === 'Ctrl+Plus' && step.instruction === 'Press Ctrl+Plus ➕', `a combo glued to reasoning falls back to the instruction (got "${step.text}" / "${step.instruction}")`);

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
  check(calls.length === 2 && /nothing in the clickable list matches it/.test(calls[1].body.contents[0].parts[1].text) && step.target.name === 'File' && step.instruction === 'Show the toolbar 🛠️',
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

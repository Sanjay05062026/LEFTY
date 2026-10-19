// Checks Lefty's backend (server/index.js) and the app's side of it (src/brain-remote.js) with real HTTP requests to a
// local server and a fake AI, so no key or money is needed. Run: npm run test:server

const { createServer, createLimiter } = require('../server');
const remote = require('../src/brain-remote');

let failed = 0;
function check(condition, message) {
  if (!condition) failed += 1;
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${message}`);
}

function fakeBrain() {
  const brain = {
    inputs: [],
    failWith: null,
    isReady: true,
    warmed: 0,
    ready: () => brain.isReady,
    label: () => 'fake: test',
    setting: () => null,
    warmUp: async () => { brain.warmed += 1; },
    nextStep: async (input) => {
      brain.inputs.push(input);
      if (brain.failWith) throw brain.failWith;
      return { status: 'step', action: 'click', instruction: 'Click File 📁', text: '', message: '', app: '', code: '', target: { name: 'File', type: 'MenuItem', rect: { x: 10, y: 20, w: 30, h: 15 } }, usage: { input: 5, output: 2 } };
    },
  };
  return brain;
}

function listen(options) {
  const logs = [];
  const server = createServer({ log: (line) => logs.push(line), ...options });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, logs, url: `http://127.0.0.1:${server.address().port}` })));
}

const display = { id: 7, scaleFactor: 1.25, bounds: { x: 0, y: 0, width: 1536, height: 864 }, size: { width: 1536, height: 864 }, workArea: {} };
const request = (extra = {}) => ({ goal: 'save my secret plan', history: ['Open File'], note: '', app: 'Notepad', title: 'plan.txt - Notepad', elements: [{ name: 'File', type: 'MenuItem', rect: { x: 10, y: 20, w: 30, h: 15 } }], display, jpeg: Buffer.from('fake jpeg bytes'), imageSize: { width: 1024, height: 576 }, openApps: [], ...extra });

async function main() {
  // The app asks the server; the server asks the brain with exactly what the app would have used itself.
  let brain = fakeBrain();
  let { server, logs, url } = await listen({ brain, token: null, limits: {} });
  process.env.LEFTY_SERVER = `${url}/`;
  remote.setDevice('device-1234567890');
  check(remote.ready() && remote.label() === `server: ${new URL(url).host}`, 'LEFTY_SERVER switches the app to the server');
  const step = await remote.nextStep(request());
  check(step.instruction === 'Click File 📁' && step.target.rect.x === 10 && step.ok === undefined, 'the step comes back through the server unchanged');
  const got = brain.inputs[0];
  check(Buffer.isBuffer(got.jpeg) && got.jpeg.toString() === 'fake jpeg bytes', 'the screenshot arrives as the same bytes');
  check(got.display.bounds.width === 1536 && got.display.scaleFactor === undefined && got.goal === 'save my secret plan' && got.imageSize.width === 1024,
    'the brain gets the goal, screen size and screenshot size (only the display fields it needs)');
  check(logs.length === 1 && !/secret|plan|Notepad|File/.test(logs.join('\n')) && /device device-1/.test(logs[0]), 'the log has no goal, app or answer: only route, status, time and a short device id');
  await remote.warmUp();
  check(brain.warmed === 1, 'a warm-up reaches the server');
  brain.checkCode = async (input) => { brain.checked = input; return { problems: [{ line: 2, endLine: 2, message: 'use =', fixed: 'b = 2' }], summary: 'one slip' }; };
  const checked = await remote.checkCode({ code: 'a = 2\nb==2', fileName: 'add.py', hint: 'Warnings: 1' });
  check(checked.problems[0].fixed === 'b = 2' && checked.ok === undefined && brain.checked.code === 'a = 2\nb==2' && brain.checked.fileName === 'add.py',
    'the code doctor works through the server too');
  check(!/b==2|add\.py/.test(logs.join('\n')), 'the server log never shows the code or the file name');

  // Health, bad requests, too big.
  let res = await fetch(`${url}/health`);
  let body = await res.json();
  check(res.status === 200 && body.ok && body.brain === 'fake: test', '/health says it is up and which AI it uses');
  res = await fetch(`${url}/v1/step`, { method: 'POST', body: JSON.stringify({ goal: '' }) });
  check(res.status === 400, 'a step without a goal is refused (400)');
  res = await fetch(`${url}/v1/step`, { method: 'POST', body: 'not json' });
  check(res.status === 400, 'a body that is not JSON is refused (400)');
  res = await fetch(`${url}/v1/nope`, { method: 'POST', body: '{}' });
  check(res.status === 404, 'unknown routes are 404');
  res = await fetch(`${url}/v1/step`, { method: 'POST', body: 'x'.repeat(9 * 1024 * 1024) }).catch((error) => ({ status: 'closed', error }));
  check(res.status === 413 || res.status === 'closed', `a huge request is cut off (${res.status})`);

  // The AI's problems become the right answers for the app.
  brain.failWith = Object.assign(new Error('quota'), { status: 429, retryAfterMs: 7000 });
  let error = await remote.nextStep(request()).catch((e) => e);
  check(error.remote && error.status === 429 && error.retryAfterMs === 7000, 'an AI "slow down" reaches the app as 429 with the wait');
  brain.failWith = Object.assign(new Error('API key not valid'), { status: 401 });
  error = await remote.nextStep(request()).catch((e) => e);
  check(error.remote && error.status === 502 && !/API key not valid/.test(error.message), "the server's own bad key is a server problem (502), not the app's");
  brain.failWith = null;
  brain.isReady = false;
  error = await remote.nextStep(request()).catch((e) => e);
  check(error.remote && error.status === 503, 'a server without an AI key says so (503)');
  server.close();

  // An app token, when the server sets one.
  brain = fakeBrain();
  ({ server, url } = await listen({ brain, token: 'let-me-in', limits: {} }));
  process.env.LEFTY_SERVER = url;
  error = await remote.nextStep(request()).catch((e) => e);
  check(error.remote && error.status === 401 && brain.inputs.length === 0, 'without the app token the server refuses (401) and never asks the AI');
  process.env.LEFTY_APP_TOKEN = 'let-me-in';
  check((await remote.nextStep(request())).instruction === 'Click File 📁', 'with the right token it answers');
  delete process.env.LEFTY_APP_TOKEN;
  server.close();

  // Limits per device, only when set.
  brain = fakeBrain();
  ({ server, url } = await listen({ brain, token: null, limits: { perMinute: 2 } }));
  process.env.LEFTY_SERVER = url;
  await remote.nextStep(request());
  await remote.nextStep(request());
  error = await remote.nextStep(request()).catch((e) => e);
  check(error.status === 429 && error.retryAfterMs > 0 && brain.inputs.length === 2, 'over the per-minute limit: 429 with how long to wait');
  remote.setDevice('another-device');
  check((await remote.nextStep(request())).instruction, 'another device has its own limit');
  server.close();

  let clock = 0;
  const limiter = createLimiter({ perDay: 3, now: () => clock });
  const taken = [1, 2, 3, 4].map(() => { clock += 1000; return limiter.take('a'); });
  check(taken.slice(0, 3).every((t) => t === null) && taken[3].retryAfterMs > 0, 'the per-day limit counts a whole day');
  clock += 24 * 60 * 60 * 1000;
  check(limiter.take('a') === null, 'a day later the device can go again');
  check(createLimiter({}).take('a') === null, 'no limits set: never limited');

  // Not running at all: a plain network error, which the app shows as "couldn't reach my brain".
  process.env.LEFTY_SERVER = url; // closed above
  error = await remote.nextStep(request()).catch((e) => e);
  check(/fetch failed|ECONNREFUSED/i.test(`${error.message} ${error.cause && error.cause.code}`), 'a server that is down is a network error');
  delete process.env.LEFTY_SERVER;
  check(!remote.ready(), 'without LEFTY_SERVER the app uses its own key as before');

  console.log(failed ? `\n${failed} check(s) failed` : '\nAll server checks passed.');
  process.exit(failed ? 1 : 0);
}

main().catch((error) => { console.error(error); process.exit(1); });

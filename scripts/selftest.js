// End-to-end check of the Ctrl+Space flow without showing any window or touching the keyboard:
// summon Lefty silently, let him read the taskbar, ask for "start" and check he rings the Start button.
// Run: npm run selftest

const eyes = require('../src/eyes');
const { taskbarHandle } = require('./taskbar');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(read, isDone, timeoutMs, what) {
  const end = Date.now() + timeoutMs;
  let value;
  while (Date.now() < end) {
    value = await read();
    if (isDone(value)) return value;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what} (last value: ${JSON.stringify(value)})`);
}

async function run({ app, overlayWindow, showLefty, toDip, handleClick, getTarget }) {
  const js = (code) => overlayWindow.webContents.executeJavaScript(code);
  const submit = (text) => js(`document.getElementById('goal').value = ${JSON.stringify(text)}; document.getElementById('ask').requestSubmit(); true`);
  const lastMessage = () => js("document.querySelector('#messages .msg:last-child').textContent");
  const waitForMessage = (pattern, what) => waitFor(lastMessage, (text) => pattern.test(text), 6000, what);
  const tagText = () => js("document.getElementById('steptag').classList.contains('show') ? document.getElementById('steptag').textContent : ''");
  const waitForTag = (pattern, what) => waitFor(tagText, (text) => pattern.test(text), 6000, what);
  const bubbleTucked = () => js("document.getElementById('bubble').classList.contains('tucked')");
  const messageCount = () => js("document.querySelectorAll('#messages .msg').length");
  const centre = (r) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
  const check = (condition, message) => {
    if (!condition) throw new Error(message);
    console.log(`[selftest] ok   ${message}`);
  };
  overlayWindow.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2) console.log('[selftest] overlay error:', message);
  });

  try {
    if (overlayWindow.webContents.isLoading()) await new Promise((resolve) => overlayWindow.webContents.once('did-finish-load', resolve));
    const hwnd = taskbarHandle();
    check(hwnd > 0, 'found the taskbar');

    showLefty({ silent: true, hwnd });
    const greeting = await waitFor(() => js("document.getElementById('messages').textContent"),
      (text) => /I can see/.test(text), 10000, 'the greeting to name the app');
    check(true, `greeting updated: "${greeting}"`);

    await js("document.getElementById('goal').value = 'click the start button'; document.getElementById('ask').requestSubmit(); true");
    await waitFor(() => js("document.getElementById('ring').classList.contains('show')"), Boolean, 5000, 'the highlight ring');

    // Where the Start button really is, measured independently of the overlay.
    const shot = await eyes.snapshot(hwnd);
    const start = shot.elements.find((el) => el.name === 'Start');
    check(start, 'Start button exists in the taskbar read');
    const expected = toDip(start.rect);
    const origin = overlayWindow.getBounds();

    // Read the positions Lefty set, not the painted ones: a hidden window never plays the zoom/glide animations.
    const state = await js(`(() => {
      const box = (id) => {
        const el = document.getElementById(id);
        return { x: parseFloat(el.style.left), y: parseFloat(el.style.top), w: el.offsetWidth, h: el.offsetHeight };
      };
      return { ring: box('ring'), lefty: box('lefty'), bubble: box('bubble'), tag: box('steptag'),
               tagText: document.getElementById('steptag').textContent,
               last: document.querySelector('#messages .msg:last-child').textContent };
    })()`);

    check(state.tagText === 'Start', `the step shows on screen, on a tag next to Lefty: "${state.tagText}"`);
    check(await bubbleTucked(), 'the chat bubble steps aside while Lefty guides');
    check(state.last === 'click the start button', 'no step chatter in the chat: the last message is still the user\'s goal');
    const near = (a, b) => Math.abs(a - b) <= 2;
    const pad = 4;
    check(near(state.ring.x, expected.x - origin.x - pad) && near(state.ring.y, expected.y - origin.y - pad)
      && near(state.ring.w, expected.w + pad * 2) && near(state.ring.h, expected.h + pad * 2),
    `ring sits on the Start button (ring ${JSON.stringify(state.ring)}, button ${JSON.stringify(expected)}, screen origin ${origin.x},${origin.y})`);

    const tipX = state.lefty.x + 5;
    const tipY = state.lefty.y + 5;
    const inside = tipX >= expected.x - origin.x && tipX <= expected.x - origin.x + expected.w
      && tipY >= expected.y - origin.y && tipY <= expected.y - origin.y + expected.h;
    check(inside, `Lefty's tip is inside the Start button (${Math.round(tipX)},${Math.round(tipY)})`);

    const overlapsRing = (b) => b.x < state.ring.x + state.ring.w && b.x + b.w > state.ring.x && b.y < state.ring.y + state.ring.h && b.y + b.h > state.ring.y;
    check(!overlapsRing(state.bubble), 'the chat bubble (when it comes back) does not cover the button');
    check(!overlapsRing(state.tag), `the step tag does not cover the button (tag ${JSON.stringify(state.tag)})`);

    await js("document.getElementById('goal').value = 'rename a file in pycharm'; document.getElementById('ask').requestSubmit(); true");
    const miss = await waitFor(() => js("document.querySelector('#messages .msg:last-child').textContent"),
      (text) => /can't spot/.test(text), 3000, 'the not-found reply');
    check(true, `unknown goal gets an honest reply: "${miss}"`);
    check(!(await bubbleTucked()) && (await tagText()) === '', 'a reply brings the chat back and clears the step tag');

    await submit("I'm stuck, what do I do next?");
    const stuck = await waitForMessage(/brain/, 'the stuck reply');
    check(getTarget() === null, `"I'm stuck" explains the brain is coming and points at nothing: "${stuck}"`);

    // Multi-step guide: start > search, with clicks simulated through the real click handler.
    const searchEl = shot.elements.find((el) => el.name === 'Search');
    check(searchEl, 'Search button exists in the taskbar read');
    const searchRect = toDip(searchEl.rect);

    await submit('start > search');
    const messagesAtStart = await messageCount();
    check(/^1\/2Start$/.test(await waitForTag(/1\/2/, 'step 1 tag')), 'guide starts: the tag shows "1/2 · Start"');
    await waitFor(async () => getTarget(), Boolean, 2000, 'the click target');
    check(JSON.stringify(getTarget()) === JSON.stringify(expected), 'click checking watches the Start button');

    handleClick({ x: origin.x + 5, y: origin.y + 5 }); // far away from Start
    await waitFor(() => js("document.getElementById('steptag').dataset.nudges"), (n) => Number(n) >= 1, 6000, 'the tag to wiggle after a missed click');
    check(getTarget() !== null && /^1\/2Start$/.test(await tagText()), 'a missed click wiggles the tag and Lefty keeps pointing at Start');

    const startPoint = centre(getTarget());
    handleClick(startPoint);
    handleClick(startPoint); // double-click: must not finish two steps
    check(/^2\/2Search$/.test(await waitForTag(/2\/2/, 'step 2 tag')), 'clicking Start moves on: the tag shows "2/2 · Search"');
    await waitFor(async () => getTarget(), Boolean, 2000, 'the second click target');
    check(JSON.stringify(getTarget()) === JSON.stringify(searchRect), 'click checking now watches the Search button');
    check(await bubbleTucked() && (await messageCount()) === messagesAtStart, 'the whole guide ran on screen: no chat messages, bubble tucked');

    handleClick(centre(getTarget()));
    check(/Done/.test(await waitForTag(/Done/, 'the done tag')), 'clicking Search finishes the goal: the tag shows "🎉 Done!"');
    check(getTarget() === null, 'nothing is watched after the goal is done');
    check(/What next/.test(await waitForMessage(/What next/, 'the chat to come back')), 'then the chat comes back, ready for the next goal');
    check(!(await bubbleTucked()), 'bubble is back after the goal');

    console.log('[selftest] All Ctrl+Space checks passed.');
    app.exit(0);
  } catch (error) {
    console.log(`[selftest] FAIL ${error.message}`);
    app.exit(1);
  }
}

module.exports = { run };

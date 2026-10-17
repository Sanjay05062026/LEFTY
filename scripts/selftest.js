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

async function run({ app, overlayWindow, showLefty, toDip }) {
  const js = (code) => overlayWindow.webContents.executeJavaScript(code);
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
      return { ring: box('ring'), lefty: box('lefty'), bubble: box('bubble'),
               last: document.querySelector('#messages .msg:last-child').textContent };
    })()`);

    check(state.last.includes('Start'), `Lefty says: "${state.last}"`);
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

    const b = state.bubble;
    const r = state.ring;
    const covers = b.x < r.x + r.w && b.x + b.w > r.x && b.y < r.y + r.h && b.y + b.h > r.y;
    check(!covers, 'the chat bubble does not cover the button');

    await js("document.getElementById('goal').value = 'rename a file in pycharm'; document.getElementById('ask').requestSubmit(); true");
    const miss = await waitFor(() => js("document.querySelector('#messages .msg:last-child').textContent"),
      (text) => /can't spot/.test(text), 3000, 'the not-found reply');
    check(true, `unknown goal gets an honest reply: "${miss}"`);

    console.log('[selftest] All Ctrl+Space checks passed.');
    app.exit(0);
  } catch (error) {
    console.log(`[selftest] FAIL ${error.message}`);
    app.exit(1);
  }
}

module.exports = { run };

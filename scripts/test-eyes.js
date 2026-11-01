// Checks Lefty's eyes without opening or focusing any window: reads the Windows taskbar.
// Run: npm run test:eyes

const eyes = require('../src/eyes');
const { taskbarHandle } = require('./taskbar');

function check(condition, message) {
  if (!condition) throw new Error(`FAIL: ${message}`);
  console.log(`ok   ${message}`);
}

(async () => {
  try {
    const hwnd = taskbarHandle();
    check(hwnd > 0, `found the taskbar window (${hwnd})`);

    const shot = await eyes.snapshot(hwnd);
    check(shot.window.hwnd === hwnd, `read the right window: "${shot.window.title}" (${shot.window.process})`);
    check(shot.elements.length > 0, `found ${shot.elements.length} clickable elements in ${shot.ms} ms`);
    check(shot.elements.every((e) => e.rect && e.rect.w > 0 && e.rect.h > 0), 'every element has a screen rectangle');
    console.log('     sample:', shot.elements.slice(0, 6).map((e) => `${e.type} "${e.name}"`).join(', '));

    const again = await eyes.snapshot(hwnd);
    check(again.elements.length > 0, `second read works too (${again.ms} ms, helper reused)`);

    const bad = await eyes.snapshot(1).then(() => null, (error) => error);
    check(bad && /no app window/.test(bad.message), 'a bad window gives a clear error, not a crash');

    // "What does this do?" asks what is at a point: the Start button, in the taskbar, from explorer.
    const start = shot.elements.find((e) => e.name === 'Start');
    if (start) {
      const at = { x: start.rect.x + start.rect.w / 2, y: start.rect.y + start.rect.h / 2 };
      const plain = await eyes.peek(at);
      check(plain.name === 'Start' && !('process' in plain), `a plain peek says only what is there: ${plain.type} "${plain.name}"`);
      const clicked = await eyes.peek(at, { clickable: true });
      check(clicked.name === 'Start' && clicked.type === 'Button' && /explorer/i.test(clicked.process) && clicked.lefty === false,
        `a "clickable" peek names the control and its app: ${clicked.type} "${clicked.name}" in ${clicked.process}`);
      check(clicked.rect && clicked.rect.w > 0 && clicked.windowRect && clicked.windowRect.w > 0 && clicked.password === false,
        'and says where the control and its window are');
    }

    // Reads whatever app is in front, so it is opt-in (never poke a game or a private window by surprise).
    if (process.env.LEFTY_TEST_FOREGROUND) {
      const current = await eyes.snapshot();
      check(current.window.hwnd > 0, `default mode reads your current app: "${current.window.title}" (${current.window.process})`);
    }

    console.log('\nAll eye checks passed.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    eyes.stop();
  }
})();

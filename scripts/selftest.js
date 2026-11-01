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

async function run({ app, mainWindow, overlayWindow, showLefty, toDip, handleClick, getTarget, autoActions, userInput }) {
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
    // The self-test keeps its own settings file: start from Learn mode at the normal size, whatever an earlier run left.
    const setSettings = async (changes) => {
      await js(`window.lefty.setSettings(${JSON.stringify(changes)})`);
      await waitFor(() => js('JSON.stringify(settings)'), (text) => Object.entries(changes).every(([k, v]) => JSON.stringify(JSON.parse(text)[k]) === JSON.stringify(v)), 3000, `settings ${JSON.stringify(changes)}`);
    };
    await setSettings({ mode: 'learn', size: 'normal' });
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
    // Taskbar icons are centred, so they slide sideways whenever a taskbar button comes or goes during the test (the
    // self-test's own Electron starting, a flyout opening): a fresh read may be one icon slot (up to ~40 px) away
    // from the read Lefty pointed from. Same size and row is still required, so Start can never pass for Search.
    const sameButton = (a, b) => Boolean(a && b) && Math.abs(a.x - b.x) <= 40 && Math.abs(a.y - b.y) <= 2
      && Math.abs(a.w - b.w) <= 2 && Math.abs(a.h - b.h) <= 2;
    const whereNow = async (name) => {
      const now = (await eyes.snapshot(hwnd)).elements.find((el) => el.name === name);
      return now ? toDip(now.rect) : null;
    };

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
    // The Start button as Lefty read it, the read he pointed from; it must be the one the fresh read finds.
    const seenStart = JSON.parse(await js("JSON.stringify(lastSeen.find((el) => el.name === 'Start') || null)"));
    check(sameButton(seenStart && seenStart.rect, expected), `Lefty's read of Start is the Start button (his ${JSON.stringify(seenStart && seenStart.rect)}, fresh ${JSON.stringify(expected)})`);
    const pointed = seenStart.rect;
    check(near(state.ring.x, pointed.x - origin.x - pad) && near(state.ring.y, pointed.y - origin.y - pad)
      && near(state.ring.w, pointed.w + pad * 2) && near(state.ring.h, pointed.h + pad * 2),
    `ring sits on the Start button (ring ${JSON.stringify(state.ring)}, button ${JSON.stringify(pointed)}, screen origin ${origin.x},${origin.y})`);

    const tip = await js('leftySize.tip');
    check(state.lefty.w === 40 && tip === 3, `Lefty is drawn at the normal size: ${state.lefty.w}x${state.lefty.h}, tip ${tip} px in`);
    const tipX = state.lefty.x + tip;
    const tipY = state.lefty.y + tip;
    const inside = tipX >= pointed.x - origin.x && tipX <= pointed.x - origin.x + pointed.w
      && tipY >= pointed.y - origin.y && tipY <= pointed.y - origin.y + pointed.h;
    check(inside, `Lefty's tip is inside the Start button (${Math.round(tipX)},${Math.round(tipY)})`);

    const overlapsRing = (b) => b.x < state.ring.x + state.ring.w && b.x + b.w > state.ring.x && b.y < state.ring.y + state.ring.h && b.y + b.h > state.ring.y;
    check(!overlapsRing(state.bubble), 'the chat bubble (when it comes back) does not cover the button');
    check(!overlapsRing(state.tag), `the step tag does not cover the button (tag ${JSON.stringify(state.tag)})`);

    await js("document.getElementById('goal').value = 'rename a file in pycharm'; document.getElementById('ask').requestSubmit(); true");
    const miss = await waitFor(() => js("document.querySelector('#messages .msg:last-child').textContent"),
      (text) => /can't spot/.test(text), 3000, 'the not-found reply');
    check(true, `unknown goal gets an honest reply: "${miss}"`);
    check(!(await bubbleTucked()) && (await tagText()) === '', 'a reply brings the chat back and clears the step tag');

    await submit('save this');
    const cantSave = await waitForMessage(/Ctrl\+S/, 'the save goal reply on a screen with nothing to save');
    check(getTarget() === null, `a "save" goal where nothing can be saved says so honestly: "${cantSave}"`);

    await submit("I'm stuck, what do I do next?");
    const stuck = await waitForMessage(/AI isn't connected/, 'the stuck reply');
    check(getTarget() === null, `"I'm stuck" explains the AI isn't connected and points at nothing: "${stuck}"`);

    // Multi-step guide: start > search, with clicks simulated through the real click handler.
    const searchEl = shot.elements.find((el) => el.name === 'Search');
    check(searchEl, 'Search button exists in the taskbar read');
    const searchRect = toDip(searchEl.rect);

    await submit('start > search');
    const messagesAtStart = await messageCount();
    check(/^1\/2Start$/.test(await waitForTag(/1\/2/, 'step 1 tag')), 'guide starts: the tag shows "1/2 · Start"');
    await waitFor(async () => getTarget(), Boolean, 2000, 'the click target');
    const watched = getTarget();
    const startNow = await whereNow('Start');
    check(sameButton(watched, startNow), `click checking watches the Start button (${JSON.stringify(watched)} vs read ${JSON.stringify(startNow)})`);

    handleClick({ x: origin.x + 5, y: origin.y + 5 }); // far away from Start
    await waitFor(() => js("document.getElementById('steptag').dataset.nudges"), (n) => Number(n) >= 1, 6000, 'the tag to wiggle after a missed click');
    check(getTarget() !== null && /^1\/2Start$/.test(await tagText()), 'a missed click wiggles the tag and Lefty keeps pointing at Start');

    const startPoint = centre(getTarget());
    handleClick(startPoint);
    handleClick(startPoint); // double-click: must not finish two steps
    check(/^2\/2Search$/.test(await waitForTag(/2\/2/, 'step 2 tag')), 'clicking Start moves on: the tag shows "2/2 · Search"');
    await waitFor(async () => getTarget(), Boolean, 2000, 'the second click target');
    const watchedNext = getTarget();
    const searchNow = await whereNow('Search');
    check(sameButton(watchedNext, searchNow), `click checking now watches the Search button (${JSON.stringify(watchedNext)} vs read ${JSON.stringify(searchNow)})`);
    check(await bubbleTucked() && (await messageCount()) === messagesAtStart, 'the whole guide ran on screen: no chat messages, bubble tucked');

    handleClick(centre(getTarget()));
    check(/Done/.test(await waitForTag(/Done/, 'the done tag')), 'clicking Search finishes the goal: the tag shows "🎉 Done!"');
    check(getTarget() === null, 'nothing is watched after the goal is done');
    check(/What next/.test(await waitForMessage(/What next/, 'the chat to come back')), 'then the chat comes back, ready for the next goal');
    check(!(await bubbleTucked()), 'bubble is back after the goal');

    // ----- Do it mode: Lefty clicks for the user. Here his clicks are only recorded (main never presses anything in
    // the self-test), so the real Start menu never opens; the guide moves on exactly as after a real click. -----
    const chipState = () => js("(() => { const c = document.getElementById('modechip'); return { show: c.classList.contains('show'), text: c.textContent }; })()");
    const pickChoice = (label) => js(`(() => { const b = [...document.querySelectorAll('#messages .choices button')].find((x) => x.textContent === ${JSON.stringify(label)} && !x.disabled); if (b) b.click(); return Boolean(b); })()`);
    const startNowRect = await whereNow('Start');
    const searchNowRect = await whereNow('Search');

    await setSettings({ mode: 'auto' });
    check(await js("document.querySelector('#mode button.on').dataset.mode") === 'auto', 'the switch in the bubble shows Do it');
    autoActions.length = 0;
    await submit('start > search');
    await waitFor(async () => autoActions.length, (n) => n >= 2, 8000, 'Lefty to click Start, then Search');
    check(autoActions[0].act === 'click' && autoActions[0].expect === 'Start' && sameButton(autoActions[0].rect, startNowRect),
      `Do it: Lefty clicks Start himself, checking it's still called "Start" (${JSON.stringify(autoActions[0])})`);
    check(autoActions[1].expect === 'Search' && sameButton(autoActions[1].rect, searchNowRect), 'Do it: then he clicks Search');
    check(/Done/.test(await waitForTag(/Done/, 'the done tag in Do it mode')), 'Do it: the goal finishes with "Done!"');
    check(/What next/.test(await waitForMessage(/What next/, 'the chat after Do it')) && !/You did it/.test(await lastMessage()), 'Do it: the chat says what next, not "You did it"');
    check(autoActions.length === 2, 'Do it: exactly two clicks, nothing pressed twice');

    // The user's own click while Lefty works stops him; Continue carries on from where he was.
    autoActions.length = 0;
    await submit('start > search');
    await waitFor(async () => autoActions.length, (n) => n >= 1, 8000, 'the first click');
    userInput('mouse');
    const stopped = await waitForMessage(/took over/, 'the stop message after the user clicked');
    check(true, `a click from the user stops Lefty: "${stopped}"`);
    await sleep(1500);
    check(autoActions.length === 1, 'nothing more is clicked after he stopped');
    check(!(await bubbleTucked()) && !(await chipState()).show, 'the chat is back with Continue, and the Stop chip is gone');
    check(await pickChoice('Continue'), 'Continue is offered');
    await waitFor(async () => autoActions.length, (n) => n >= 2, 8000, 'the click after Continue');
    check(autoActions[1].expect === 'Search', 'after Continue, Lefty goes on with Search (Start was already done)');
    await waitForTag(/Done/, 'done after Continue');

    // Esc stops him too (and doesn't close him), and "Guide me instead" goes on in Learn mode.
    autoActions.length = 0;
    await submit('start > search');
    await waitFor(async () => autoActions.length, (n) => n >= 1, 8000, 'the first click');
    await js("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true");
    await waitForMessage(/Stopped/, 'the stop message after Esc');
    check(await js("document.getElementById('lefty').classList.contains('show')"), 'Esc while Lefty works stops him without closing him');
    check(await pickChoice('Guide me instead'), '"Guide me instead" is offered');
    check(/^2\/2Search$/.test(await waitForTag(/2\/2/, 'the Search step in Learn mode')), 'in Learn mode he points at Search for the user');
    check(await js('settings.mode') === 'learn' && autoActions.length === 1, 'the mode is Learn now, and Lefty clicks nothing himself');
    const chip = await waitFor(chipState, (c) => c.show, 3000, 'the Do it for me chip');
    check(/Do it for me/.test(chip.text), `Learn mode offers "${chip.text}" beside the step`);
    // The chip switches to Do it and Lefty does the step that's showing.
    await js("document.getElementById('modechip').click(); true");
    await waitFor(async () => autoActions.length, (n) => n >= 2, 8000, 'the click after "Do it for me"');
    check(autoActions[1].expect === 'Search' && await js('settings.mode') === 'auto', '"Do it for me" switches to Do it and Lefty clicks Search');
    await waitForTag(/Done/, 'done after Do it for me');
    await waitForMessage(/What next/, 'the chat after the chip run');

    // Size: Small and Large redraw Lefty (and the pointing maths follows the tip).
    await setSettings({ size: 'small' });
    check(await js("document.getElementById('lefty').offsetWidth") === 30 && await js('leftySize.tip') === 2, 'Small draws Lefty 30 px wide');
    await setSettings({ size: 'large' });
    check(await js("document.getElementById('lefty').offsetWidth") === 56, 'Large draws him 56 px wide');
    await setSettings({ mode: 'learn', size: 'normal' });
    const home = (code) => mainWindow.webContents.executeJavaScript(code);
    const lastMessages = (n) => js(`[...document.querySelectorAll('#messages .msg')].slice(-${n}).map((m) => m.textContent).join(' | ')`);

    // ----- Lefty talks: his words are read out without emoji. The page's speech is swapped for a recorder first, so
    // the self-test never makes a sound. -----
    await js('window.__spoken = []; speechSynthesis.speak = (u) => window.__spoken.push(u.text); speechSynthesis.cancel = () => {}; true');
    await setSettings({ speak: 'on' });
    check(await js("document.getElementById('speak').getAttribute('aria-pressed')") === 'true' && await home("document.querySelector('#pref-speak button.on').dataset.value") === 'on',
      '"Lefty talks" shows as on in the bubble and on the home screen');
    await submit('rename a file in pycharm');
    await waitForMessage(/can't spot/, 'a reply to read out');
    const spoken = await js('window.__spoken.slice(-1)[0] || ""');
    check(/^I can't spot "rename a file in pycharm" on this screen\./.test(spoken) && !/[\u{1F300}-\u{1FAFF}]/u.test(spoken), `his reply is read out, without emoji: "${spoken}"`);
    await setSettings({ speak: 'off' });
    const before = await js('window.__spoken.length');
    await submit('rename a file in pycharm');
    await sleep(800);
    check(await js('window.__spoken.length') === before, 'with "Lefty talks" off he stays quiet');

    // ----- "What does this do?": F1 over a control (main sends the mouse point) and the "What's this?" pick. Without a
    // brain (the self-test never calls one) Lefty still names the control. -----
    const tipState = () => js(`(() => {
      const t = document.getElementById('tip');
      const ringEl = document.getElementById('tip-ring');
      return { show: t.classList.contains('show'), text: t.textContent, x: parseFloat(t.style.left), y: parseFloat(t.style.top),
               ring: ringEl.classList.contains('show') ? { x: parseFloat(ringEl.style.left), y: parseFloat(ringEl.style.top) } : null };
    })()`);
    const startCentre = centre(startNowRect);
    overlayWindow.webContents.send('lefty:explain', startCentre);
    const explained = await waitFor(tipState, (t) => t.show && /Start/.test(t.text) && !/Let me look/.test(t.text), 5000, 'the explanation of Start');
    check(/"Start" is a button\. Connect the AI/.test(explained.text), `F1 over Start explains it beside it: "${explained.text}"`);
    check(explained.ring && Math.abs(explained.ring.x - (startNowRect.x - origin.x - 3)) <= 40, 'a dashed ring marks the control being explained');
    check(explained.y + 10 < startNowRect.y - origin.y, 'near the bottom of the screen the explanation goes above the control');
    await js(`document.dispatchEvent(new MouseEvent('mousemove', { clientX: 20, clientY: 20, bubbles: true })); true`);
    check(!(await tipState()).show, 'moving the mouse away clears it');
    overlayWindow.webContents.send('lefty:explain', { x: origin.x + 3, y: origin.y + 3 });
    check(/Rest the mouse on a button/.test((await waitFor(tipState, (t) => t.show, 3000, 'the hint')).text), 'F1 over nothing says how to use it');
    await js("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true");
    check(!(await tipState()).show && await js("document.getElementById('lefty').classList.contains('show')"), 'Esc clears the explanation first, without closing Lefty');

    await js("document.getElementById('whats-this').click(); true");
    const pickOn = await js("({ layer: document.getElementById('picklayer').classList.contains('show'), hint: document.getElementById('pickhint').classList.contains('show'), tucked: document.getElementById('bubble').classList.contains('tucked') })");
    check(pickOn.layer && pickOn.hint && pickOn.tucked, '"What\'s this?" waits for a click anywhere: hint on top, the chat out of the way');
    await sleep(400); // the fresh screen read
    await js(`document.getElementById('picklayer').dispatchEvent(new MouseEvent('click', { clientX: ${startCentre.x - origin.x}, clientY: ${startCentre.y - origin.y}, bubbles: true })); true`);
    const picked = await waitFor(tipState, (t) => t.show && /Start/.test(t.text), 5000, 'the picked explanation');
    check(/"Start" is a button/.test(picked.text) && !(await js("document.getElementById('picklayer').classList.contains('show')")) && !(await bubbleTucked()),
      'the click picks Start and explains it; the chat comes back');
    await js("document.getElementById('whats-this').click(); true");
    await js("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true");
    check(!(await js("document.getElementById('picklayer').classList.contains('show')")), 'Esc cancels the pick');

    // ----- Private apps: no screenshots there, and Lefty says so in his greeting. -----
    await setSettings({ privateApps: ['explorer', 'keepass'] });
    check(await home("[...document.querySelectorAll('#private-list .app-chip')].length") === 2, 'the home screen lists the private apps');
    showLefty({ silent: true, hwnd });
    const privateHello = await waitFor(() => js("document.getElementById('messages').textContent"), (t) => /private list/.test(t), 8000, 'the private greeting');
    check(/no screenshots/.test(privateHello), `in a private app (the taskbar is explorer) the greeting says so: "${privateHello}"`);
    await setSettings({ privateApps: [] });
    showLefty({ silent: true, hwnd });
    await waitFor(() => js("document.getElementById('messages').textContent"), (t) => /I can see/.test(t) && !/private/.test(t), 8000, 'the normal greeting');
    check(true, 'with the app off the list, the greeting is the usual one');

    // ----- Focus mode: typed, no brain needed. In the self-test main never checks or closes windows. -----
    await submit('focus 25 min on notepad and physics');
    check(/Focus mode on for 25 min\. Only notepad, physics/.test(await waitForMessage(/Focus mode on/, 'the focus reply')), 'typed "focus 25 min on notepad and physics": focus mode starts with those apps');
    const homeFocus = await waitFor(() => home("document.getElementById('focus-left').textContent"), (t) => /min left/.test(t), 3000, 'the home focus card');
    check(/2[45] min left/.test(homeFocus) && /notepad, physics/.test(await home("document.getElementById('focus-apps').textContent")), 'the home screen shows the time left and the work apps');
    await submit('stop focus mode');
    check(/Focus mode is off/.test(await waitForMessage(/Focus mode is off/, 'the stop reply')), '"stop focus mode" ends it');
    await submit('focus mode');
    await waitForMessage(/Which apps or tabs are for your work/, 'the work apps question');
    check(await js("Boolean(document.querySelector('.namebox input'))"), '"focus mode" with no apps named: Lefty asks which ones, in a box');
    // Something else came up: Lefty goes to its close button with a small tag, without his chat.
    await js("document.querySelector('.namebox input') && document.querySelector('.namebox input').blur()");
    const area = await js("({ width: innerWidth, height: innerHeight, originX: 0, originY: 0 })");
    overlayWindow.webContents.send('focus:block', { quiet: false, app: 'Steam', left: 600000, rect: { x: 300, y: 40, w: 20, h: 20 }, area, cursor: { x: 600, y: 400 } });
    const blockTag = await waitFor(() => js("document.getElementById('steptag').classList.contains('show') ? document.getElementById('steptag').textContent : ''"), (t) => /10 min left./.test(t), 3000, 'the focus tag');
    check(/(can wait|finish your work)/.test(blockTag)
      && await js("document.getElementById('bubble').classList.contains('tucked') && document.getElementById('ring').classList.contains('show')"),
    'when something is closed, Lefty goes to its close button and a small tag says why (the chat steps aside)');
    overlayWindow.webContents.send('focus:block-end', { quiet: false });
    await waitFor(() => js("!document.getElementById('steptag').classList.contains('show') && !document.getElementById('bubble').classList.contains('tucked')"), Boolean, 2000, 'the tag to go');
    check(true, 'afterwards the tag goes and the chat comes back');

    // ----- Voice: without a brain Lefty says so and never opens the microphone; the recording pipeline (decode, 16 kHz
    // WAV, base64) works in the page itself. -----
    overlayWindow.webContents.send('voice:hold', { on: true });
    await waitForMessage(/understand speech/, 'the no-brain voice reply');
    check(!(await js("document.getElementById('mic').classList.contains('listening')")), 'holding Ctrl+Space without a brain: Lefty explains, the microphone stays closed');
    overlayWindow.webContents.send('voice:hold', { on: false });
    const pipeline = await js(`(async () => {
      const rate = 48000;
      const tone = Float32Array.from({ length: rate }, (_, i) => 0.3 * Math.sin(2 * Math.PI * 300 * i / rate));
      const wav = LeftyVoice.toWav([tone], rate);
      const context = new AudioContext();
      const sound = await context.decodeAudioData(wav.buffer.slice(0));
      context.close();
      const again = LeftyVoice.toWav([sound.getChannelData(0)], sound.sampleRate);
      return { rate: sound.sampleRate, seconds: sound.duration, heard: LeftyVoice.heardSomething(sound.getChannelData(0), sound.sampleRate),
               b64: LeftyVoice.base64(new Uint8Array([1, 2, 3])), bytes: again.length };
    })()`);
    check(pipeline.heard && Math.abs(pipeline.seconds - 1) < 0.05 && pipeline.b64 === 'AQID', `the page decodes a recording, hears the voice in it and packs it for the AI (${pipeline.rate} Hz, ${pipeline.seconds.toFixed(2)} s, ${pipeline.bytes} bytes)`);

    // Click guard: give Lefty a screen with risky buttons and rest the mouse on them.
    const seq = await js('currentSeq');
    const at = (dx, dy, w, h) => ({ x: origin.x + dx, y: origin.y + dy, w, h });
    const fake = [
      { name: 'Delete', type: 'Button', enabled: true, rect: at(200, 200, 80, 30) },
      { name: 'Save', type: 'Button', enabled: true, rect: at(300, 200, 80, 30) },
      { name: 'Empty Recycle Bin', type: 'MenuItem', enabled: true, rect: at(400, 200, 160, 30) },
    ];
    // Fresh pretend screen before each hover: the guard re-reads the real screen when its picture is over 1.5s old.
    const hover = async (rect) => {
      overlayWindow.webContents.send('lefty:context', { seq, ok: true, app: 'Guard test', elements: fake });
      await sleep(100);
      return js(`document.dispatchEvent(new MouseEvent('mousemove', { clientX: ${rect.x - origin.x + rect.w / 2}, clientY: ${rect.y - origin.y + rect.h / 2}, bubbles: true })); true`);
    };
    const guardState = () => js(`(() => {
      const tag = document.getElementById('guard-tag');
      const ringEl = document.getElementById('guard-ring');
      return { show: tag.classList.contains('show'), high: tag.classList.contains('high'), text: tag.textContent,
               ring: { x: parseFloat(ringEl.style.left), y: parseFloat(ringEl.style.top) } };
    })()`);

    await hover(fake[0].rect);
    let guard = await waitFor(guardState, (s) => s.show, 2000, 'the guard on Delete');
    check(/Delete/.test(guard.text) && !guard.high, `resting on "Delete" flags it in amber: "${guard.text}"`);
    check(near(guard.ring.x, fake[0].rect.x - origin.x - 3) && near(guard.ring.y, fake[0].rect.y - origin.y - 3), 'the guard ring sits on Delete');

    await hover(fake[1].rect);
    await waitFor(guardState, (s) => !s.show, 2000, 'the guard to clear on Save');
    check(true, 'moving to "Save" clears the warning');

    await hover(fake[2].rect);
    guard = await waitFor(guardState, (s) => s.show, 2000, 'the guard on Empty Recycle Bin');
    check(guard.high && /can't be undone/.test(guard.text), `"Empty Recycle Bin" gets the red warning: "${guard.text}"`);

    await hover(at(5, 700, 1, 1));
    await waitFor(guardState, (s) => !s.show, 2000, 'the guard to clear in empty space');
    check(true, 'empty space clears the warning');

    // Fullscreen apps (games) get Ctrl+Space: the screen reader must tell them apart from normal windows.
    // Asked about hidden test windows by handle, so nothing appears on screen.
    const { BrowserWindow, screen } = require('electron');
    const handleOf = (win) => {
      const buffer = win.getNativeWindowHandle();
      return buffer.length >= 8 ? Number(buffer.readBigUInt64LE(0)) : buffer.readUInt32LE(0);
    };
    // Like a game: no title bar at all (Electron's plain frameless windows keep a hidden one, games don't).
    const bounds = screen.getPrimaryDisplay().bounds;
    const game = new BrowserWindow({ ...bounds, show: false, frame: false, thickFrame: false });
    const framed = new BrowserWindow({ ...bounds, show: false });
    game.setBounds(bounds); // Windows trims new windows to the area above the taskbar
    framed.setBounds(bounds);
    const gameMode = await eyes.screenMode(handleOf(game));
    check(gameMode.fullscreen, 'a borderless window covering the screen counts as fullscreen (Ctrl+Space would pause)');
    const framedMode = await eyes.screenMode(handleOf(framed));
    check(!framedMode.fullscreen, 'a window with a title bar does not, even when it fills the screen');
    const homeMode = await eyes.screenMode(handleOf(mainWindow));
    check(!homeMode.fullscreen, "a normal window like Lefty's home screen does not");
    game.destroy();
    framed.destroy();

    // Closing the home window keeps Lefty running.
    mainWindow.close();
    await sleep(200);
    check(!mainWindow.isDestroyed() && !mainWindow.isVisible(), 'closing the home window hides it; Lefty keeps running');

    console.log('[selftest] All Ctrl+Space checks passed.');
    app.exit(0);
  } catch (error) {
    console.log(`[selftest] FAIL ${error.message}`);
    app.exit(1);
  }
}

module.exports = { run };

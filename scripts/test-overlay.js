// Checks the promises the overlay makes about not stopping: using the PC while Lefty works must not stop him,
// Esc must not stop him, and only the Stop chip (or giving up on getting back to the app) ends a job.
// These broke twice before, each time silently, so they are checked in the overlay's own source: it is a page
// script that needs a window, an app and a screen to run, and none of that is what went wrong.
// Also checks that the running build's version reaches the sidebar, so an old install is never mistaken for a new one.
// Run: npm run test:overlay

const fs = require('fs');
const path = require('path');

let failed = 0;
function check(condition, message) {
  if (!condition) failed += 1;
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${message}`);
}

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const overlay = read('src/overlay/overlay.js');
const preload = read('src/preload.js');
const main = read('src/main.js');
const html = read('src/renderer/index.html');
const appJs = read('src/renderer/app.js');

// The body of a function call that spans lines: from the opening ( to its matching ).
function callBody(source, start) {
  const open = source.indexOf('(', start);
  if (open < 0) return '';
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '(') depth += 1;
    else if (source[i] === ')') { depth -= 1; if (!depth) return source.slice(open + 1, i); }
  }
  return '';
}

// --- using the PC while Lefty works does not stop him ---
const inputAt = overlay.indexOf('api.onInput(');
check(inputAt > 0, 'the overlay still listens for the user typing and clicking');
const inputBody = callBody(overlay, inputAt);
check(!/stopAuto/.test(inputBody), 'a click or a key from the user does NOT stop the job');
check(/lastUserInputAt/.test(inputBody), 'it only notes when the user last touched the PC, to wait for a gap');

// --- Esc does not stop him either: he is called back and stopped with the button ---
const escAt = overlay.search(/key === 'Escape'|'Escape'/);
check(escAt > 0, "the overlay still handles Esc (it closes the bubble when he isn't working)");
const escRegion = overlay.slice(escAt, escAt + 600);
check(/autoWorking\(\)\s*\)\s*return|if \(autoWorking\(\)\) return/.test(escRegion), 'Esc bails out while Lefty is working');

// --- only two things stop a job, and each says why in its own words ---
const calls = [...overlay.matchAll(/(function )?stopAuto\((.*?)\)[;,\s]/g)]
  .filter((m) => !m[1]) // the definition itself is not a caller
  .map((m) => m[2]);
check(calls.length > 0, 'something can still stop a job');
check(calls.every((args) => /^'button'$/.test(args) || /,\s*["']/.test(args)),
  'every stop is either the Stop chip or carries its own message');
check(!/You took over/.test(overlay), 'the old "You took over, so I stopped" message is gone for good');
check(!/'esc'/.test(overlay.slice(overlay.indexOf('function stopAuto'))), 'nothing stops a job because of Esc');

// --- the mode chip is the stop button, and does not promise Esc ---
check(/■ Stop/.test(overlay), 'the chip offers Stop');
check(!/Stop \(Esc\)/.test(overlay), 'the chip no longer tells the user Esc stops him');

// --- called back mid-task: he offers to carry on instead of dropping the job ---
const revealAt = overlay.indexOf('api.onReveal(');
check(revealAt > 0, 'the overlay reacts to being called back while working');
const revealBody = callBody(overlay, revealAt);
check(/Carry on/.test(revealBody) && /Stop/.test(revealBody), 'being called back offers Carry on or Stop');

// --- the version reaches the sidebar ---
check(/ipcMain\.handle\('lefty:version'/.test(main), 'main reports the running build');
check(/app\.getVersion\(\)/.test(main), "it reports Electron's own version for the build, not a hardcoded one");
check(/version: \(\) => ipcRenderer\.invoke\('lefty:version'\)/.test(preload), 'the window can ask for it');
check(/id="brand-version"/.test(html), 'the sidebar has a place for it');
check(/api\.version\(\)/.test(appJs) && /brand-version/.test(appJs), 'the sidebar fills it in on startup');

console.log(failed ? `\n${failed} check(s) failed` : '\nall overlay checks passed');
process.exit(failed ? 1 : 0);

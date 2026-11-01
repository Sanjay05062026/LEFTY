// Checks focus mode's rules: reading "focus 30 minutes on Chrome and physics" from a typed goal, which windows count
// as work, and how the time left is said. Run: npm run test:focus

const Focus = require('../src/overlay/focus');

let failed = 0;
function check(condition, message) {
  if (!condition) failed += 1;
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${message}`);
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// --- typed goals ---
check(same(Focus.parse('focus 30 min on chrome and my physics tab'), { minutes: 30, allow: ['chrome', 'physics'] }), '"focus 30 min on chrome and my physics tab": the time and the work');
check(same(Focus.parse('Study mode for 1 hour, only VS Code'), { minutes: 60, allow: ['vs code'] }), 'hours, "study mode" and "only"');
check(same(Focus.parse('Focus mode for half an hour in VS Code, Notion'), { minutes: 30, allow: ['vs code', 'notion'] }), '"half an hour" and a comma list');
check(same(Focus.parse('focus mode'), { minutes: 30, allow: [] }), 'no time: 30 minutes, and no work named yet (Lefty asks)');
check(Focus.parse('pomodoro').minutes === 25, 'a pomodoro is 25 minutes');
check(Focus.parse('focus mode 20 hours').minutes === 480, 'at most 8 hours');
check(same(Focus.parse('stop focus mode'), { stop: true }) && same(Focus.parse('focus mode off'), { stop: true }), 'stopping it');
check(Focus.parse('focus the search box') === null && Focus.parse('open chrome') === null, 'other goals are not focus mode');

// --- what counts as work ---
const work = ['chrome', 'physics'];
check(Focus.allowed({ process: 'chrome', title: 'YouTube - Google Chrome' }, work), 'an allowed app: every window and tab of it');
check(Focus.allowed({ process: 'msedge', title: 'Physics notes - Microsoft Edge' }, work), 'an allowed word: a tab whose title has it');
check(!Focus.allowed({ process: 'msedge', title: 'YouTube - Microsoft Edge' }, work), 'another tab in another browser is not work');
check(!Focus.allowed({ process: 'steam', title: 'Steam' }, work) && !Focus.allowed({ process: 'RobloxPlayerBeta', title: 'Roblox' }, work), 'games are not work');
check(Focus.allowed({ process: 'Code', title: 'app.js - Visual Studio Code' }, ['VS Code']), 'names people say ("VS Code") match the app');
check(Focus.allowed({ process: 'chrome', title: 'Khan Academy physics lecture - Chrome' }, ['physics lecture']) && !Focus.allowed({ process: 'chrome', title: 'Physics memes' }, ['physics lecture']),
  'several words: all of them must be in the title');
check(Focus.allowed({ process: 'taskmgr', title: 'Task Manager' }, []) && Focus.allowed({ shell: true }, []) && Focus.allowed({ lefty: true, process: 'electron' }, []),
  'Windows itself, Task Manager and Lefty are never closed');
check(!Focus.allowed({ process: 'explorer', title: 'Downloads' }, work), 'a File Explorer window is not work unless named');
check(Focus.isBrowser('msedge') && Focus.isBrowser('Chrome') && !Focus.isBrowser('Code'), 'browsers are known (a tab is closed there, not the window)');

// --- time left ---
check(Focus.timeLeft(40000) === '40 s' && Focus.timeLeft(23 * 60000 - 5000) === '23 min' && Focus.timeLeft(65 * 60000) === '1 h 5 min' && Focus.timeLeft(120 * 60000) === '2 h',
  'time left: seconds, minutes, hours');

console.log(failed ? `\n${failed} focus check(s) FAILED` : '\nAll focus checks passed.');
process.exit(failed ? 1 : 0);

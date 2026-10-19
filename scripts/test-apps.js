// Checks that Lefty finds the app a goal is about: an open window, or a Start menu app. Run: npm run test:apps

const { findWindow, findStartApp, canonical } = require('../src/apps');
const { appName } = require('../src/eyes');

let failed = 0;
function check(condition, message) {
  if (!condition) failed += 1;
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${message}`);
}

const windows = [
  { hwnd: 1, title: 'Discord', process: 'Discord' },
  { hwnd: 2, title: 'Untitled - Notepad', process: 'Notepad', minimized: true },
  { hwnd: 3, title: 'Extension: Python - python - Visual Studio Code', process: 'Code', minimized: true },
  { hwnd: 4, title: 'Spotify Premium', process: 'Spotify' },
  { hwnd: 5, title: 'Untitled - Paint', process: 'mspaint' },
  { hwnd: 6, title: 'How to code in Python - YouTube - Google Chrome', process: 'chrome' },
];
const startApps = [
  { Name: 'Calculator', AppID: 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App' },
  { Name: 'Visual Studio Code', AppID: 'Microsoft.VisualStudioCode' },
  { Name: 'Uninstall Visual Studio Code', AppID: 'x' },
  { Name: 'Word', AppID: 'Microsoft.Office.WINWORD.EXE.15' },
  { Name: 'Google Chrome', AppID: 'Chrome' },
  { Name: 'Microsoft Edge', AppID: 'MSEdge' },
];
const win = (name) => (findWindow(name, windows, appName) || {}).hwnd;

check(win('Visual Studio Code') === 3 && win('vscode') === 3 && win('VS Code') === 3 && win('the vs code app') === 3, 'VS Code is found by any of its names');
check(win('Notepad') === 2 && win('paint') === 5 && win('Spotify') === 4, 'other open apps are found');
check(win('Chrome') === 6 && win('Google Chrome') === 6, 'Chrome is found by its process, not confused by "code"/"Python" in a page title');
check(!win('Calculator') && !win('Word') && !win('Excel'), 'apps that are not open are not "found"');
check(win('python') === undefined || win('python') !== 6, 'a word in a web page title does not count as the app');

check((findStartApp('vscode', startApps) || {}).AppID === 'Microsoft.VisualStudioCode', 'a closed VS Code is found in the Start menu (not its uninstaller)');
check((findStartApp('calculator', startApps) || {}).AppID.startsWith('Microsoft.WindowsCalculator'), 'Calculator is found in the Start menu');
check((findStartApp('chrome', startApps) || {}).AppID === 'Chrome' && (findStartApp('edge', startApps) || {}).AppID === 'MSEdge', 'browsers are found by their short names');
check(findStartApp('photoshop', startApps) === null, 'an app that is not installed is not found');
check(canonical('VS code') === 'visual studio code' && canonical('Calc') === 'calculator', 'short names are understood');

console.log(failed ? `\n${failed} app checks failed.` : '\nAll app checks passed.');
process.exitCode = failed ? 1 : 0;

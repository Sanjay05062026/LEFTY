// Checks the icons Windows is given. Without a real .ico Windows shows Electron's own icon in the tray, the
// taskbar and Add/Remove Programs, and a single png gets squashed into every size it asks for.
// Run: npm run test:icon

const fs = require('fs');
const path = require('path');
const ico = require('../src/ico');

let failed = 0;
function check(condition, message) {
  if (!condition) failed += 1;
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${message}`);
}

const here = (...parts) => path.join(__dirname, '..', ...parts);

// Reads an .ico back: the sizes it holds and where each image starts.
function framesOf(buffer) {
  check(buffer.readUInt16LE(0) === 0, 'the file starts with the reserved zero');
  check(buffer.readUInt16LE(2) === 1, 'it says icon, not cursor');
  const count = buffer.readUInt16LE(4);
  const frames = [];
  for (let i = 0; i < count; i += 1) {
    const at = 6 + i * 16;
    frames.push({
      size: buffer.readUInt8(at) || 256, // the width field is one byte, so 0 means 256
      bytes: buffer.readUInt32LE(at + 8),
      offset: buffer.readUInt32LE(at + 12),
    });
  }
  return frames;
}

// --- the packer ---
const fakePng = (n) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(n, 7)]);
const packed = ico.pack([{ size: 32, png: fakePng(50) }, { size: 16, png: fakePng(20) }, { size: 256, png: fakePng(90) }]);
const frames = framesOf(packed);
check(frames.length === 3, 'every image asked for is in the file');
check(frames.map((f) => f.size).join() === '16,32,256', 'smallest first, and 256 survives the one-byte field');
check(frames.every((f) => f.offset + f.bytes <= packed.length), 'every image lies inside the file');
check(frames[0].offset === 6 + 3 * 16, 'the first image starts right after the directory');
for (const frame of frames) {
  check(packed.slice(frame.offset, frame.offset + 4).toString('latin1') === '\x89PNG', `the ${frame.size} px image is where it says`);
}
const one = framesOf(ico.pack([{ size: 48, png: fakePng(10) }]));
check(one.length === 1 && one[0].size === 48, 'a single size works too');

// --- the files that ship ---
for (const [file, want] of [['build/icon.ico', 256], ['assets/lefty-tray.ico', 48]]) {
  const full = here(file);
  check(fs.existsSync(full), `${file} exists`);
  if (!fs.existsSync(full)) continue;
  const sizes = framesOf(fs.readFileSync(full)).map((f) => f.size);
  check(sizes.includes(16), `${file} has the 16 px Windows draws in the tray`);
  check(sizes.includes(32), `${file} has the 32 px for the taskbar`);
  check(Math.max(...sizes) === want, `${file} goes up to ${want} px`);
  check(new Set(sizes).size === sizes.length, `${file} has no size twice`);
}

// --- the build is pointed at them ---
const pkg = require('../package.json');
check(pkg.build.win.icon === 'build/icon.ico', "the app's icon is the .ico, not a png");
check(pkg.build.nsis.installerIcon === 'build/icon.ico', 'the installer uses it');
check(pkg.build.nsis.uninstallerIcon === 'build/icon.ico', 'the uninstaller uses it');
check(pkg.build.files.some((f) => f.startsWith('assets')), 'the tray icon ships inside the app');

const main = fs.readFileSync(here('src/main.js'), 'utf8');
check(/lefty-tray\.ico/.test(main) && /win32/.test(main.slice(main.indexOf('const ICON'), main.indexOf('const ICON') + 300)),
  'the tray uses the .ico on Windows');

console.log(failed ? `\n${failed} check(s) failed` : '\nall icon checks passed');
process.exit(failed ? 1 : 0);

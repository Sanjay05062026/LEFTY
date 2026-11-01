// Draws assets/lefty.svg into the icons Windows needs, since Windows icons can't be SVG:
//   assets/lefty-icon.png  64 px, the window and tray icon away from Windows
//   assets/lefty-tray.ico  the tray icon on Windows, which picks 16 or 24 px out of it by itself
//   build/icon.png         256 px, kept for anything that wants a plain image
//   build/icon.ico         the installer's and the installed Lefty.exe's own icon
// Without the .ico files Windows falls back to Electron's icon in the tray, the taskbar and Add/Remove Programs.
// Run again after changing Lefty's design: npm run icon

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const ico = require('../src/ico');

const SIZE = 256;
const here = (...parts) => path.join(__dirname, '..', ...parts);
const OUTPUTS = [
  { file: here('assets', 'lefty-icon.png'), size: 64 },
  { file: here('build', 'icon.png'), size: 256 },
];
// Every size Windows may ask for. The tray file stays small: nothing there is ever drawn large.
const ICOS = [
  { file: here('build', 'icon.ico'), sizes: [16, 24, 32, 48, 64, 128, 256] },
  { file: here('assets', 'lefty-tray.ico'), sizes: [16, 20, 24, 32, 40, 48] },
];
const svg = fs.readFileSync(path.join(__dirname, '..', 'assets', 'lefty.svg'), 'utf8');
const page = `<html><body style="margin:0;background:transparent;display:flex;align-items:center;justify-content:center;width:${SIZE}px;height:${SIZE}px">
  <img src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}" style="height:${SIZE - 16}px">
</body></html>`;

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: SIZE, height: SIZE, show: false, transparent: true, frame: false,
    webPreferences: { offscreen: true },
  });
  win.webContents.setFrameRate(5);
  let frames = 0;
  win.webContents.on('paint', (_event, _dirty, image) => {
    frames += 1;
    if (frames < 3) return; // let the image load and settle
    const pngAt = (size) => image.resize({ width: size, height: size, quality: 'best' }).toPNG();
    for (const { file, size } of OUTPUTS) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, pngAt(size));
      console.log(`wrote ${file}`);
    }
    for (const { file, sizes } of ICOS) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, ico.pack(sizes.map((size) => ({ size, png: pngAt(size) }))));
      console.log(`wrote ${file} (${sizes.join(', ')} px)`);
    }
    app.exit(0);
  });
  win.loadURL(`data:text/html;base64,${Buffer.from(page).toString('base64')}`);
});

// Draws assets/lefty.svg into assets/lefty-icon.png (the 64 px tray and window icon) and build/icon.png (the 256 px
// icon of the installer and the installed app), since Windows icons can't be SVG.
// Run again after changing Lefty's design: npm run icon

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const SIZE = 256;
const OUTPUTS = [
  { file: path.join(__dirname, '..', 'assets', 'lefty-icon.png'), size: 64 },
  { file: path.join(__dirname, '..', 'build', 'icon.png'), size: 256 },
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
    for (const { file, size } of OUTPUTS) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, image.resize({ width: size, height: size, quality: 'best' }).toPNG());
      console.log(`wrote ${file}`);
    }
    app.exit(0);
  });
  win.loadURL(`data:text/html;base64,${Buffer.from(page).toString('base64')}`);
});

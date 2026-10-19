// Draws assets/lefty.svg into assets/lefty-icon.png (the tray and window icon), since Windows icons can't be SVG.
// Run again after changing Lefty's design: npx electron scripts/make-icon.js

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const SIZE = 64;
const svg = fs.readFileSync(path.join(__dirname, '..', 'assets', 'lefty.svg'), 'utf8');
const page = `<html><body style="margin:0;background:transparent;display:flex;align-items:center;justify-content:center;width:${SIZE}px;height:${SIZE}px">
  <img src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}" style="height:${SIZE - 4}px">
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
    const out = path.join(__dirname, '..', 'assets', 'lefty-icon.png');
    fs.writeFileSync(out, image.resize({ width: SIZE, height: SIZE }).toPNG());
    console.log(`wrote ${out}`);
    app.exit(0);
  });
  win.loadURL(`data:text/html;base64,${Buffer.from(page).toString('base64')}`);
});

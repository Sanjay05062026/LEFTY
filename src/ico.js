// Packs PNG images into a Windows .ico, so one file holds every size Windows asks for: 16 px in the tray,
// 32 in the taskbar and Alt+Tab, 256 in Explorer. Given a single png, Windows squashes it to all of them;
// given none, the app shows Electron's own icon instead of Lefty.
//
//   pack([{ size: 16, png: <Buffer> }, ...]) -> Buffer
//
// An .ico is a 6-byte header, then a 16-byte entry per image, then the images themselves. Since Windows Vista
// the images may be PNGs as they are, which is what this writes.

const HEADER = 6;
const ENTRY = 16;

function pack(images) {
  const frames = [...images].sort((a, b) => a.size - b.size);
  const header = Buffer.alloc(HEADER);
  header.writeUInt16LE(0, 0);             // reserved
  header.writeUInt16LE(1, 2);             // 1: an icon (2 would be a cursor)
  header.writeUInt16LE(frames.length, 4);

  let offset = HEADER + ENTRY * frames.length;
  const entries = frames.map(({ size, png }) => {
    const entry = Buffer.alloc(ENTRY);
    entry.writeUInt8(size >= 256 ? 0 : size, 0); // 0 means 256: the field is one byte
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2);               // colours in the palette: none, it is a true-colour image
    entry.writeUInt8(0, 3);               // reserved
    entry.writeUInt16LE(1, 4);            // colour planes
    entry.writeUInt16LE(32, 6);           // bits per pixel
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += png.length;
    return entry;
  });

  return Buffer.concat([header, ...entries, ...frames.map((f) => f.png)]);
}

module.exports = { pack };

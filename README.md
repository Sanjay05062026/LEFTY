# Lefty

A friendly AI cursor that points you to the next step in any app. This is the UI prototype: no backend yet.

## Run

```bash
npm install
npm start
```

Log in with any email and a password of 6+ characters, allow the permissions, then press **Ctrl + Space** anywhere to call Lefty. Press **Esc** or the shortcut again to hide him.

## Changing Lefty's design

Lefty's look lives in one file: `assets/lefty.svg`. Replace it and every screen plus the on-screen cursor update. Keep the pointer tip at the top-left corner of the drawing so pointing stays accurate.

## Structure

- `src/main.js`: windows, global shortcut, overlay show/hide
- `src/preload.js`: the small bridge between the windows and the main process
- `src/renderer/`: login, permissions and home screens
- `src/overlay/`: the transparent on-screen Lefty and his chat bubble

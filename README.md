# Lefty

A friendly AI cursor that points you to the next step in any app. This is the UI prototype: no backend yet.

## Run

```bash
npm install
npm start
```

Log in with any email and a password of 6+ characters, allow the permissions, then press **Ctrl + Space** anywhere to call Lefty. Press **Esc** or the shortcut again to hide him.

Lefty reads the app you're in ("I can see Notepad") and points at any button you name: type `save`, `settings` or `click the start button` and he flies there and rings it. Goals that need real planning get a placeholder reply until the AI brain is connected.

## Test

```bash
npm test
```

Runs the button matcher checks, reads the Windows taskbar with UI Automation, and runs the whole Ctrl+Space flow end to end without showing any window.

## Changing Lefty's design

Lefty's look lives in one file: `assets/lefty.svg`. Replace it and every screen plus the on-screen cursor update. Keep the pointer tip at the top-left corner of the drawing so pointing stays accurate.

## Structure

- `src/main.js`: windows, global shortcut, overlay show/hide
- `src/preload.js`: the small bridge between the windows and the main process
- `src/renderer/`: login, permissions and home screens
- `src/overlay/`: the transparent on-screen Lefty, his chat bubble, highlight ring and button matcher (`match.js`)
- `src/eyes.js` + `native/uia-helper.cs`: reads the clickable elements of your current app (Windows UI Automation); the helper builds itself on first run with the C# compiler built into Windows
- `scripts/`: tests and the background self-test

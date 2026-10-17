# Lefty

A friendly AI cursor that points you to the next step in any app. This is the UI prototype: no backend yet.

## Run

```bash
npm install
npm start
```

Log in with any email and a password of 6+ characters, allow the permissions, then press **Ctrl + Space** anywhere to call Lefty. Press **Esc** or the shortcut again to hide him.

Lefty reads the app you're in ("I can see Notepad") and points at any button you name: type `save`, `settings` or `click the start button` and he flies there and rings it.

**Goals, not scripts:** type `save this` and Lefty works until the file is *actually saved*: File → Save → in the Save dialog `Pick any folder 📁` → `Name it anything ✏️` → `Save 💾` → `🎉 Saved!`. He looks at the screen after every move, notices Ctrl+S, Enter and typing, goes round again if you cancel, and only says done when the dialog has closed and the window title no longer says Untitled. The chat steps aside while he guides; afterwards he moves to the corner so he never covers your work.

**Paths:** type `File > Save as` (or `file then save as`) and he walks it with a ring on each target and a tag on him (`1/2 · File`); a Save/Open dialog opened by the last step is coached to the end too. Other goals get a placeholder reply until the AI brain is connected: it will be one more skill in the same goal loop (`src/overlay/skills.js`).

**Click guard:** while Lefty is open, rest the mouse on a button that throws work away (`Delete`, `Don't Save`, `Uninstall`) and he flags it in amber; things that can't be undone (`Empty Recycle Bin`, `Delete permanently`) get red. Harmless look-alikes (`Format` menu, `Reset zoom`, `Undo delete`) stay quiet.

## Test

```bash
npm test
```

Runs the button matcher, click guard and goal-loop checks (whole save journeys, cancels, Ctrl+S, named files), reads the Windows taskbar with UI Automation, and runs the whole Ctrl+Space flow end to end (guide, clicks, guard) without showing any window or touching the keyboard.

## Changing Lefty's design

Lefty's look lives in one file: `assets/lefty.svg`. Replace it and every screen plus the on-screen cursor update. Keep the pointer tip at the top-left corner of the drawing so pointing stays accurate.

## Structure

- `src/main.js`: windows, global shortcut, overlay show/hide
- `src/preload.js`: the small bridge between the windows and the main process
- `src/renderer/`: login, permissions and home screens
- `src/overlay/`: the transparent on-screen Lefty, his chat bubble, highlight ring and step tag; the goal loop's skills (`skills.js`), Save/Open dialog coach (`dialogs.js`), button matcher (`match.js`) and click guard rules (`guard.js`)
- `src/eyes.js` + `native/uia-helper.cs`: reads the clickable elements of your current app with native Windows UI Automation; the helper builds itself on first run with the C# compiler built into Windows (`native/tlbgen.cs` generates the UI Automation definitions from Windows' own type library)
- `scripts/`: tests and the background self-test

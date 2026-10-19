# Lefty

A friendly AI cursor that points you to the next step in any app. A Windows desktop app plus a small backend that holds the AI key (no sign-up yet).

## Run

```bash
npm install
npm start
```

Log in with any email and a password of 6+ characters, allow the permissions, then press **Ctrl + Space** anywhere to call Lefty. Press **Esc** or the shortcut again to hide him. Closing the window keeps Lefty running in the tray (right-click his icon to quit). While a fullscreen app such as a game is in front, Ctrl+Space goes to that app instead.

Lefty reads the app you're in ("I can see Notepad") and points at any button you name: type `save`, `settings` or `click the start button` and he flies there and rings it.

**Goals, not scripts:** type `save this` and Lefty works until the file is *actually saved*: File → Save → in the Save dialog `Pick any folder 📁` → `Name it anything ✏️` → `Save 💾` → `🎉 Saved!`. He looks at the screen after every move, notices Ctrl+S, Enter and typing, goes round again if you cancel, and only says done when the dialog has closed and the window title no longer says Untitled. The chat steps aside while he guides; afterwards he moves to the corner so he never covers your work.

**AI brain:** ask for anything in words (`add a table`, `make this text bold`, `I'm stuck`) and Lefty sends an AI a screenshot of your screen plus the list of buttons he can read. It answers with the one next step; Lefty points at it, watches you do it, then asks for the next one, until the AI sees the goal is done. Short button names, `save this` and typed paths still run on the PC without the AI. The AI's pointing is checked against the buttons Windows can read: a spot guessed from the screenshot, or a pick that doesn't fit the step, moves to the button whose name fits it ("Click the red color" lands on Paint's `Red` swatch), unless two different buttons fit equally. When the step names something that isn't on the list at all, Lefty asks again whether it's hidden (behind `Show toolbar`, `More`...). Search boxes Windows can't see, such as VS Code's Extensions search, are worked out from the `Clear ... Search Results` button beside them.

To connect the brain for free, get a Google Gemini key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey) (no card needed) and create a `.env` file next to `package.json`:

```
GEMINI_API_KEY=your-key-here
```

`.env` is never committed and Lefty picks up a new key without a restart. Lefty hides himself from the screenshot, sends one only when a goal needs the brain, and stops a goal that goes round in circles. On Gemini's free tier Google may use what is sent to improve its products, so don't ask for help on screens with private information. `LEFTY_MODEL` picks the model.

**Ghost code:** in VS Code, ask for code (`single linked list`, `bubble sort in java`) and Lefty draws it as faint teal text right at your text cursor, like an inline suggestion, for you to type over. It is drawn in VS Code's own font and size (read from your settings), so each letter lands where yours will. Until you start typing it follows your cursor (click where it should go); then it moves with you line by line, the next letter underlined, allowing for VS Code's auto-indent, and Lefty cheers when the last line is typed. Lefty can't see the text itself (VS Code hides it outside screen-reader mode), only the cursor's line and column, so he trusts that you typed what the ghost showed. VS Code, Cursor and Windsurf are supported; in other apps the code appears in the chat. Tip: in C-style languages VS Code types closing brackets for you, so skip the ones already there.

**Code doctor:** in VS Code, ask `find the error` (or `why isnt this working`, `fix my code`), or press **Find & fix** when Lefty's greeting says he spots problems (he reads VS Code's own error count). He reads the whole file himself (select all + copy, then your clipboard and cursor are put back), the AI finds each real error and the smallest fix (only the cause when one mistake causes several errors, e.g. `b==2` that leaves `b` undefined later), and Lefty takes them one at a time: VS Code jumps to the line (scrolling long files), the wrong code gets a red ring, and the fix shows as ghost text beside it. Then you choose **✨ Fix it for me** (Lefty pastes the fix over the wrong lines), **✍️ I'll type it** (the line is cleared and the fix becomes ghost code to type over) or **Skip**. Lefty only presses keys in your editor after you ask, never reads files that look like secrets (`.env`, keys, passwords), and the code goes to the AI like a screenshot would. If Windows clipboard history is on, the copied code appears there.

**Backend:** `npm run server` starts Lefty's backend (`server/index.js`), which holds the AI key so people who download Lefty don't need their own. Point the app at it with `LEFTY_SERVER=http://your-server:8787` in `.env`; the app then sends the goal, the screen's buttons and the screenshot there instead of to Google, and the server answers with the same next step. Nothing is stored and the server's log never shows goals, screens or answers. Server settings (environment or `.env`): `GEMINI_API_KEY`, `PORT` (8787), `HOST` (`127.0.0.1`; use `0.0.0.0` when hosted), optional `LEFTY_APP_TOKEN` (the app must send the same value), and optional `LEFTY_LIMIT_PER_MIN` / `LEFTY_LIMIT_PER_DAY` per install (each install sends a random id, nothing personal). It runs on any host with Node 20+ and needs only `server/` and `src/brain.js`. No sign-up page yet.

**Paths:** type `File > Save as` (or `file then save as`) and he walks it with a ring on each target and a tag on him (`1/2 · File`); a Save/Open dialog opened by the last step is coached to the end too.

**Click guard:** while Lefty is open, rest the mouse on a button that throws work away (`Delete`, `Don't Save`, `Uninstall`) and he flags it in amber; things that can't be undone (`Empty Recycle Bin`, `Delete permanently`) get red. Harmless look-alikes (`Format` menu, `Reset zoom`, `Undo delete`) stay quiet.

## Test

```bash
npm test
```

Runs the button matcher, click guard and goal-loop checks (whole save journeys, cancels, Ctrl+S, named files), the ghost code tracker, the AI brain against fake AI answers, the backend with real HTTP requests to a local test server, reads the Windows taskbar with UI Automation, and runs the whole Ctrl+Space flow end to end (guide, clicks, guard) without showing any window or touching the keyboard. No test calls a real AI.

## Changing Lefty's design

Lefty's look lives in one file: `assets/lefty.svg`. Replace it and every screen plus the on-screen cursor update. Keep the pointer tip at the top-left corner of the drawing so pointing stays accurate.

## Structure

- `src/main.js`: windows, global shortcut, overlay show/hide
- `src/preload.js`: the small bridge between the windows and the main process
- `src/renderer/`: login, permissions and home screens
- `src/overlay/`: the transparent on-screen Lefty, his chat bubble, highlight ring and step tag; the goal loop's skills (`skills.js`), Save/Open dialog coach (`dialogs.js`), button matcher (`match.js`) and click guard rules (`guard.js`)
- `src/overlay/ghost.js`: ghost code: which code line the text cursor is on and what's left to type
- `src/brain.js`: asks the AI (Google Gemini) for the next step: screenshot + readable buttons in, one step out
- `src/brain-remote.js` + `server/index.js`: the same, through Lefty's backend when `LEFTY_SERVER` is set
- `src/eyes.js` + `native/uia-helper.cs`: reads the clickable elements of your current app with native Windows UI Automation; the helper builds itself on first run with the C# compiler built into Windows (`native/tlbgen.cs` generates the UI Automation definitions from Windows' own type library)
- `scripts/`: tests and the background self-test

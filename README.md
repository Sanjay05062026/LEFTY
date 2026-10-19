# Lefty

Lefty is an on-screen assistant for Windows. Press Ctrl+Space in any app, say what you want to do, and Lefty points at the next button to click, watches you do it, and guides you step by step until the task is actually done. In VS Code he can also write code for you to type along with, and find and fix errors in your file.

It is a desktop app (Electron) plus an optional small backend that holds the AI key, so people who install Lefty don't need a key of their own.

## Project status

This is an early version. What is here is the starting point of the idea, not the finished product: the core loop (understand the goal, read the screen, point at the next step, check it was done) works, and the features below are the first ones built on top of it. Planned next:

- Voice: hold a key, ask out loud, and hear the answer
- Support for several monitors
- Remembering earlier requests, so follow-up questions work
- A smoother pointing animation and an optional mode where Lefty stays next to the mouse
- A hosted backend, a Windows installer and a signed release

## Requirements

- Windows 10 or 11
- Node.js 20 or newer
- A Google Gemini API key (free, no card needed) from [aistudio.google.com/apikey](https://aistudio.google.com/apikey), or a running Lefty backend (see [Backend](#backend))

Nothing else needs installing. The part that reads the screen is built on first run with the C# compiler that ships with Windows.

## Getting started

1. Install the dependencies:

   ```bash
   npm install
   ```

2. Create a file named `.env` next to `package.json` with your key:

   ```
   GEMINI_API_KEY=your-key-here
   ```

   The file is ignored by git, and Lefty picks up a new key without a restart.

3. Start the app:

   ```bash
   npm start
   ```

4. Sign in with any email and a password of at least 6 characters, and allow the permissions.

5. Press **Ctrl+Space** anywhere to call Lefty. Press **Esc** or Ctrl+Space again to hide him.

Closing the window keeps Lefty running in the system tray. Right-click the tray icon and choose Quit to exit.

## What to test

Each check below says what to do and what should happen.

| Where | What to do | What should happen |
| --- | --- | --- |
| Calculator | Type `switch to scientific mode` | Lefty points at the navigation menu, then at Scientific, and says done. |
| Calculator | Type it with typos: `swich to scintific mod` | Same result. Lefty understands spelling mistakes. |
| Paint | Type `choose red color` | If the colours are hidden he points at Show toolbar first, then at the red swatch. |
| Desktop | Type `open calculator and switch to scientific mode` | If Calculator is closed, Lefty asks whether to open it, opens it on Yes, and continues the task there. |
| VS Code | Type `tell` | He asks what you want help with instead of pretending to do something. |
| VS Code | Type `what is this app` | He answers in the chat. |

### Code features in VS Code

| What to do | What should happen |
| --- | --- |
| Open a new file and type `single linked list in python` | The code appears as faint teal text one line below the cursor. Press Enter and type over it; the text moves along with you, the next character is underlined, and Lefty congratulates you after the last line. |
| Write a few lines with a mistake (for example `b==2` instead of `b = 2`) and type `find the error` | Lefty jumps to the line with the error (scrolling if needed), rings it in red, shows the fix beside it, and offers Fix it for me, I'll type it, or Skip. |
| Choose Fix it for me | The fix replaces the wrong line and Lefty moves to the next error. |
| Choose I'll type it | The wrong line is cleared and the fix appears as ghost text for you to type. |

When VS Code shows problems in its status bar, Lefty's greeting mentions them and offers a Find & fix button.

## Automated tests

```bash
npm test
```

This runs every test suite, none of which call a real AI or need a key:

- button matching, the click guard and the guided task loop, including complete save journeys and cancelled dialogs
- ghost code tracking and the pointing corrections
- the AI layer against recorded answers, and the backend with real HTTP requests to a local test server
- a read of the Windows taskbar through UI Automation
- an end-to-end run of the Ctrl+Space flow without showing a window or touching the keyboard

Individual suites can be run with `npm run test:brain`, `npm run test:ghost`, `npm run test:server` and so on (see `package.json`).

## Backend

The backend keeps the AI key on a server so installed copies of Lefty don't need one.

```bash
npm run server
```

Point the app at it by adding `LEFTY_SERVER=http://your-server:8787` to the app's `.env`. The app then sends its requests to the backend instead of directly to Google.

Server settings, from environment variables or a `.env` file:

| Setting | Meaning |
| --- | --- |
| `GEMINI_API_KEY` | The AI key the server uses |
| `PORT` | Port to listen on (default 8787) |
| `HOST` | Address to listen on (default `127.0.0.1`; use `0.0.0.0` on a hosted server) |
| `LEFTY_APP_TOKEN` | Optional. If set, the app must send the same value |
| `LEFTY_LIMIT_PER_MIN`, `LEFTY_LIMIT_PER_DAY` | Optional request limits per installation |

The server stores nothing and its log never contains goals, screenshots or code. It runs on any host with Node.js 20 or newer and only needs the `server/` folder and `src/brain.js`.

## Privacy

- Lefty reads the names and positions of buttons through Windows UI Automation. A screenshot is sent to the AI only when a request needs it, and Lefty hides himself from it.
- For the code features, Lefty reads the open file by selecting and copying it, then restores your clipboard and cursor. He only presses keys in your editor after you ask, and he refuses to read files that look like secrets (`.env`, keys, passwords). If Windows clipboard history is turned on, the copied code will appear there.
- On Gemini's free tier, Google may use what is sent to improve its products. Avoid asking for help on screens that show private information.

## Project structure

| Path | What it contains |
| --- | --- |
| `src/main.js` | Windows, the global shortcut, screen capture and the main-process side of every feature |
| `src/preload.js` | The bridge between the windows and the main process |
| `src/renderer/` | Sign-in, permissions and home screens |
| `src/overlay/` | The on-screen assistant: chat, highlight ring, step tag, ghost code (`ghost.js`), the guided task loop (`skills.js`), the Save/Open dialog coach (`dialogs.js`), button matching (`match.js`) and click guard rules (`guard.js`) |
| `src/brain.js` | Requests to the AI: next step, code to write, errors to fix |
| `src/brain-remote.js` | The same requests, sent through the backend when `LEFTY_SERVER` is set |
| `src/snap.js` | Moves the AI's pointing onto the real button that matches the step |
| `src/apps.js` | Finds an open app window or a Start menu entry by name |
| `src/eyes.js`, `native/uia-helper.cs` | Reads the current app's buttons, the text cursor and the screen state through Windows UI Automation |
| `server/` | The backend |
| `scripts/` | Tests and the background self-test |

## Changing the look

The character is drawn in a single file, `assets/lefty.svg`. Replace it and every screen updates. Keep the pointer tip at the top-left corner of the drawing so pointing stays accurate.

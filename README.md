# Lefty

Lefty is an on-screen assistant for Windows. Press Ctrl+Space in any app, say what you want to do, and Lefty gets it done with you, step by step, until the task is actually finished. He works in two modes:

- **Learn**: Lefty points at the next button, you click it, and he checks it worked before showing the next step.
- **Do it**: Lefty clicks and types for you while you watch. He asks before anything risky (delete, buy, send, install), leaves private things such as passwords to you, and stops the moment you press Esc, click or type.

In VS Code he can also write code (for you to type along with in Learn mode, or straight into the file in Do it mode) and find and fix errors in your file.

It is a desktop app (Electron) plus an optional small backend that holds the AI key, so people who install Lefty don't need a key of their own.

## Project status

This is an early version. What is here is the starting point of the idea, not the finished product: the core loop (understand the goal, read the screen, point at the next step, check it was done) works, and the features below are the first ones built on top of it. Planned next:

- Support for several monitors
- Remembering earlier requests, so follow-up questions work
- A smoother pointing animation and an optional mode where Lefty stays next to the mouse
- Code features (ghost code, finding and fixing errors) in other code editors, not only VS Code
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

6. Choose **Learn** or **Do it** in Lefty's chat bubble, or on the home screen, where you can also make Lefty smaller or larger.

Closing the window keeps Lefty running in the system tray. Right-click the tray icon and choose Quit to exit.

### Installing Lefty as an app

```bash
npm run dist
```

This builds `dist\Lefty-Setup-0.1.0.exe`. Running it installs Lefty for the current user (no administrator rights needed), adds Desktop and Start menu shortcuts and starts him. The installed app reads its key from `%APPDATA%\lefty\.env` (same format as above). To have Lefty ready after every sign-in, right-click his tray icon and tick **Start with Windows**; he then starts quietly in the tray. The installer is not code-signed yet, so Windows SmartScreen may ask for confirmation the first time.

If the build stops with "Cannot create symbolic link" while unpacking `winCodeSign`, turn on Windows Developer Mode, or unpack that archive once into `%LOCALAPPDATA%\electron-builder\Cache\winCodeSign\winCodeSign-2.6.0` (the macOS files that fail are not needed) and run the build again.

## Learn and Do it

The switch at the top of Lefty's bubble sets how he helps. It can be changed at any time, even in the middle of a task, and the choice is remembered. While a task runs in Learn mode, a "Do it for me" button next to the step lets Lefty take over from there.

In Do it mode:

- Lefty moves to each button first, so you see what he is about to press, then clicks it, types, presses keys or scrolls. He opens apps without asking, and in VS Code he writes code into the file and applies code fixes himself (Ctrl+Z undoes them).
- Steps that are yours stay yours. When something is your own choice (a file name) or private (passwords, card numbers, PINs), the step tag says "Your turn" and Lefty waits. He never types into password boxes.
- Risky steps need your yes first: anything that deletes, discards, overwrites, resets, buys, pays, sends, posts, installs, signs out or closes the whole app window. You can answer Yes, do it; I'll do it; or Stop.
- He only acts in the app the task is about. If another window is in the way, or the button is no longer where it was, he stops instead of clicking something else.
- **Stopping**: press Esc, click the Stop button next to the step, or simply click or type anywhere. Moving the mouse does not stop him. After a stop, Continue picks up where he was, and Guide me instead carries on in Learn mode.

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

### Do it mode

Switch to **Do it** in Lefty's bubble first.

| Where | What to do | What should happen |
| --- | --- | --- |
| Calculator | Type `switch to scientific mode` | Lefty clicks the navigation menu, then Scientific, himself. Moving the mouse meanwhile does not stop him. |
| Calculator | Ask again, and press any key right after his first click | He stops and offers Continue or Guide me instead. Continue finishes the task. |
| Notepad, new tab | Type `type hello world` | Lefty clicks into the page and types it. |
| Notepad | Type `replace all hello with bye` | He opens Replace, fills in both boxes, and asks before pressing Replace all. |
| Notepad | Type `save this` | He opens the Save dialog; the step tag says "Your turn" for the file name. After you type it, he clicks Save. |
| Paint | Type `choose red color` | He shows the toolbar if it is hidden, then picks Red. |
| VS Code, new file | Type `write a python function that reverses a string` | He writes the code into the file. |
| VS Code | Write code with a mistake and type `find the error` | He shows each error briefly, then fixes it himself. |

### Code features in VS Code

The code features are meant for every code editor. For now they are built and tested for VS Code only (editors based on it, such as Cursor, should also work); support for other editors is planned.

| What to do | What should happen |
| --- | --- |
| Open a new file and type `single linked list in python` | The code appears as faint teal text one line below the cursor. Press Enter and type over it; the text moves along with you, the next character is underlined, and Lefty congratulates you after the last line. |
| Write a few lines with a mistake (for example `b==2` instead of `b = 2`) and type `find the error` | Lefty jumps to the line with the error (scrolling if needed), rings it in red, shows the fix beside it, and offers Fix it for me, I'll type it, or Skip. |
| Choose Fix it for me | The fix replaces the wrong line and Lefty moves to the next error. |
| Choose I'll type it | The wrong line is cleared and the fix appears as ghost text for you to type. |

When VS Code shows problems in its status bar, Lefty's greeting mentions them and offers a Find & fix button.

### Voice

| What to do | What should happen |
| --- | --- |
| Hold Ctrl+Space, say a goal (in any language) and let go | Lefty shows what he heard and starts working on it straight away. Nothing needs to be sent. |
| Click the microphone button, say a goal and stop talking | After a short pause he sends it himself. |

### Focus mode

| What to do | What should happen |
| --- | --- |
| Type or say `focus 30 minutes on VS Code and physics` | Focus mode starts. Until the time is up, anything that isn't VS Code or a window or tab with "physics" in its title is closed as soon as it comes to the front: a browser tab with Ctrl+W, any other app as its X button would (so it can still ask to save). Lefty doesn't open his chat for it: he glides to the tab's close button (or the app's X), presses it, and a small tag beside him says "That can wait until you complete your work" and how long is left, then he goes again. |
| Type `focus mode` without naming apps | Lefty asks which apps or tabs are for your work, suggesting the app you called him over. |
| Type `stop focus mode`, or press Stop on the home screen | Focus mode ends. |

The home screen's sidebar can also start focus mode and shows the time left. Windows itself, Task Manager and Lefty are never closed.

### Building a project

| What to do | What should happen |
| --- | --- |
| Type or say `build me a portfolio website with a contact form` | Lefty asks which folder to use (a suggestion under Documents\Lefty Projects, a typed path, or Browse to pick one), writes every file there and offers to open it in VS Code or the browser. |
| Then ask `add a dark mode toggle` | He offers the same folder and changes the files he made. Files he replaces are copied to `.lefty-backup` first. |
| Then ask `build a complex website for a coffee shop` | A new request is a new project: he suggests a new, empty folder (shown in full, so you can change the path or browse for another), and a complex request gets a multi-page site. |

### Chats and history

| What to do | What should happen |
| --- | --- |
| Type a goal in the home screen's chat | The home window steps aside and Lefty works on the app behind it. His pop-up has no panel: the messages float as bubbles over the screen. |
| Open the home screen again | The chat is in the list on the left, with both your messages and Lefty's answers. |
| Open an old chat and type in it | Lefty continues it: he shows its last messages, the AI is given the earlier conversation, and a project built in it is the one a change goes to. |
| Look at Storage in the sidebar, then delete a chat (Delete, then Sure?) | The bar shows how much space is used and left; deleting frees it. |

## Chat history in Supabase

Without any setup, chats are saved on this PC (`%APPDATA%leftychats.json`). To keep them in your own Supabase project instead:

1. In the Supabase dashboard, open SQL Editor and run [server/supabase.sql](server/supabase.sql). It creates the chat tables, row level security so each install sees only its own chats, and the function the storage bar uses.
2. Under Authentication, Sign In / Providers, turn on **Allow anonymous sign-ins**. Each copy of Lefty signs in as its own anonymous user; there is no password.
3. From Project Settings, API, copy the project URL and the anon public key into Lefty's `.env` (`%APPDATA%lefty.env` for the installed app):

```
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your-anon-key
```

Restart Lefty. The storage bar then says Supabase and counts the whole database against the free plan's 500 MB (`LEFTY_STORAGE_MB` changes the limit). If something is missing, the bar says which step to do.

## Automated tests

```bash
npm test
```

This runs every test suite, none of which call a real AI or need a key:

- button matching, the click guard and the guided task loop, including complete save journeys and cancelled dialogs
- ghost code tracking and the pointing corrections
- what Do it mode does for each kind of step, what it asks about first and what it leaves to you, and the settings file
- the voice pipeline (the recording as a small WAV file, the silence check, sending once you stop talking) and focus mode's rules (reading a typed request, which windows count as work)
- the AI layer against recorded answers, and the backend with real HTTP requests to a local test server
- a read of the Windows taskbar through UI Automation
- an end-to-end run of the Ctrl+Space flow, including Do it mode, its stop rules and the size setting, without showing a window or touching the mouse or keyboard (Do it clicks are recorded, not made)

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
- Lefty clicks and types only in Do it mode, only in the app the task is about, and never into password boxes. The log records which button he clicked, never what he typed.
- Chat history keeps only the text of your messages and Lefty's answers (never screenshots, audio or what is on screen), on this PC or in your own Supabase project. Delete a chat from the sidebar to remove it.
- Voice is recorded only while you hold Ctrl+Space or after you click the microphone button, and the recording is sent to the AI as your goal. Nothing is saved.
- Focus mode only looks at which app is in front and its window title, to decide whether it is work. The log names the app it closed, never the title.
- When building a project, Lefty reads and writes only inside the folder you choose, never `.env` files, and keeps a copy of every file he replaces in `.lefty-backup`.
- On Gemini's free tier, Google may use what is sent to improve its products. Avoid asking for help on screens that show private information.

## Project structure

| Path | What it contains |
| --- | --- |
| `src/main.js` | Windows, the global shortcut, screen capture and the main-process side of every feature |
| `src/preload.js` | The bridge between the windows and the main process |
| `src/renderer/` | Sign-in, permissions and home screens |
| `src/overlay/` | The on-screen assistant: chat, highlight ring, step tag, ghost code (`ghost.js`), the guided task loop (`skills.js`), what Do it mode does for each step (`auto.js`), the Save/Open dialog coach (`dialogs.js`), voice (`voice.js`), focus mode's rules (`focus.js`), button matching (`match.js`) and click guard rules (`guard.js`) |
| `src/settings.js` | Learn or Do it mode and Lefty's size, saved between runs |
| `src/brain.js` | Requests to the AI: next step, code to write, errors to fix |
| `src/brain-remote.js` | The same requests, sent through the backend when `LEFTY_SERVER` is set |
| `src/snap.js` | Moves the AI's pointing onto the real button that matches the step |
| `src/apps.js` | Finds an open app window or a Start menu entry by name |
| `src/eyes.js`, `native/uia-helper.cs` | Reads the current app's buttons, the text cursor and the screen state through Windows UI Automation, and makes Do it mode's clicks and key presses |
| `server/` | The backend |
| `scripts/` | Tests and the background self-test |

## Changing the look

The character is drawn in a single file, `assets/lefty.svg`. Replace it and every screen updates. Keep the pointer tip at the top-left corner of the drawing so pointing stays accurate. After changing it, run `npx electron scripts/make-icon.js` to redraw the tray icon.

How big Lefty is on screen is a setting (Small, Normal or Large, on the home screen); the sizes are in `SIZES` in `src/overlay/overlay.js`.

# Notes: what Lefty can take from Clicky

Source: https://github.com/farzaa/clicky (MIT, open source; its newest work is now private). These notes come from its README, AGENTS.md, `CompanionManager.swift`, `ElementLocationDetector.swift`, `OverlayWindow.swift` and `worker/src/index.ts`.

Clicky is **macOS only** (Swift, ScreenCaptureKit, macOS windows and keyboard hooks). Nothing can be copied directly. Each idea below says how it would work on Windows with what Lefty already uses (Electron, UI Automation, uiohook, desktopCapturer).

## What Clicky is, in one paragraph

A blue triangle cursor buddy. You **hold Ctrl+Option and talk**: speech goes to AssemblyAI for live transcription, and the transcript plus screenshots of **every screen** goes to a paid AI model. It answers in one or two casual, spoken-style sentences, and ElevenLabs reads the answer aloud. When the answer ends with a tag like `[POINT:x,y:label:screenN]`, the triangle **flies along a curve** to that spot, shows a small speech bubble ("found it!"), then flies back to your mouse. All AI calls go through a Cloudflare Worker, so no keys ship in the app.

## Where Lefty is already ahead (useful for the pitch)

| Lefty | Clicky |
|---|---|
| Reads the app's real buttons through UI Automation, so it can point at the exact element | Guesses from the screenshot only (no accessibility read, no OCR, no second check) |
| Multi-step goal loop: watches clicks, keys and typing, and only says done when it's really done | Answers one question at a time; no step checking |
| Click guard for Delete, Don't Save and similar | None |
| Ghost code to type over in VS Code | None |
| Switches to or opens the right app first (Yes/No) | None |
| Pauses during fullscreen games | Not needed on its design |
| Backend with app token, per-device limits and no logging of goals or screens | Worker has no auth, no rate limit, no size check: anyone with the URL can use up the keys |
| Free Gemini brain | A paid AI model, plus paid AssemblyAI and ElevenLabs |

## Ideas worth adding, best first

### 1. Better pointing when the button isn't in the readable list (fixes the Paint red and VS Code search box misses)
- **How Clicky does it:**
  - A separate call uses the paid AI's built-in **computer-use (click-here) tool**, with a 256-token answer.
  - The screenshot is resized to the standard size closest to the screen's shape: **1024×768, 1280×800 or 1366×768**, sent as JPEG quality 0.85.
  - The model is trained to click at those sizes, so its coordinates are more accurate than a general "point" answer.
  - It is one call, with no second check.
- **For Lefty on Windows, three options:**
  - **(a) Snap to a real element:** after the AI points from the screenshot, look for a UI Automation element near the guess whose name matches the step ("Red", "Search Extensions"), and point at that instead. Clicky can't do this; Windows gives it to us. This is cheap, free, and probably fixes both misses.
  - **(b) Zoom and refine:** crop around the guess, send the crop at higher resolution, and ask again for a precise point. One extra call, only when there's no element to snap to.
  - **(c) A paid computer-use model for pointing,** at Clicky's standard sizes. It costs money, so it stays optional.
- **Recommendation:** (a) now, (b) as the fallback.

### 2. Flight animation and speech bubble (pure overlay work, no Windows issues)
- **Clicky's numbers:**
  - Lefty follows the mouse 60 times a second, offset by +35, +25.
  - **Flight:** a curved path whose bend is the midpoint raised by `min(distance × 0.2, 80)` px.
  - **Flight duration:** `min(max(distance / 800, 0.6), 1.4)` s, with smoothstep easing (`3t² − 2t³`).
  - **During flight:** the tip **rotates along the path**, and the buddy **grows to 1.3×** halfway (`1 + sin(progress × π) × 0.3`).
  - **Landing:** the bubble pops in from 0.5× with a spring, and the text types out at 0.03–0.06 s per letter.
  - **After landing:** the bubble holds 3 s, fades over 0.5 s, then the buddy flies back. Moving the mouse more than 100 px cancels the flight back.
- **Lefty today:** a straight 0.5 s CSS glide. Swapping in the curve, rotation and grow effect in `overlay.js` makes him feel alive. The bubble fits next to our step tag.

### 3. Voice: hold a key, talk, and hear the answer
- **How Clicky does it:**
  - Push-to-talk on Ctrl+Option.
  - AssemblyAI live transcription (`u3-rt-pro`), with a short-lived token from the Worker (480 s).
  - ElevenLabs speech (`eleven_flash_v2_5`).
  - Replies written for speaking: lowercase, no lists or emojis, and never "simply" or "just".
- **On Windows:**
  - **Hotkey:** uiohook already gives key down and up. Holding a combination for push-to-talk needs a pick that doesn't clash: Ctrl+Space toggles Lefty, and Ctrl+Shift is taken on your PC. Ctrl+Alt is one option, but it's AltGr on some keyboards.
  - **Microphone:** `getUserMedia` in the overlay. Windows asks for the microphone once, under Privacy & security settings.
  - **Free speech to text:** Gemini accepts audio, so send the recording **with the screenshot in one request**. No AssemblyAI, and no extra wait.
  - **Free text to speech:** Chromium's `speechSynthesis` uses the Windows voices (Windows 11 has natural voices). Gemini TTS or ElevenLabs could be an optional upgrade.
  - **Fallback:** typing in the chat still works when there's no microphone.

### 4. Every screen, not just one
- **How Clicky does it:**
  - It captures all screens.
  - Each picture is labelled with its size, and the one with the mouse is marked "primary focus".
  - The AI may add `screenN` to point at another screen.
  - It uses one overlay window per screen.
- **On Windows:**
  - `desktopCapturer` already lists every screen.
  - Lefty has one overlay window that moves to the mouse's screen. He would need one per display, plus a prompt rule for which screen to point at.
  - Today Lefty says "it's on your other screen", so this would replace that.

### 5. Remember the conversation across goals
- **Clicky:** sends the last **10 exchanges** with every request.
- **Lefty:** remembers steps only within one goal, so "now make it red" after "add a table" starts fresh.
- **Idea:** keep the last few goals and answers per app and send them along. Cheap, and makes follow-up questions work.

### 6. Buddy mode: Lefty stays next to the mouse
- **Clicky:** the buddy always follows the cursor, or in "transient" mode appears on the hotkey and fades out 1 s after it's done.
- **Lefty:** appears only on Ctrl+Space.
- **Idea:** an optional setting where a small Lefty trails the mouse; Ctrl+Space opens the chat. The overlay already gets mouse moves over the whole screen. Stay hidden during fullscreen games, as now.

### 7. Little touches
- **States on the buddy:** a sound-wave while listening and a spinner while thinking, instead of only the step tag.
- **Prompt style:**
  - "Err on the side of pointing" and an explicit `[POINT:none]`, so answers point more often.
  - No yes/no follow-up questions: end by suggesting a bigger next step. That would suit Lefty's "What next?" messages.
- **First-run demo:** on first launch, Lefty points at something real on the screen with a playful 3–6 word comment, so people see what he does at once.
- **Fallback voice:** when the paid voice fails (credits run out), the built-in Windows voice says so.
- **Warm-up:** Clicky warms its connection first. Lefty already sends a warm-up request on summon.

### 8. Hosting the backend
- **Clicky:** runs its proxy on **Cloudflare Workers** (free tier, `wrangler dev` on localhost:8787, keys stored with `wrangler secret put`).
- **For Lefty:** our `server/index.js` could be ported to a Worker. `brain.js` calls Gemini with plain `fetch`; only the file reading and `Buffer` parts need small changes.
- **Why it suits us:** Workers have no cold start, unlike free Render or Railway plans, which sleep and add about 30 s to the first answer.
- **What we keep that Clicky's Worker lacks:** our app token, per-device limits and no-logging rules.

## Leave out

- **Mac-only details** (ScreenCaptureKit, the menu bar panel, macOS permission prompts, workspaces). On Windows there is no Accessibility or Screen Recording permission step. The closest thing is the microphone switch in Privacy settings.
- **Three paid services by default.** Gemini can do speech in, and Windows can do speech out, for free.
- **PostHog analytics,** at least until there's a privacy notice.

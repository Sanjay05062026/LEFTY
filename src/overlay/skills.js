// Lefty's goal loop, decision side: a "skill" looks at the current screen and decides the next step, again
// and again, until the goal is really done — not until a fixed list of steps runs out.
//
//   decide(job, seen)    -> { id, kind, label, count?, target } | { id, kind: 'tell', label } (no target: a key to press)
//                           | { id, kind: 'open', app } | { id, kind: 'code', code } (ghost code to type over)
//                           | { wait, thinking? } | { stuck } | { giveUp } | { say } | { done, message?, cancelled? }
//   noteEvent(job, ev)   -> records what the user did: { type: 'click', hit, point, element, elements, decisionId }
//                           | { type: 'key', combo } | { type: 'typing' } | { type: 'opened', app } | { type: 'coded' }
//
// Standard Save/Open dialogs are coached for every goal (dialogs.js). Saving and typed paths are built in; any
// other goal goes to the AI brain (aiSkill), which asks the AI for one step at a time.
// Pure functions: loaded by the overlay page and by Node tests.

(function (root) {
  const Match = root.LeftyMatch || require('./match');
  const Dialogs = root.LeftyDialogs || require('./dialogs');

  const DIALOG_WAIT_MS = 1500; // after a click that may open a dialog, how long it may take to appear
  const nameOf = (el) => String((el && el.name) || '').trim();
  const inside = (rect, point) => Boolean(rect && point) && point.x >= rect.x && point.y >= rect.y
    && point.x <= rect.x + rect.w && point.y <= rect.y + rect.h;

  // Window titles of documents that were never saved, or have unsaved changes.
  function looksUnsaved(title) {
    const text = String(title || '').trim();
    return /\buntitled\b/i.test(text) || /^(document|book|presentation)\d+\b/i.test(text)
      || /^[*●•]/.test(text) || /[*●•]\s*[-–—|]/.test(text) || /\*$/.test(text);
  }

  // Shared by every job: a Save/Open dialog on screen is coached until it closes, then the skill continues.
  function decide(job, seen) {
    const m = job.memory;
    const elements = seen.elements || [];
    if (Dialogs.dialogKind(elements)) {
      if (!m.dialogOpen) { m.dialog = {}; m.dialogOpen = true; m.dialogSeen = true; }
      return Dialogs.coach(elements, m.dialog);
    }
    if (m.dialogOpen) {
      m.dialogOpen = false;
      m.dialogCancelled = Boolean(m.dialog && m.dialog.cancelled);
    }
    return job.skill.next(seen, m);
  }

  function noteEvent(job, event) {
    const m = job.memory;
    if (m.dialogOpen && m.dialog) Dialogs.noteEvent(m.dialog, event);
    if (job.skill.onEvent) job.skill.onEvent(m, event);
  }

  // A path the user typed: "File > Save as". Each step is found on the current screen; a click on a later
  // step counts for everything before it; a dialog opened by the last step is coached to the end.
  function pathSkill(steps) {
    const advance = (m, j, name) => { m.index = j + 1; m.lastName = name; m.lastAt = Date.now(); };
    return {
      name: 'path',
      onEvent(m, event) {
        if (event.type !== 'click') return;
        const i = m.index || 0;
        if (event.hit && event.decisionId === `path:${i}`) { advance(m, i, event.targetName); return; }
        for (let j = i + 1; j < steps.length; j += 1) {
          const later = Match.findTarget(steps[j], event.elements || []);
          if (later && inside(later.rect, event.point)) { advance(m, j, later.name); return; }
        }
      },
      next(seen, m) {
        const i = m.index || 0;
        if (i >= steps.length) {
          if (m.dialogSeen) return m.dialogCancelled ? { done: true, cancelled: true } : { done: true };
          if (Dialogs.mayOpenDialog(m.lastName) && Date.now() - m.lastAt < DIALOG_WAIT_MS) return { wait: true };
          return { done: true };
        }
        // This step, or the next one if this one got done another way (a shortcut key).
        for (let j = i; j < Math.min(i + 2, steps.length); j += 1) {
          const target = Match.findTarget(steps[j], seen.elements || []);
          if (!target) continue;
          if (j > i) m.index = j;
          return { id: `path:${j}`, kind: 'click', label: target.name || target.type, count: steps.length > 1 ? `${j + 1}/${steps.length}` : '', target };
        }
        return { stuck: `I can't spot "${steps[i]}" right now. 🤔` };
      },
    };
  }

  // "Save this": done only when the save really happened — the Save dialog finished and the title no longer
  // says Untitled, or Save was clicked / Ctrl+S pressed on a named document and no dialog was needed.
  function saveSkill(goal) {
    const preferSaveAs = /\bsave\s+(it\s+|this\s+|file\s+)?as\b/i.test(String(goal || ''));
    const isSaveItem = (el) => ['MenuItem', 'Button', 'SplitButton'].includes(el.type) && el.enabled !== false;
    return {
      name: 'save',
      onEvent(m, event) {
        if (event.type === 'key' && /^Ctrl\+(Shift\+)?S$/.test(event.combo)) m.saveAt = Date.now();
        if (event.type === 'click' && event.element && isSaveItem(event.element)
          && /^save( as)?(\.\.\.|…)?$/i.test(nameOf(event.element))) m.saveAt = Date.now();
      },
      next(seen, m) {
        const title = seen.title || '';
        if (m.dialogSeen && !m.dialogOpen) {
          if (!m.dialogCancelled && !looksUnsaved(title)) return { done: true, message: '🎉 Saved!' };
          m.dialogSeen = false; // cancelled, or still untitled: go round again
          m.dialogCancelled = false;
          m.saveAt = 0;
        }
        if (m.saveAt && !m.dialogSeen) {
          if (Date.now() - m.saveAt < DIALOG_WAIT_MS) return { wait: true }; // a Save dialog may be opening
          if (!looksUnsaved(title)) return { done: true, message: '🎉 Saved!' };
          m.saveAt = 0;
        }
        const elements = seen.elements || [];
        const saveAs = elements.find((el) => isSaveItem(el) && /^save as(\.\.\.|…)?$/i.test(nameOf(el)));
        const save = elements.find((el) => isSaveItem(el) && /^save(\.\.\.|…)?$/i.test(nameOf(el)));
        const pick = preferSaveAs ? (saveAs || save) : (save || saveAs);
        if (pick) return { id: 'save:save', kind: 'click', label: `${nameOf(pick)} 💾`, target: pick };
        const file = elements.find((el) => ['MenuItem', 'Button', 'TabItem'].includes(el.type) && /^file$/i.test(nameOf(el)));
        if (file) return { id: 'save:file', kind: 'click', label: 'File', target: file };
        return { stuck: "I can't find a Save button here. Try Ctrl+S ⌨️" };
      },
    };
  }

  /* ---------- The AI brain as a skill ----------
     The AI sees the screen and says the one next step; Lefty points at it and watches. When the user has done
     it (clicked the target, typed and paused or pressed Enter, pressed the shortcut), Lefty looks again and
     asks for the next step, until the AI sees the goal is done. think(request) -> Promise<answer> is supplied by
     the overlay (it reaches the AI through the main process); answers arrive later, so while one is on its
     way the skill says { wait, thinking } and calls memory.wake() when it lands. */
  const AI_MAX_ASKS = 200;         // only a safety stop for a loop that never ends; real goals never get near it
  const TYPING_PAUSE_MS = 2500;    // typing that stops this long counts as "typed it"
  const AI_MISSES_BEFORE_ASK = 3;  // looks without the target on screen before asking the AI again

  const sameThing = (a, b) => a.type === b.type && nameOf(a) === nameOf(b);
  const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  // Finds the target the AI chose on the current screen (it may have moved), nearest to where it was.
  function locate(target, elements) {
    if (target.type === 'Spot') return target;
    const matches = elements.filter((el) => el.rect && sameThing(el, target));
    if (!matches.length) return null;
    return matches.reduce((best, el) => (distance(el.rect, target.rect) < distance(best.rect, target.rect) ? el : best));
  }

  function aiSkill(goal, think, { now = Date.now } = {}) {
    function completeStep(m, done) {
      m.history.push(done);
      m.stepNo += 1;
      m.stale = true;
      m.typedAt = 0;
      m.boxClicked = false;
      m.misses = 0;
      m.offClicks = 0;
      m.note = '';
    }
    function askBrain(m) {
      if (m.asks >= AI_MAX_ASKS) {
        m.failed = "I seem to be going round in circles, so I'll stop here. 😅 Tell me the goal again and we'll start fresh.";
        return;
      }
      m.asks += 1;
      m.pending = true;
      m.stale = false;
      const note = m.note;
      m.note = '';
      let call;
      try { call = Promise.resolve(think({ goal, history: m.history.slice(), note })); } catch (error) { call = Promise.reject(error); }
      call
        .then((answer) => {
          if (answer && answer.ok) { m.answer = answer; m.offClicks = 0; }
          else m.failed = (answer && answer.error) || 'My brain had a hiccup. 😵 Try again in a moment.';
        })
        .catch(() => { m.failed = 'My brain had a hiccup. 😵 Try again in a moment.'; })
        .then(() => {
          m.pending = false;
          if (m.wake) m.wake();
        });
    }
    const stepText = (a) => a.instruction || (a.target && a.target.name) || 'the next step';

    return {
      name: 'ai',
      wantsTyping: true,
      onEvent(m, event) {
        const a = m.answer;
        if (m.pending || !a || a.status !== 'step' || m.stale) return;
        const isCurrent = event.decisionId === `ai:${m.stepNo}`;
        // Ghost code is typed over many lines, with Enter, Escape (closing the editor's suggestions) and clicks
        // along the way: only typing the last line finishes it.
        if (a.action === 'write_code') {
          if (event.type === 'coded' && isCurrent) m.codeDone = true;
          return;
        }
        if (event.type === 'click') {
          if (event.hit && isCurrent) {
            if (a.action === 'type') { m.boxClicked = true; return; } // now they type
            // A guessed spot may have missed: the brain checks the screenshot instead of trusting the click.
            completeStep(m, a.target && a.target.type === 'Spot'
              ? `${stepText(a)} (the user clicked the spot you guessed from the screenshot: check in the new screenshot that it really worked)`
              : `${stepText(a)} (done: the user clicked "${a.target ? nameOf(a.target) : 'it'}")`);
            return;
          }
          const where = event.element && nameOf(event.element) ? ` on ${event.element.type} "${nameOf(event.element)}"` : '';
          // A stray click doesn't finish a step (people click around to read); a second one means they've moved
          // on, so Lefty looks afresh. A shortcut step is finished by the shortcut, not by clicks.
          m.note = `the user clicked${where}${a.target ? ' instead of the target' : ''}`;
          m.offClicks = (m.offClicks || 0) + 1;
          if (m.offClicks >= 2) { m.offClicks = 0; m.stale = true; } // they're doing something else: look afresh
          return;
        }
        if (event.type === 'typing') {
          if (a.action === 'type') m.typedAt = now();
          return;
        }
        if (event.type === 'opened') { // Lefty switched to (or opened) the app the goal is about
          if (a.action === 'open_app' && isCurrent) completeStep(m, `Open ${event.app} (done: ${event.app} is now in front)`);
          return;
        }
        if (event.type === 'key') {
          if (event.combo === 'Enter') completeStep(m, `${stepText(a)} (the user pressed Enter)`);
          else if (event.combo === 'Escape') { m.note = 'the user pressed Escape'; m.stale = true; }
          else if (a.action === 'key') completeStep(m, `${stepText(a)} (the user pressed a shortcut)`);
          else if (/^Ctrl\+/.test(event.combo)) { m.note = `the user pressed ${event.combo}`; m.stale = true; }
        }
      },
      next(seen, m) {
        if (!m.history) Object.assign(m, { history: [], stepNo: 0, asks: 0, misses: 0 });
        if (m.failed) return { giveUp: m.failed };
        if (m.pending) return { wait: true, thinking: true };
        const a = m.answer;
        if (a && a.status === 'step' && a.action === 'type' && m.typedAt && now() - m.typedAt > TYPING_PAUSE_MS) {
          completeStep(m, `${stepText(a)} (the user typed something)`);
        }
        if (!a || m.stale) {
          askBrain(m);
          return m.failed ? { giveUp: m.failed } : { wait: true, thinking: true };
        }
        if (a.status === 'done') return { done: true, message: a.message ? `🎉 ${a.message}` : '🎉 Done!' };
        if (m.codeDone) return { done: true, message: '🎉 You wrote it all yourself! Run it to see it work.' };
        // An answer to a question, or a question back ("what should I tell you?"): said in the chat, no guide.
        if (a.status === 'answer' || a.status === 'need_user') return { say: a.message || 'What would you like to do? 🙂' };
        if (a.status !== 'step') return { giveUp: a.message || "I can't see how to do that here. 🤔" };

        const id = `ai:${m.stepNo}`;
        // The keys or text go on the tag too, unless the instruction already says them ("Press Ctrl+B ⌨️").
        const says = (extra) => stepText(a).toLowerCase().includes(extra.toLowerCase());
        const label = a.action === 'key' && a.text && !says(a.text) ? `${stepText(a)} ⌨️ ${a.text}`
          : a.action === 'type' && a.text && !says(a.text) ? `${stepText(a)}: "${a.text}"` : stepText(a);
        if (a.action === 'open_app' && a.app) return { id, kind: 'open', app: a.app, label: a.instruction || `Open ${a.app} 🚀` };
        if (a.action === 'check_code') return { id, kind: 'doctor', label: a.instruction || 'Checking your code 🩺' };
        if (a.action === 'write_code') {
          return a.code ? { id, kind: 'code', code: a.code, label: a.instruction || 'Type along with me 👻' }
            : { giveUp: "I couldn't write that code just now. 😕 Ask me again?" };
        }
        if (!a.target) return { id, kind: 'tell', label };
        // When the app refused to be read just now, the chosen target can't be checked: keep pointing at it.
        const target = seen.unread ? a.target : locate(a.target, seen.elements || []);
        if (!target) {
          m.misses += 1;
          if (m.misses >= AI_MISSES_BEFORE_ASK) { m.note = m.note || 'the screen changed'; m.stale = true; }
          return { wait: true };
        }
        m.misses = 0;
        const kind = a.action === 'type' ? 'type' : 'click';
        return { id, kind, label, target };
      },
    };
  }

  // Typed in a hurry: "sav ths", "svae it" and "saev" all mean save. Real words one letter away ("safe", "same",
  // "have") don't.
  const NOT_SAVE = new Set(['safe', 'same', 'sale', 'sane', 'sage', 'salve', 'slave', 'have', 'gave', 'cave', 'wave', 'pave', 'rave', 'shave', 'saved', 'saves']);
  function typoDistance(a, b) { // edits (insert, delete, change, swap two neighbours) to turn a into b
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j += 1) d[0][j] = j;
    for (let i = 1; i <= a.length; i += 1) {
      for (let j = 1; j <= b.length; j += 1) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
    return d[a.length][b.length];
  }

  function isSaveGoal(goal) {
    const words = String(goal || '').toLowerCase().match(/[a-z]+/g) || [];
    return words.some((word) => word === 'save'
      || (word.length >= 3 && word[0] === 's' && !NOT_SAVE.has(word) && typoDistance(word, 'save') <= 1));
  }

  // "Find the error", "why isnt this workng", "fix my bug", "debug": a request for the code doctor (in a code editor).
  // Typed in a hurry too: "eror", "erros", "probelm".
  const CHECK_WORDS = ['error', 'errors', 'bug', 'bugs', 'debug', 'problem', 'problems', 'mistake', 'mistakes', 'issue', 'issues', 'wrong', 'broken', 'fix'];
  function isCodeCheckGoal(goal) {
    const text = String(goal || '').toLowerCase();
    if (/\b(not|isn'?t|doesn'?t|dont|wont|won'?t|cant|can'?t)\b(\s+\w+){0,2}\s+(work|working|run|running|compil\w*)/.test(text)) return true;
    const words = text.match(/[a-z]+/g) || [];
    if (words.some((w) => ['write', 'create', 'make', 'build', 'generate'].includes(w))) return false; // "write code to fix..." is new code
    return words.some((w) => CHECK_WORDS.includes(w) || (w.length >= 4 && CHECK_WORDS.some((c) => c.length >= 5 && typoDistance(w, c) <= 1)));
  }

  const api = { decide, noteEvent, pathSkill, saveSkill, aiSkill, isSaveGoal, isCodeCheckGoal, looksUnsaved, typoDistance };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LeftySkills = api;
})(this);

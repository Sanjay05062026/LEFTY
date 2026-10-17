// Lefty's goal loop, decision side: a "skill" looks at the current screen and decides the next step, again
// and again, until the goal is really done — not until a fixed list of steps runs out.
//
//   decide(job, seen)    -> { id, kind, label, count?, target } | { wait } | { stuck } | { done, message?, cancelled? }
//   noteEvent(job, ev)   -> records what the user did: { type: 'click', hit, point, element, elements, decisionId }
//                           | { type: 'key', combo } | { type: 'typing' }
//
// Standard Save/Open dialogs are coached for every goal (dialogs.js). Today's skills are built in; the AI brain
// will be one more skill with the same two functions, able to take on any goal.
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

  function isSaveGoal(goal) {
    return /\bsave\b/i.test(String(goal || ''));
  }

  const api = { decide, noteEvent, pathSkill, saveSkill, isSaveGoal, looksUnsaved };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LeftySkills = api;
})(this);

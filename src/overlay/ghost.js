// Lefty's ghost code, deciding side: which code line the user's text cursor is on and what is left to type, so
// the overlay can draw the rest as faint text at the cursor, like an editor's inline suggestion.
//
//   const ghost = track(code, { gap = 1 })
//   ghost.update({ ln, col })  -> { row, total, items: [{ row, col, text, current }], lineDone, finished, waiting? }
//                                 | { off: true }
//   ghost.lock()                  typing started: the code stays where it is
//
// The editor won't share its text (VS Code hides it outside screen-reader mode), only the cursor's line and column
// (the status bar's "Ln 12, Col 5"). So progress is worked out from the cursor: on a line, the cursor's column
// minus the spaces before the code is what has been typed. The editor's own indenting is allowed for: right after
// Enter the cursor sits after the editor's auto-indent, which may be more or less than the code wants.
// Until the user starts typing, the code waits `gap` lines below the cursor (an empty VS Code file shows its own
// grey hint on the cursor's line) and follows the cursor around; Enter takes them down to it. If they start typing
// right where they are instead, the code moves up to meet them.
// Columns are 0-based; ln is 1-based like the editor's. Pure functions: loaded by the overlay page and by Node tests.

(function (root) {
  const indentOf = (line) => line.length - line.trimStart().length;

  function track(code, { gap = 1 } = {}) {
    const lines = String(code || '').split('\n');
    let anchor = null;    // { ln, col }: where the code's first line starts
    let locked = false;
    let started = false;  // the cursor has been on the code since typing began
    let row = null;       // the code line the cursor is on
    let indent = 0;       // spaces before the cursor's code on that line (the editor's auto-indent, or the user's)
    let typed = 0;        // characters of that line's code typed so far

    const want = (r) => (anchor.col - 1) + indentOf(lines[r]); // where line r's code starts
    const codeOf = (r) => lines[r].slice(indentOf(lines[r]));
    const linesFrom = (first) => {
      const items = [];
      for (let r = first; r < lines.length; r += 1) if (codeOf(r)) items.push({ row: r, col: want(r), text: codeOf(r), current: false });
      return items;
    };

    return {
      lock() { locked = true; },
      get locked() { return locked; },
      update({ ln, col }) {
        if (!Number.isFinite(ln) || !Number.isFinite(col)) return { off: true };
        if (!locked || !anchor) { anchor = { ln: ln + gap, col }; row = null; }
        let r = ln - anchor.ln;
        if (locked && !started && r < 0 && r >= -gap) { // typing right here: the code comes up to this line
          anchor.ln = ln;
          r = 0;
          row = 0;
          indent = anchor.col - 1;
          typed = 0;
        }
        if (locked && r >= 0) started = true;
        if (r < -gap || (started && r < 0) || r > lines.length) return { off: true };
        if (r < 0) { // before typing: the whole code waits below the cursor, Enter goes there
          const items = linesFrom(0);
          if (items[0] && items[0].row === 0) items[0].current = true;
          return { row: r, total: lines.length, items, lineDone: true, finished: false, waiting: true };
        }
        if (r === lines.length) return { row: r, total: lines.length, items: [], lineDone: true, finished: true }; // Enter after the last line
        const at = col - 1;
        if (r !== row) { row = r; indent = r === 0 && !locked ? anchor.col - 1 : at; typed = 0; }
        if (typed === 0 || at < indent) {
          if (at < indent) indent = at;                              // deleting indentation
          else if (indent < want(r)) indent = Math.min(at, want(r)); // typing spaces up to the code's indent
        }
        typed = Math.max(0, at - indent);
        const rest = codeOf(r);
        const lineDone = typed >= rest.length;
        const items = [];
        // Nothing typed yet: the code sits where it belongs, so a wrong indent shows as a gap or an overlap.
        if (!lineDone) items.push({ row: r, col: typed === 0 ? want(r) : at, text: typed === 0 ? rest : rest.slice(typed), current: true });
        items.push(...linesFrom(r + 1));
        return { row: r, total: lines.length, items, lineDone, finished: lineDone && r === lines.length - 1 };
      },
    };
  }

  const api = { track };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LeftyGhost = api;
})(this);

// Checks Lefty's ghost code tracker: from the text cursor's line and column alone, which code line the user is on and
// what is left to type, including the editor's own auto-indent. Run: npm run test:ghost

const { track } = require('../src/overlay/ghost');

let failed = 0;
function check(condition, message) {
  if (!condition) failed += 1;
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${message}`);
}

const code = [
  'class Node:',
  '    def __init__(self, data):',
  '        self.data = data',
  '',
  '    def show(self):',
  '        print(self.data)',
].join('\n');

// Before typing, the code follows the cursor; the first line sits at the cursor, the rest keep their indents.
let ghost = track(code, { gap: 0 });
let view = ghost.update({ ln: 3, col: 1 });
check(view.row === 0 && view.total === 6 && view.items[0].text === 'class Node:' && view.items[0].col === 0 && view.items[0].current, 'the first line sits at the cursor');
check(view.items[1].row === 1 && view.items[1].col === 4 && view.items[1].text === 'def __init__(self, data):', 'later lines keep their indent');
check(view.items.every((item) => item.text), 'blank code lines draw nothing');
view = ghost.update({ ln: 10, col: 1 });
check(view.row === 0 && view.items[0].text === 'class Node:', 'until typing starts, the code follows the cursor (clicked lower down)');

// Typing along: the line shrinks from the cursor.
ghost.lock();
view = ghost.update({ ln: 10, col: 6 });
check(view.items[0].current && view.items[0].text === ' Node:' && view.items[0].col === 5, 'typed "class": the rest of the line starts at the cursor');
view = ghost.update({ ln: 10, col: 12 });
check(view.lineDone && !view.finished && view.items[0].row === 1, 'line typed: no current line left, Enter is next');
check(ghost.update({ ln: 4, col: 1 }).off, 'after typing starts, the cursor going above the code hides it (the code stays put)');

// Enter: VS Code auto-indents 4 spaces, as the code wants.
view = ghost.update({ ln: 11, col: 5 });
check(view.row === 1 && view.items[0].col === 4 && view.items[0].text === 'def __init__(self, data):', 'after Enter with the right auto-indent, the whole line waits at the cursor');
view = ghost.update({ ln: 11, col: 8 });
check(view.items[0].text === ' __init__(self, data):' && view.items[0].col === 7, 'typed "def": the rest follows');

// Enter: no auto-indent (a plain text file) -> the code waits at its indent, a gap shows; spaces count as indent.
ghost = track(code, { gap: 0 });
ghost.update({ ln: 1, col: 1 });
ghost.lock();
ghost.update({ ln: 1, col: 12 });
view = ghost.update({ ln: 2, col: 1 });
check(view.items[0].col === 4 && view.items[0].text === 'def __init__(self, data):', 'no auto-indent: the line waits at its indent (a visible gap to the cursor)');
view = ghost.update({ ln: 2, col: 3 });
check(view.items[0].col === 4 && view.items[0].text === 'def __init__(self, data):', 'spaces typed toward the indent are not code');
view = ghost.update({ ln: 2, col: 5 });
check(view.items[0].text === 'def __init__(self, data):', 'indent reached: still nothing typed');
view = ghost.update({ ln: 2, col: 6 });
check(view.items[0].text === 'ef __init__(self, data):' && view.items[0].col === 5, 'then letters count');

// Too much auto-indent (VS Code kept 8 spaces where the code wants 4): the line waits at 4, left of the cursor;
// Backspace (4 spaces at once) fixes it.
ghost = track(code, { gap: 0 });
ghost.update({ ln: 1, col: 1 });
ghost.lock();
view = ghost.update({ ln: 5, col: 9 });
check(view.row === 4 && view.items[0].col === 4 && view.items[0].text === 'def show(self):', 'too much indent: the line waits at its own indent');
view = ghost.update({ ln: 5, col: 5 });
check(view.items[0].col === 4 && view.items[0].text === 'def show(self):', 'Backspace removed the extra indent: nothing counted as typed');
view = ghost.update({ ln: 5, col: 9 });
check(view.items[0].text === 'show(self):' && view.items[0].col === 8, 'then typing "def " counts');
view = ghost.update({ ln: 5, col: 6 });
check(view.items[0].text === 'ef show(self):', 'Backspace over typed letters gives them back');

// A blank code line is done at once; Enter after the last line, or typing all of it, finishes.
ghost = track(code, { gap: 0 });
ghost.update({ ln: 1, col: 1 });
ghost.lock();
view = ghost.update({ ln: 4, col: 9 });
check(view.row === 3 && view.lineDone && !view.finished, 'a blank code line needs only Enter');
view = ghost.update({ ln: 6, col: 9 });
check(view.items.length === 1 && view.items[0].text === 'print(self.data)', 'on the last line only it is left');
view = ghost.update({ ln: 6, col: 25 });
check(view.finished, 'typing the last line finishes the code');
check(ghost.update({ ln: 7, col: 1 }).finished, 'Enter after the last line finishes it too');

// Code indented inside a block: the cursor's column is the base for every line.
ghost = track('if ok:\n    go()', { gap: 0 });
view = ghost.update({ ln: 20, col: 5 });
check(view.items[0].col === 4 && view.items[1].col === 8, 'started at column 5: every line is shifted by 4');

check(track(code, { gap: 0 }).update({}).off, 'no cursor position: nothing drawn');

// Lefty's default: the code waits one line below the cursor (VS Code's grey hint sits on an empty file's first
// line), Enter goes down to it, and typing right where the cursor is brings the code up instead.
ghost = track(code);
view = ghost.update({ ln: 1, col: 1 });
check(view.waiting && view.row === -1 && view.items[0].row === 0 && view.items[0].current && view.lineDone, 'before typing, the code waits one line below the cursor, with ↵ at the cursor');
view = ghost.update({ ln: 4, col: 1 });
check(view.waiting && view.row === -1, 'it keeps following the cursor, one line below');
ghost.lock(); // Enter
view = ghost.update({ ln: 5, col: 1 });
check(!view.waiting && view.row === 0 && view.items[0].text === 'class Node:' && view.items[0].col === 0, 'Enter goes down to the code: line 1 is next');
view = ghost.update({ ln: 5, col: 6 });
check(view.items[0].text === ' Node:', 'and typing there works as usual');
check(ghost.update({ ln: 4, col: 1 }).off, 'once typing started, the line above the code is not part of it');

ghost = track(code);
ghost.update({ ln: 1, col: 1 });
ghost.lock(); // a letter typed on the cursor's own line
view = ghost.update({ ln: 1, col: 2 });
check(!view.waiting && view.row === 0 && view.items[0].text === 'lass Node:' && view.items[0].col === 1, 'typing on the cursor line brings the code up to it (the letter counts)');
view = ghost.update({ ln: 2, col: 5 });
check(view.row === 1 && view.items[0].text === 'def __init__(self, data):', 'and the next lines follow from there');

console.log(failed ? `\n${failed} check(s) failed` : '\nall ghost checks passed');
process.exit(failed ? 1 : 0);

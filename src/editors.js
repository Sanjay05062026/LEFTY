// The code editors Lefty knows, in one place: which process is which editor, how it says "go to line", and what
// its text looks like by default. Used by the main process (reading the file, jumping to a line, the editor's
// font) and by the overlay (ghost code, the code doctor).
//
//   find(process)        -> the editor that process belongs to, or null
//   describe(process)    -> a name for the user ("VS Code", "Notepad++", "your editor")
//   gotoKeys(process, line, col) -> the keys that put the cursor on that line
//   fontOf(process, settings)    -> { fontFamily, fontSize, lineHeight, letterSpacing, light }
//   settingsFolder(process)      -> the %APPDATA% folder holding settings.json, for editors that have one
//
// Lefty does not refuse to work in an editor that isn't listed here. Ghost code needs two things from an editor,
// both read through Windows UI Automation: the rectangle of the cursor's line, and "Ln 12, Col 5" somewhere in
// its status bar. Any editor that reports those is followed, with the generic defaults below; a listed editor
// just starts from better numbers. The font is checked against the real height of the cursor's line and rescaled
// when it disagrees, so a wrong default corrects itself rather than drawing the code in the wrong place.
// Pure functions: loaded by the overlay page and by Node tests.

(function (root) {
  // One entry per editor family. processes: the .exe name in lower case, as Windows reports it.
  const EDITORS = [
    {
      id: 'vscode',
      label: 'VS Code',
      // VS Code and the editors built on it: they keep VS Code's settings file, in their own folder.
      processes: ['code', 'code - insiders', 'cursor', 'windsurf', 'vscodium', 'trae'],
      labels: { 'code - insiders': 'VS Code Insiders', cursor: 'Cursor', windsurf: 'Windsurf', vscodium: 'VSCodium', trae: 'Trae' },
      folders: { code: 'Code', 'code - insiders': 'Code - Insiders', cursor: 'Cursor', windsurf: 'Windsurf', vscodium: 'VSCodium', trae: 'Trae' },
      titles: [/\s[-–—]\s(Visual Studio Code|Cursor|Windsurf|VSCodium|Trae)$/],
      goto: 'line-col',   // Ctrl+G, then "12:5"
      newFile: ['ctrl+n'], // a blank untitled tab
      font: { fontFamily: "Consolas, 'Courier New', monospace", fontSize: 14, lineHeight: 19 },
    },
    {
      id: 'notepad',
      label: 'Notepad',
      processes: ['notepad'],
      titles: [/\s[-–—]\sNotepad$/],
      goto: 'line',       // Ctrl+G opens a dialog with a line box
      newFile: ['ctrl+n'],
      font: { fontFamily: "Consolas, 'Courier New', monospace", fontSize: 11, lineHeight: 15 },
    },
    {
      id: 'notepadpp',
      label: 'Notepad++',
      processes: ['notepad++'],
      titles: [/\s[-–—]\sNotepad\+\+$/],
      goto: 'line',
      newFile: ['ctrl+n'],
      font: { fontFamily: "'Courier New', Consolas, monospace", fontSize: 11, lineHeight: 14 },
    },
    {
      id: 'sublime',
      label: 'Sublime Text',
      processes: ['sublime_text'],
      titles: [/\s[-–—]\sSublime Text(\s|$)/],
      goto: 'line',       // Ctrl+G opens the ":" prompt
      newFile: ['ctrl+n'],
      font: { fontFamily: "Consolas, 'Courier New', monospace", fontSize: 10, lineHeight: 14 },
    },
    {
      id: 'jetbrains',
      label: 'JetBrains IDE',
      // The 64-bit launchers, and the plain names older builds use.
      processes: ['pycharm64', 'pycharm', 'idea64', 'idea', 'webstorm64', 'webstorm', 'phpstorm64', 'phpstorm',
        'clion64', 'clion', 'rider64', 'rider', 'rubymine64', 'rubymine', 'goland64', 'goland', 'datagrip64', 'studio64'],
      labels: {
        pycharm64: 'PyCharm', pycharm: 'PyCharm', idea64: 'IntelliJ IDEA', idea: 'IntelliJ IDEA',
        webstorm64: 'WebStorm', webstorm: 'WebStorm', phpstorm64: 'PhpStorm', phpstorm: 'PhpStorm',
        clion64: 'CLion', clion: 'CLion', rider64: 'Rider', rider: 'Rider', rubymine64: 'RubyMine',
        rubymine: 'RubyMine', goland64: 'GoLand', goland: 'GoLand', datagrip64: 'DataGrip', studio64: 'Android Studio',
      },
      titles: [/\s[-–—]\s(PyCharm|IntelliJ IDEA|WebStorm|PhpStorm|CLion|Rider|RubyMine|GoLand|DataGrip|Android Studio)(\s|$)/],
      goto: 'line-col',   // Ctrl+G, then "12:5"
      newFile: null,      // Ctrl+N here is "go to class"; a new file needs the project tree
      font: { fontFamily: "'JetBrains Mono', Consolas, monospace", fontSize: 13, lineHeight: 16 },
      // The JetBrains IDEs only answer UI Automation with their accessibility bridge switched on. When it is off
      // Lefty can't see the cursor, so the code goes in the chat instead.
      needsAccessibility: 'Help > Edit Custom VM Options, add -Dide.ui.accessibility=true, then restart the IDE',
    },
    {
      id: 'visualstudio',
      label: 'Visual Studio',
      processes: ['devenv'],
      titles: [/\s[-–—]\sMicrosoft Visual Studio(\s|$)/],
      goto: 'line',
      newFile: null,      // Ctrl+N opens a template picker, not a blank file
      font: { fontFamily: "'Cascadia Mono', Consolas, monospace", fontSize: 10, lineHeight: 14 },
    },
  ];

  // An editor Lefty has no entry for, but which tells him where the cursor is: followed on generic numbers.
  const GENERIC = {
    id: 'generic',
    label: 'your editor',
    processes: [],
    titles: [],
    goto: 'line',
    newFile: ['ctrl+n'], // near enough universal in a text editor, and the worst case is a spare tab
    font: { fontFamily: "Consolas, 'Courier New', monospace", fontSize: 12, lineHeight: 16 },
  };

  const key = (process) => String(process || '').toLowerCase().replace(/\.exe$/, '').trim();

  // The editor that process belongs to, or null when Lefty has no entry for it.
  function find(process) {
    const name = key(process);
    if (!name) return null;
    return EDITORS.find((editor) => editor.processes.includes(name)) || null;
  }

  // Same, but an unknown process still gets the generic entry, so Lefty can try.
  const findOrGeneric = (process) => find(process) || GENERIC;

  // Does this window title belong to a code editor? (The window title is all Lefty has before he reads the app.)
  function fromTitle(title) {
    const text = String(title || '');
    if (!text) return null;
    return EDITORS.find((editor) => editor.titles.some((pattern) => pattern.test(text))) || null;
  }

  // A name for the user: the exact product where Lefty can tell ("Cursor", "PyCharm"), else the family's name.
  function describe(process) {
    const editor = find(process);
    if (!editor) return GENERIC.label;
    return (editor.labels && editor.labels[key(process)]) || editor.label;
  }

  // Does this friendly app name ("VS Code", "PyCharm", read from the window) belong to an editor?
  function fromAppName(app) {
    const name = String(app || '').trim().toLowerCase();
    if (!name) return null;
    return EDITORS.find((editor) => editor.label.toLowerCase() === name
      || Object.values(editor.labels || {}).some((label) => label.toLowerCase() === name)) || null;
  }

  // Is the app Lefty is looking at a code editor? Either its title or its name has to say so.
  const isCodeEditor = ({ app, title } = {}) => Boolean(fromTitle(title) || fromAppName(app));

  const isKnown = (process) => Boolean(find(process));

  // The keys that take the cursor to a line: every editor here uses Ctrl+G, then either "12:5" or just "12".
  // The waits let the editor open its box and act on the Enter before Lefty looks again.
  function gotoKeys(process, line, col = 1) {
    const editor = findOrGeneric(process);
    const where = editor.goto === 'line-col' ? `${line}:${col}` : `${line}`;
    return ['ctrl+g', 'wait:150', `text:${where}`, 'wait:80', 'enter', 'wait:150'];
  }

  // The keys that open a blank file, or null where this editor has none that is safe to press. Code Lefty writes
  // himself goes in a file of its own: the file the user happens to have open is theirs, and 800 lines of someone's
  // SQL is no place for a Python function. Where there is no such key, he does not write at all.
  function newFileKeys(process) {
    const editor = findOrGeneric(process);
    return editor.newFile ? [...editor.newFile, 'wait:400'] : null;
  }

  const canNewFile = (process) => Boolean(findOrGeneric(process).newFile);

  // A name for the file, from what the code is: the brain's suggestion when it gave one, else the goal's own
  // words, else "lefty-code". Only letters, digits, dash and underscore survive, so it is always a usable name.
  const EXTENSIONS = {
    python: 'py', py: 'py', javascript: 'js', js: 'js', typescript: 'ts', ts: 'ts', java: 'java', c: 'c',
    'c++': 'cpp', cpp: 'cpp', 'c#': 'cs', csharp: 'cs', go: 'go', rust: 'rs', rs: 'rs', ruby: 'rb', php: 'php',
    sql: 'sql', html: 'html', css: 'css', json: 'json', shell: 'sh', bash: 'sh', kotlin: 'kt', swift: 'swift',
    r: 'r', scala: 'scala', dart: 'dart', lua: 'lua', perl: 'pl', text: 'txt',
  };

  const extensionFor = (lang) => EXTENSIONS[String(lang || '').trim().toLowerCase()] || '';

  // Words that say what to do, not what the thing is: "open pycharm and write ghost code for linear search in
  // python" is a file called linear-search.py.
  const NOT_A_NAME = new Set([
    'a', 'an', 'the', 'and', 'or', 'for', 'in', 'into', 'to', 'of', 'me', 'my', 'please', 'some', 'with', 'using',
    'open', 'write', 'make', 'create', 'build', 'give', 'add', 'show', 'do', 'new', 'file', 'code', 'ghost',
    'program', 'script', 'function', 'algorithm', 'implement', 'implementation', 'example',
    'vscode', 'vs', 'ide', 'editor', 'npp',
    ...Object.keys(EXTENSIONS),
    // and the editors' own names: "open pycharm and ..." is about where, not about what
    ...EDITORS.flatMap((editor) => [
      ...editor.processes,
      ...editor.label.toLowerCase().split(/\s+/),
      ...Object.values(editor.labels || {}).flatMap((label) => label.toLowerCase().split(/\s+/)),
    ]),
  ]);

  function fileName(suggested, { lang = '', fallback = '' } = {}) {
    const given = String(suggested || '').trim().split(/[\\/]/).pop();
    if (/^[\w.-]+\.[A-Za-z0-9]+$/.test(given)) return given; // the brain already named it
    const words = (given || fallback || '').toLowerCase().match(/[a-z0-9]+/g) || [];
    const kept = words.filter((w) => !NOT_A_NAME.has(w));
    const stem = (kept.length ? kept : words).slice(0, 3).join('-').slice(0, 40) || 'lefty-code';
    return `${stem}.${extensionFor(lang) || 'txt'}`;
  }

  // The first line of a file the user is going to type: a comment naming it. VS Code reports no cursor in a
  // completely empty file, so ghost code has nowhere to draw until there is a line of text.
  function starterLine(file) {
    const [, stem = 'code', ext = ''] = String(file || '').match(/^(.*?)(?:\.(\w+))?$/) || [];
    const name = stem.replace(/[-_]+/g, ' ').trim();
    const kind = ext.toLowerCase();
    if (['py', 'rb', 'sh', 'r', 'pl'].includes(kind)) return `# ${name}`;
    if (['sql', 'lua'].includes(kind)) return `-- ${name}`;
    if (kind === 'html') return `<!-- ${name} -->`;
    if (kind === 'css') return `/* ${name} */`;
    return `// ${name}`;
  }

  // "write it here", "add this to the current file": the user means the work they have open, not a new folder.
  const OPEN_WORK = /\b(?:here|this (?:file|folder|project|tab|window)|(?:the|my) (?:open|same|existing|current) (?:file|folder|project|tab|window)|(?:current|existing) (?:file|folder|project|tab|window))\b/i;
  const meansOpenWork = (goal) => OPEN_WORK.test(String(goal || ''));

  // Whether the cursor can be put on an exact column, or only on the line (the editor's Go To box takes a line).
  const canGotoColumn = (process) => findOrGeneric(process).goto === 'line-col';

  // The %APPDATA% folder with this editor's settings.json, for the editors that keep one Lefty can read.
  function settingsFolder(process) {
    const editor = find(process);
    return (editor && editor.folders && editor.folders[key(process)]) || null;
  }

  // The editor's text, from its settings when Lefty could read them, else the editor's own defaults.
  // VS Code's rules are used for the settings it understands; lineHeight 0 means 1.35 x the font size, and a
  // value under 8 is a multiple of the font size.
  function fontOf(process, settings = {}) {
    const base = findOrGeneric(process).font;
    const number = (value, fallback) => (Number.isFinite(value) ? value : fallback);
    const fontSize = number(settings['editor.fontSize'], base.fontSize);
    const setLine = number(settings['editor.lineHeight'], 0);
    const scale = fontSize / base.fontSize; // a bigger font keeps the editor's line spacing in proportion
    const lineHeight = Math.round(setLine === 0 ? Math.max(base.lineHeight * scale, fontSize * 1.15)
      : setLine < 8 ? setLine * fontSize : setLine);
    const zoom = 1.2 ** number(settings['window.zoomLevel'], 0);
    return {
      fontFamily: settings['editor.fontFamily'] || base.fontFamily,
      fontSize: fontSize * zoom,
      lineHeight: lineHeight * zoom,
      letterSpacing: number(settings['editor.letterSpacing'], 0) * zoom,
      light: /light/i.test(settings['workbench.colorTheme'] || ''),
    };
  }

  const api = { find, findOrGeneric, fromTitle, fromAppName, isCodeEditor, describe, isKnown, gotoKeys, canGotoColumn,
    newFileKeys, canNewFile, fileName, starterLine, meansOpenWork, extensionFor, settingsFolder, fontOf, EDITORS, GENERIC };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LeftyEditors = api;
})(this);

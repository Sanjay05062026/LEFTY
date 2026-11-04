// Do it mode, deciding side: for each step of a guide, what Lefty does himself (click, type, press keys, scroll) and
// what stays the user's: choices only they can make (what to name a file), private things (passwords, card numbers),
// and anything risky (delete, buy, send, install), which Lefty asks about before he does it.
//
//   plan(decision, access) -> { act: 'click', button, count, ask? } | { act: 'type', text, click, ask? } | { act: 'keys', keys, combo, ask? }
//                     | { act: 'scroll', notches } | { act: 'skip' } | { act: 'open' } | { act: 'code' } | { act: 'doctor' }
//                     | { yourTurn: 'choice' | 'private' | 'nothing' }
//   ask: a warning to show before acting ("This will delete things"); the user says yes or no.
//   keysFor('Ctrl+Shift+S') -> ['ctrl+shift+s'] (the native helper's spelling), or null for a combo it can't press.
//   spotOk(label, under) -> false when a spot the AI guessed lands on plain text or a canvas the step doesn't name.
//   statusFor(plan, decision) -> what Lefty is doing, in a few words, for the status bubble beside him.
// Pure functions: loaded by the overlay page and by Node tests.

(function (root) {
  const Guard = root.LeftyGuard || require('./guard');

  // How free Lefty is is the user's choice now, on the access button (settings.js):
  //   ask:  a yes before every move
  //   auto: a yes before moves that lose work or reach outside this PC: the click guard's list (guard.js: Delete,
  //         Don't Save, Empty Recycle Bin..., which knows "Reset zoom" is harmless), money, sending and posting,
  //         installing, and dangerous terminal commands. "Confirm", "Next" and "Sign up" are just done: a task
  //         that stops every other step to ask is not doing the task.
  //   full: no questions at all
  // Private boxes are the user's in all three: Lefty can't know a password anyway.
  const OUTSIDE_RISKS = [
    { reason: 'spends money', phrases: ['buy', 'buy now', 'pay', 'pay now', 'purchase', 'place order', 'checkout', 'check out', 'subscribe'] },
    { reason: 'sends it to someone', phrases: ['send', 'send now', 'post', 'publish', 'tweet', 'reply all'] },
    { reason: 'installs something on this PC', phrases: ['install', 'install now'] },
  ];
  // Commands that wipe things or can't be taken back, when Lefty types them.
  const DANGEROUS_COMMAND = /\b(rm\s+-\w*[rf]|rmdir\s+\/s|rd\s+\/s|del\s+\/[sfq]|remove-item\b.*-recurse|format\s+[a-z]:|mkfs|dd\s+if=|shutdown\b|git\s+push\b.*--force|git\s+reset\s+--hard|git\s+clean\s+-\w*f|drop\s+(table|database)|reg\s+delete|chmod\s+-r\s+777|curl\b.*\|\s*(ba)?sh)/i;

  // Boxes whose contents are the user's alone: Lefty never types into them.
  const PRIVATE = /pass(word|code|phrase)|\bpin\b|\bcvv|\bcvc|security code|card number|credit card|debit card|\botp\b|one.time (code|password)|verification code|\bssn\b|social security|bank account|routing number|\biban\b|api key|secret|\btoken\b/i;

  // Key presses that close or delete things.
  const RISKY_KEYS = new Set(['alt+f4', 'ctrl+w', 'ctrl+q', 'ctrl+shift+w', 'shift+delete', 'ctrl+shift+delete', 'delete']);

  const normalize = (text) => ` ${String(text || '').toLowerCase().replace(/[’']/g, '').replace(/\bdo not\b/g, 'dont')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `;

  // Kept so the tests and callers still have it: nothing is an "ask" phrase any more, only the click guard's
  // destructive names stop Lefty now.
  function askPhrase() { return null; }

  const isReal = (target) => Boolean(target) && target.type !== 'Spot' && target.type !== 'Area';

  // Why Lefty should ask before doing this step, or null. Looks at the thing he would click and at the step's words
  // (the AI's "Click Buy now"), since a guessed spot has no name of its own.
  function needsOk(target, label) {
    if (target && target.titleBar && /^close(\s|$)/i.test(String(target.name || '').trim())) return `"${String(target.name).trim()}" shuts the whole window`;
    const step = stepWords(label);
    const risk = (isReal(target) && Guard.riskOf(target)) || (step && Guard.riskOf({ name: step, type: 'Button', enabled: true }));
    if (risk) return risk.warning.replace(/^(Careful!|Heads up:)\s*/, '');
    for (const words of [isReal(target) ? target.name : '', step]) {
      const name = normalize(words);
      const outside = OUTSIDE_RISKS.find((rule) => rule.phrases.some((phrase) => name.includes(` ${phrase} `)));
      if (outside) return `"${String(words).trim()}" ${outside.reason}`;
    }
    return null; // nothing else is worth stopping a task for
  }

  // What Lefty does in a move, in words: as a verb to go in a question (present) or for the status bubble.
  function moveWords(steps, decision) {
    const t = decision && decision.target;
    const name = String((t && t.type !== 'Spot' && t.type !== 'Area' && t.name) || stepWords(decision && decision.label) || '').trim().slice(0, 40);
    const text = String(steps.text || '');
    switch (steps.act) {
      case 'click': return [steps.button === 'right' ? 'right-click' : steps.count === 2 ? 'double-click' : 'click', name];
      case 'type': return ['type', `"${text.length > 30 ? `${text.slice(0, 30)}…` : text}"`];
      case 'keys': return ['press', steps.combo];
      case 'scroll': return ['scroll', steps.notches > 0 ? 'up' : 'down'];
      default: return null;
    }
  }

  // What Lefty is doing right now, for the status bubble beside him: "Clicking Save…".
  function statusFor(steps, decision) {
    const words = steps && moveWords(steps, decision);
    if (!words) return '';
    const verb = words[0].replace(/e$/, '');
    return `${verb[0].toUpperCase()}${verb.slice(1)}ing ${words[1]}…`;
  }

  // The step's own words without the verb and emoji: "Click Buy now" -> "Buy now".
  function stepWords(label) {
    return stripEmoji(label).replace(/^(click|tap|press|select|choose|pick|hit|use)\s+(on\s+)?(the\s+)?/i, '').trim();
  }

  function stripEmoji(text) {
    return String(text || '').replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, '').replace(/\s+/g, ' ').trim();
  }

  function isPrivateBox(target, label) {
    return PRIVATE.test(String((target && target.name) || '')) || PRIVATE.test(stripEmoji(label));
  }

  const KEY_NAMES = {
    ctrl: 'ctrl', control: 'ctrl', shift: 'shift', alt: 'alt', win: 'win', windows: 'win', meta: 'win', cmd: 'win',
    enter: 'enter', return: 'enter', esc: 'escape', escape: 'escape', tab: 'tab', space: 'space', spacebar: 'space',
    backspace: 'backspace', delete: 'delete', del: 'delete', home: 'home', end: 'end', insert: 'insert', ins: 'insert',
    up: 'up', down: 'down', left: 'left', right: 'right', arrowup: 'up', arrowdown: 'down', arrowleft: 'left', arrowright: 'right',
    pageup: 'pageup', pgup: 'pageup', pagedown: 'pagedown', pgdn: 'pagedown', plus: 'plus', minus: 'minus',
    ',': ',', '.': '.', '/': '/', ';': ';', '[': '[', ']': ']', '\\': '\\', "'": "'", '`': '`', '-': 'minus', '=': '=',
  };
  for (let i = 1; i <= 12; i += 1) KEY_NAMES[`f${i}`] = `f${i}`;
  const MODIFIERS = new Set(['ctrl', 'shift', 'alt', 'win']);

  // "Ctrl+Shift+S" -> ['ctrl+shift+s']; "Ctrl++" -> ['ctrl+plus']; "Enter" -> ['enter']. Null when any part is unknown.
  function keysFor(combo) {
    let text = String(combo || '').trim().replace(/\s*\+\s*/g, '+');
    if (!text) return null;
    let parts;
    if (text.endsWith('++')) parts = [...text.slice(0, -2).split('+').filter(Boolean), 'plus'];
    else if (text === '+') parts = ['plus'];
    else parts = text.split('+');
    const keys = [];
    for (const part of parts) {
      const word = part.toLowerCase().replace(/\s+/g, '');
      const key = KEY_NAMES[word] || (/^[a-z0-9]$/.test(word) ? word : null);
      if (!key) return null;
      keys.push(key);
    }
    if (keys.length > 1 && MODIFIERS.has(keys[keys.length - 1])) return null; // "Ctrl+Shift" presses nothing
    return [keys.join('+')];
  }

  // A guessed spot is only clicked when what's under it fits the step: some control, or a plain area (text, canvas,
  // panel) whose name the step mentions. The AI sometimes imagines a dialog ("Click Don't Save") over a text editor.
  const PLAIN = new Set(['Document', 'Edit', 'Pane', 'Window', 'Custom', 'Group', 'Text', 'Image', 'Other']);
  const FILLER = new Set(['click', 'tap', 'press', 'select', 'choose', 'pick', 'open', 'go', 'use', 'hit', 'the', 'a', 'an',
    'on', 'in', 'at', 'to', 'of', 'for', 'and', 'or', 'it', 'this', 'that', 'here', 'there', 'now', 'button', 'icon']);
  const wordsOf = (text) => normalize(text).trim().split(' ').filter(Boolean);
  function spotOk(label, under, blind = false) {
    if (!under) return true; // couldn't look: the helper still checks the point is the app's
    // Some apps tell Windows nothing about themselves - the JetBrains IDEs, anything drawn in Java or a game
    // engine. Everything in them reads as one big "Pane", so this check would refuse every click in them and
    // Lefty would hand back every step. When the app is unreadable there is nothing to contradict the AI, so
    // what it saw in the screenshot is the best there is: he clicks.
    if (blind) return true;
    if (!PLAIN.has(under.type)) return true;
    const keys = wordsOf(stripEmoji(label)).filter((w) => w.length > 1 && !FILLER.has(w));
    if (!keys.length) return true; // "Click here"
    const name = new Set(wordsOf(under.name));
    return keys.some((k) => name.has(k));
  }

  // What Lefty does for this step, with the question the user's access setting calls for.
  function plan(decision, access = 'auto') {
    const steps = moves(decision);
    if (!MOVES.has(steps.act) || access === 'auto') return steps;
    if (access === 'full') return { ...steps, ask: null };
    return { ...steps, ask: steps.ask || `I'm about to ${moveWords(steps, decision).join(' ')}` };
  }
  const MOVES = new Set(['click', 'type', 'keys', 'scroll']);
  const PRESSED_NOT_TYPED = new Set(['Button', 'MenuItem', 'CheckBox', 'RadioButton', 'SplitButton', 'Hyperlink', 'Link', 'Tab', 'TabItem']);

  function moves(decision) {
    if (!decision) return { yourTurn: 'nothing' };
    const { kind, target, label } = decision;
    const action = decision.action || 'click';
    const text = String(decision.text || '');
    if (kind === 'open') return { act: 'open' };
    if (kind === 'code') return { act: 'code' };
    if (kind === 'doctor') return { act: 'doctor' };
    if (kind === 'choose') return { act: 'skip' }; // "Pick any folder": the folder the dialog opened in is fine
    if (kind === 'type' || (kind === 'tell' && action === 'type')) {
      if (decision.private || isPrivateBox(target, label)) return { yourTurn: 'private' };
      if (!text) return { yourTurn: 'choice' }; // what to type is the user's choice ("Name it anything")
      const command = DANGEROUS_COMMAND.test(text) ? `"${text.slice(0, 60)}" is a dangerous command` : null;
      // Only a box takes a click before typing: pressing Calculator's "1" and then typing 12*8= gives 112*8.
      const click = Boolean(target) && !PRESSED_NOT_TYPED.has(target.type);
      return { act: 'type', text, click, ask: command || needsOk(null, label) };
    }
    if (kind === 'tell') {
      const keys = action === 'key' ? keysFor(text) : null;
      if (!keys) return { yourTurn: 'nothing' }; // a step Lefty can't do himself
      const risky = RISKY_KEYS.has(keys[0]) ? `${text} closes or deletes things` : needsOk(null, label);
      return { act: 'keys', keys, combo: text, ask: risky };
    }
    if (!target) return { yourTurn: 'nothing' };
    if (action === 'scroll') return { act: 'scroll', notches: /\bup\b/i.test(`${text} ${label}`) ? 3 : -3 };
    return {
      act: 'click',
      button: action === 'right_click' ? 'right' : 'left',
      count: action === 'double_click' ? 2 : 1,
      ask: needsOk(target, label),
    };
  }

  const api = { plan, needsOk, isPrivateBox, keysFor, stripEmoji, spotOk, statusFor };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LeftyAuto = api;
})(this);

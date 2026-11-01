// Do it mode, deciding side: for each step of a guide, what Lefty does himself (click, type, press keys, scroll) and
// what stays the user's: choices only they can make (what to name a file), private things (passwords, card numbers),
// and anything risky (delete, buy, send, install), which Lefty asks about before he does it.
//
//   plan(decision) -> { act: 'click', button, count, ask? } | { act: 'type', text, click, ask? } | { act: 'keys', keys, combo, ask? }
//                     | { act: 'scroll', notches } | { act: 'skip' } | { act: 'open' } | { act: 'code' } | { act: 'doctor' }
//                     | { yourTurn: 'choice' | 'private' | 'nothing' }
//   ask: a warning to show before acting ("This will delete things"); the user says yes or no.
//   keysFor('Ctrl+Shift+S') -> ['ctrl+shift+s'] (the native helper's spelling), or null for a combo it can't press.
//   spotOk(label, under) -> false when a spot the AI guessed lands on plain text or a canvas the step doesn't name.
// Pure functions: loaded by the overlay page and by Node tests.

(function (root) {
  const Guard = root.LeftyGuard || require('./guard');

  // Actions that are the user's call even when nothing is lost: money, messages, installs, accounts, permissions.
  // (Things that throw work away - delete, don't save, reset - are the click guard's, guard.js, which knows that
  // "Reset zoom" or "Remove filter" are harmless.)
  const ASK_PHRASES = ['buy', 'buy now', 'purchase', 'pay', 'checkout', 'check out', 'place order', 'order now', 'send',
    'submit', 'post', 'publish', 'share', 'install', 'update', 'upgrade', 'subscribe', 'unsubscribe', 'accept',
    'agree', 'allow', 'grant', 'confirm', 'sign out', 'log out', 'logout', 'sign up', 'register', 'download', 'restart',
    'shut down', 'shutdown', 'reboot', 'transfer', 'donate', 'call', 'move to trash', 'move to recycle bin',
    'cancel subscription', 'cancel order', 'cancel membership', 'cancel plan', 'close account'];
  // A name that starts with one of these is harmless however it continues ("Undo delete", "Cancel download")...
  const SAFE_START = new Set(['undo', 'cancel', 'back', 'keep', 'restore', 'recover', 'close']);
  // ...unless it's one of these.
  const NEVER_SAFE = ['cancel subscription', 'cancel order', 'cancel membership', 'cancel plan', 'close account'];

  // Boxes whose contents are the user's alone: Lefty never types into them.
  const PRIVATE = /pass(word|code|phrase)|\bpin\b|\bcvv|\bcvc|security code|card number|credit card|debit card|\botp\b|one.time (code|password)|verification code|\bssn\b|social security|bank account|routing number|\biban\b|api key|secret|\btoken\b/i;

  // Key presses that close or delete things.
  const RISKY_KEYS = new Set(['alt+f4', 'ctrl+w', 'ctrl+q', 'ctrl+shift+w', 'shift+delete', 'ctrl+shift+delete', 'delete']);

  const normalize = (text) => ` ${String(text || '').toLowerCase().replace(/[’']/g, '').replace(/\bdo not\b/g, 'dont')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `;

  function askPhrase(text) {
    const said = normalize(text);
    if (!said.trim()) return null;
    if (NEVER_SAFE.some((p) => said.includes(` ${p} `))) return NEVER_SAFE.find((p) => said.includes(` ${p} `));
    if (SAFE_START.has(said.trim().split(' ')[0])) return null;
    return ASK_PHRASES.find((p) => said.includes(` ${p} `)) || null;
  }

  const isReal = (target) => Boolean(target) && target.type !== 'Spot' && target.type !== 'Area';

  // Why Lefty should ask before doing this step, or null. Looks at the thing he would click and at the step's words
  // (the AI's "Click Buy now"), since a guessed spot has no name of its own.
  function needsOk(target, label) {
    if (target && target.titleBar && /^close(\s|$)/i.test(String(target.name || '').trim())) return `"${String(target.name).trim()}" shuts the whole window`;
    const step = stepWords(label);
    const risk = (isReal(target) && Guard.riskOf(target)) || (step && Guard.riskOf({ name: step, type: 'Button', enabled: true }));
    if (risk) return risk.warning.replace(/^(Careful!|Heads up:)\s*/, '');
    const name = isReal(target) ? String(target.name || '').trim() : '';
    const phrase = askPhrase(name) || askPhrase(step);
    if (!phrase) return null;
    return `"${name || step || 'this'}" ${phrase === 'call' ? 'starts a call' : 'is your call'}`;
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
  function spotOk(label, under) {
    if (!under) return true; // couldn't look: the helper still checks the point is the app's
    if (!PLAIN.has(under.type)) return true;
    const keys = wordsOf(stripEmoji(label)).filter((w) => w.length > 1 && !FILLER.has(w));
    if (!keys.length) return true; // "Click here"
    const name = new Set(wordsOf(under.name));
    return keys.some((k) => name.has(k));
  }

  function plan(decision) {
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
      return { act: 'type', text, click: Boolean(target), ask: needsOk(null, label) };
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

  const api = { plan, needsOk, isPrivateBox, keysFor, stripEmoji, spotOk };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LeftyAuto = api;
})(this);

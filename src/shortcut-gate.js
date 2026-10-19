// One toggle per press of Ctrl+Space. Windows repeats a held key about 30 times a second, and every repeat
// would flip Lefty again, so he flickered on and off. A press counts only once the keys were let go.
// The key-up comes from the keyboard hook; if one is ever missed, a pause in the repeats (idleMs) also
// counts as letting go, so Lefty can never get stuck ignoring the shortcut.

function createGate({ now = Date.now, idleMs = 1000 } = {}) {
  let held = false;
  let lastPress = 0;
  return {
    // Returns true when this press should toggle Lefty, false for a repeat of a held press.
    press() {
      const time = now();
      const fresh = !held || time - lastPress > idleMs;
      held = true;
      lastPress = time;
      return fresh;
    },
    release() {
      held = false;
    },
  };
}

module.exports = { createGate };

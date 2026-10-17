// Click guard: spots buttons that throw work away, so Lefty can flag them before the user clicks.
// Pure functions: loaded by the overlay page and by Node tests.

(function (root) {
  // Words that make a button harmless however it continues ("Undo delete", "Restore", "Cancel").
  const SAFE_WORDS = new Set(['undo', 'restore', 'recover', 'cancel', 'keep', 'undelete', 'unarchive', 'back']);
  // Small, reversible targets: "Reset zoom", "Remove filter", "Clear search" are not worth a warning.
  const MINOR_CONTEXT = new Set(['zoom', 'view', 'filter', 'filters', 'layout', 'search', 'sort', 'selection',
    'highlight', 'highlights', 'formatting', 'notification', 'notifications', 'tag', 'tags']);
  // Element kinds whose names are content (file names, text), not actions.
  const CONTENT_TYPES = new Set(['Document', 'Edit']);

  // Checked in order: the first phrase found decides. Phrases match whole words.
  const RULES = [
    { level: 'high', reason: "can't be undone", phrases: ['permanently', 'forever', 'wipe', 'destroy', 'shred',
      'factory reset', 'empty recycle bin', 'empty trash', 'empty bin', 'force push', 'delete account',
      'drop table', 'drop database', 'format drive', 'format disk', 'format partition', 'quick format'] },
    { level: 'medium', reason: 'throws away unsaved work', phrases: ['dont save', 'discard', 'close without saving',
      'quit without saving', 'exit without saving'] },
    { level: 'medium', reason: 'removes the app', phrases: ['uninstall'] },
    { level: 'medium', reason: 'overwrites things', phrases: ['overwrite', 'replace all'] },
    { level: 'medium', reason: 'resets your settings', phrases: ['reset'] },
    { level: 'medium', reason: 'deletes things', phrases: ['delete', 'remove', 'erase', 'clear all', 'clear history',
      'clear data', 'clear cache', 'revoke', 'terminate', 'drop'] },
  ];

  function normalize(text) {
    return ` ${String(text || '').toLowerCase()
      .replace(/[’']/g, '')            // don't -> dont
      .replace(/\bdo not\b/g, 'dont')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim()} `;
  }

  // Returns { level: 'high' | 'medium', warning } for a risky element, or null.
  function riskOf(element) {
    if (!element || element.enabled === false || CONTENT_TYPES.has(element.type)) return null;
    const name = normalize(element.name);
    const words = name.trim().split(' ');
    if (!words[0] || words.some((word) => SAFE_WORDS.has(word))) return null;

    for (const rule of RULES) {
      if (!rule.phrases.some((phrase) => name.includes(` ${phrase} `))) continue;
      if (rule.level === 'medium' && words.some((word) => MINOR_CONTEXT.has(word))) return null;
      const label = String(element.name).trim();
      const warning = rule.level === 'high'
        ? `Careful! "${label}" can't be undone.`
        : `Heads up: "${label}" ${rule.reason}.`;
      return { level: rule.level, warning };
    }
    return null;
  }

  // The element under a point (global DIPs): the smallest one containing it, so a button wins over its toolbar.
  function elementAt(point, elements) {
    let best = null;
    let bestArea = Infinity;
    for (const element of elements || []) {
      const r = element.rect;
      if (!r || point.x < r.x || point.y < r.y || point.x > r.x + r.w || point.y > r.y + r.h) continue;
      const area = r.w * r.h;
      if (area < bestArea) { best = element; bestArea = area; }
    }
    return best;
  }

  const api = { riskOf, elementAt };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LeftyGuard = api;
})(this);

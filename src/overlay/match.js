// Finds the on-screen element the user means, e.g. "click save" -> the Save button.
// Pure function: loaded by the overlay page and by Node tests.

(function (root) {
  // Words that describe the action, not the target ("where is the start button" -> "start").
  const FILLER = new Set(('click tap press hit open select choose go to the a an on in of for my me please ' +
    'where is are how do does i can could you find show point at button btn icon item link option ' +
    'want need would like see get take use let lets now just').split(' '));

  const PREFERRED_TYPES = new Set(['Button', 'SplitButton', 'MenuItem', 'TabItem', 'Hyperlink', 'CheckBox', 'RadioButton']);
  const MIN_SCORE = 0.5;

  function tokenize(text) {
    return String(text || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  }

  function queryTokens(goal) {
    const all = tokenize(goal);
    const meaningful = all.filter((word) => !FILLER.has(word));
    return meaningful.length ? meaningful : all;
  }

  function wordMatch(queryWord, nameWord) {
    if (nameWord === queryWord) return 1;
    if (queryWord.length >= 3 && nameWord.startsWith(queryWord)) return 0.8; // "sett" -> "settings"
    return 0;
  }

  function score(query, element) {
    const nameWords = tokenize(element.name);
    if (!nameWords.length) return 0;

    let total = 0;
    let matched = 0;
    const usedNameWords = new Set();
    for (const queryWord of query) {
      let best = 0;
      let bestIndex = -1;
      nameWords.forEach((nameWord, index) => {
        const value = wordMatch(queryWord, nameWord);
        if (value > best) { best = value; bestIndex = index; }
      });
      if (best > 0) { matched += 1; total += best; usedNameWords.add(bestIndex); }
    }
    // Every word must match; long requests may miss one word.
    const allowedMisses = query.length >= 3 ? 1 : 0;
    if (matched < query.length - allowedMisses || matched === 0) return 0;

    const coverage = total / query.length;
    const precision = usedNameWords.size / nameWords.length; // "Save" beats "Save a copy"
    let value = coverage * 0.7 + precision * 0.3;
    if (nameWords.join(' ') === query.join(' ')) value += 0.1;
    if (element.enabled) value += 0.05;
    if (PREFERRED_TYPES.has(element.type)) value += 0.02;
    if (element.type === 'Document' || element.type === 'Edit') value -= 0.05;
    return value;
  }

  // Returns the best element for the goal, or null when nothing matches well enough.
  function findTarget(goal, elements) {
    const query = queryTokens(goal);
    if (!query.length || !Array.isArray(elements)) return null;
    let best = null;
    let bestScore = MIN_SCORE;
    for (const element of elements) {
      const value = score(query, element);
      if (value > bestScore) { best = element; bestScore = value; } // ties keep the first (top-most) one
    }
    return best;
  }

  const api = { findTarget, tokenize, queryTokens };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LeftyMatch = api;
})(this);

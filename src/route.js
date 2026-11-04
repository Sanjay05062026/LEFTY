// Where a goal goes. The main page is for talking: a question is answered there in text. The bubble and Ctrl+Space are
// for doing: he points or clicks, and anything too long for a bubble opens in the main window.
//   wantsChat(goal)   -> true when the goal wants an answer in words, not something done on screen
//   wantsDetail(goal) -> true when that answer will be long (asked from the bubble, it opens in the main window)
// Pure functions: loaded by the overlay page and by the main process.

(function (root) {
  // These start with something to do on the PC.
  const DOES = /^(?:please\s+|can you\s+|could you\s+|lefty,?\s+)*(open|launch|start|close|quit|click|press|tap|type|save|delete|remove|create|make|build|install|uninstall|download|upload|send|post|go to|navigate|turn|switch|play|pause|focus|fix|run|copy|paste|move|rename|scroll|select|set|change|enable|disable|write|generate|add|show me where|take me)\b/i;
  // Writing that is an answer, not a file: "write a poem". Code stays a job for the editor.
  const WRITES_TEXT = /^(?:please\s+|can you\s+|could you\s+)*(write|generate|make)\s+(?:me\s+)?(?:a|an|some|the)?\s*(?:\w+\s+)?(essay|poem|story|letter|email|e-mail|summary|paragraph|speech|report|caption|bio|list|plan|outline)\b/i;
  // These need his eyes on the screen, however they are worded.
  const NEEDS_SCREEN = /\b(stuck|what next|what do i do|on (?:my|the) screen|this (?:screen|app|window|page|button|file|error|menu|tab)|in this\b|here\b|right now)\b|>/i;
  const ASKS = /\?\s*$|^(?:please\s+|can you\s+|could you\s+)*(what|whats|what's|who|whom|whose|when|where|why|which|how|is|are|am|was|were|do|does|did|can|could|should|would|will|explain|describe|define|compare|summarize|summarise|tell me|teach me|translate|calculate|list|give me|suggest|recommend|help me understand)\b/i;
  const LONG = /\b(in detail|in depth|in-depth|detailed|details|deep dive|full explanation|explain (?:fully|everything|completely)|essay|write-?up|report|step[- ]by[- ]step guide|pros and cons|compare|comparison|difference between|overview of|everything about|summary of|all about)\b/i;

  function wantsChat(goal) {
    const text = String(goal || '').trim();
    if (!text || NEEDS_SCREEN.test(text)) return false;
    if (WRITES_TEXT.test(text)) return true;
    if (DOES.test(text)) return false;
    return ASKS.test(text) || LONG.test(text);
  }

  const wantsDetail = (goal) => wantsChat(goal) && LONG.test(String(goal));

  const api = { wantsChat, wantsDetail };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LeftyRoute = api;
})(this);

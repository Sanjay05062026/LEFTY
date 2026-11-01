// Focus mode, the parts that are plain logic: reading "focus 30 minutes on Chrome and physics" from a typed goal, and
// deciding whether the window in front belongs to the user's work. Main checks the window in front every second or
// two while a focus session runs and closes what isn't work.
//
//   parse(text) -> { minutes, allow } | { stop: true } | null (not about focus mode)
//   allowed(window, allow) -> true when the window is work (or Windows itself, or Lefty)
//   isBrowser(process) -> true for web browsers (a tab is closed there, not the whole window)
//   timeLeft(ms) -> "23 min" / "1 h 5 min" / "40 s"
// Pure functions: loaded by the overlay page, by main and by Node tests.

(function (root) {
  const MAX_MINUTES = 480;

  // Windows' own screens and tools stay usable: the desktop, Start, search, the lock screen, Task Manager, sign-in
  // and permission prompts.
  const ALWAYS = new Set([
    'explorer:', 'shellexperiencehost', 'startmenuexperiencehost', 'searchhost', 'searchapp', 'lockapp', 'textinputhost',
    'taskmgr', 'consent', 'credentialuibroker', 'logonui', 'applicationframehost:', 'electron', 'lefty',
  ]);
  const BROWSERS = new Set(['chrome', 'msedge', 'firefox', 'brave', 'opera', 'vivaldi', 'arc', 'iexplore']);
  // Names people say for an app, as its process is called.
  const ALIASES = {
    'vs code': 'code', vscode: 'code', 'visual studio code': 'code', edge: 'msedge', 'microsoft edge': 'msedge',
    'google chrome': 'chrome', word: 'winword', powerpoint: 'powerpnt', 'file explorer': 'explorer', terminal: 'windowsterminal',
    'command prompt': 'cmd', notepad: 'notepad', pycharm: 'pycharm64', intellij: 'idea64', 'visual studio': 'devenv', teams: 'ms-teams',
  };

  const clean = (s) => String(s || '').toLowerCase().replace(/[\s_]+/g, ' ').trim();

  function isBrowser(process) {
    return BROWSERS.has(clean(process));
  }

  // window: { process, title, lefty, shell }. A term matches the app (its process, or a name people use for it) or
  // words in the window's title ("physics" matches the tab "Physics notes - Google Chrome").
  function allowed(window, allow) {
    if (!window || window.lefty || window.shell) return true;
    const process = clean(window.process);
    const title = clean(window.title);
    if (!process && !title) return true;
    if (ALWAYS.has(process) || (ALWAYS.has(`${process}:`) && !title)) return true;
    return (allow || []).some((term) => {
      const t = clean(term);
      if (!t) return false;
      if (process === t || process === ALIASES[t] || process.replace(/\d+$/, '') === t) return true;
      if (title.includes(t) || (t.includes(' ') && t.split(' ').every((w) => title.includes(w)))) return true;
      return isBrowser(process) && title.includes(t.replace(/\s+/g, '')); // "you tube" vs "YouTube"
    });
  }

  const UNITS = [
    [/^(h|hr|hrs|hour|hours)$/, 60],
    [/^(m|min|mins|minute|minutes)$/, 1],
  ];
  const FILLER = /\b(my|the|a|an|app|apps|tab|tabs|window|windows|website|site|only|just|please|and|or|also)\b/g;

  // "focus 30 min on chrome and my physics tab", "study mode for 1 hour only vs code", "stop focus".
  function parse(text) {
    const said = clean(text).replace(/[.!?]+$/, '');
    if (!/\b(focus|study|pomodoro)\b/.test(said)) return null;
    if (/\b(stop|end|cancel|quit|exit|turn off|switch off)\b/.test(said) || /\b(focus|study)( mode)? off\b/.test(said)) return { stop: true };
    let minutes = 0;
    const amount = /(\d+(?:\.\d+)?)\s*([a-z]+)/.exec(said.replace(/half an hour/, '30 min').replace(/\ban hour\b/, '1 hour'));
    if (amount) {
      const unit = UNITS.find(([pattern]) => pattern.test(amount[2]));
      if (unit) minutes = Math.round(parseFloat(amount[1]) * unit[1]);
    }
    const isMode = /\b(focus|study)\s+(mode|timer|session|time)\b/.test(said) || /\bpomodoro\b/.test(said);
    if (!minutes && !isMode) return null; // "focus the search box" is a normal goal
    if (!minutes) minutes = /pomodoro/.test(said) ? 25 : 30;
    minutes = Math.max(1, Math.min(MAX_MINUTES, minutes));
    // The work: whatever follows "on", "in", "with", "using", "allow" or "only" after the time.
    const rest = amount ? said.slice(said.indexOf(amount[0]) + amount[0].length) : said;
    const named = /\b(?:on|in|with|using|allow|allowing|only|except)\b\s+(.+)$/.exec(rest);
    const allow = named
      ? named[1].split(/,|\band\b|&|\bor\b|\+/).map((part) => part.replace(FILLER, ' ').replace(/\s+/g, ' ').trim()).filter((p) => p && p.length <= 60).slice(0, 10)
      : [];
    return { minutes, allow };
  }

  function timeLeft(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return `${s} s`;
    const m = Math.ceil(s / 60);
    return m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}` : `${m} min`;
  }

  const api = { parse, allowed, isBrowser, timeLeft, MAX_MINUTES };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LeftyFocus = api;
})(this);

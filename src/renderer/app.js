// No backend yet: "accounts" and permissions are kept in localStorage so the UI flow can be tested.
// Passwords are never stored.

// Fallback so the page can also be previewed in a plain browser without Electron.
const api = window.lefty ?? {
  setLoggedIn: async () => ({ ok: true, accelerator: 'Ctrl+Space' }),
  summon: () => toast('Lefty appears here when running inside the app.'),
};

const store = {
  get(key) { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ } },
  remove(key) { try { localStorage.removeItem(key); } catch { /* storage unavailable */ } },
};

const $ = (id) => document.getElementById(id);
const views = { login: $('view-login'), permissions: $('view-permissions'), home: $('view-home') };
const REQUIRED_PERMS = ['screen', 'uia', 'shortcut'];

function showView(name) {
  for (const [key, el] of Object.entries(views)) el.hidden = key !== name;
}

let toastTimer;
function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

/* ---------- Login / sign up ---------- */
let mode = 'login';

function setMode(next) {
  mode = next;
  const signup = mode === 'signup';
  $('auth-title').textContent = signup ? 'Create your account' : 'Welcome back';
  $('auth-sub').textContent = signup ? 'Sign up to meet Lefty' : 'Log in to Lefty to continue';
  $('name-field').hidden = !signup;
  $('switch-text').textContent = signup ? 'Already have an account?' : "Don't have an account?";
  $('switch-mode').textContent = signup ? 'Log in' : 'Sign up';
  $('password').autocomplete = signup ? 'new-password' : 'current-password';
  clearErrors();
}

function clearErrors() {
  $('auth-error').textContent = '';
  for (const id of ['name', 'email', 'password']) $(id).classList.remove('invalid');
}

function validate() {
  clearErrors();
  const name = $('name').value.trim();
  const email = $('email').value.trim();
  const password = $('password').value;
  let error = '';
  let field = null;
  if (mode === 'signup' && !name) { error = 'Enter your name.'; field = 'name'; }
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { error = 'Enter a valid email address.'; field = 'email'; }
  else if (password.length < 6) { error = 'Password must be at least 6 characters.'; field = 'password'; }
  if (error) {
    $('auth-error').textContent = error;
    $(field).classList.add('invalid');
    $(field).focus();
    return null;
  }
  return { name: name || email.split('@')[0], email };
}

function signIn(user) {
  store.set('lefty.user', user);
  $('password').value = '';
  const perms = store.get('lefty.permissions') ?? {};
  if (REQUIRED_PERMS.every((p) => perms[p])) enterHome();
  else openPermissions('onboarding');
}

$('auth-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const user = validate();
  if (!user) return;
  const button = $('auth-submit');
  button.classList.add('loading');
  button.disabled = true;
  setTimeout(() => { // stands in for the future server call
    button.classList.remove('loading');
    button.disabled = false;
    signIn(user);
  }, 700);
});

for (const id of ['name', 'email', 'password']) $(id).addEventListener('input', clearErrors);
$('switch-mode').addEventListener('click', () => setMode(mode === 'login' ? 'signup' : 'login'));

document.querySelectorAll('[data-social]').forEach((button) => {
  button.addEventListener('click', () => {
    toast(`${button.dataset.social} sign-in comes with the backend. Continuing as a guest.`);
    signIn({ name: 'Guest', email: 'guest@lefty.app' });
  });
});

/* ---------- Permissions ---------- */
let permsMode = 'onboarding';

function openPermissions(nextMode) {
  permsMode = nextMode;
  const perms = store.get('lefty.permissions') ?? {};
  document.querySelectorAll('.perm').forEach((item) => setAllowed(item, Boolean(perms[item.dataset.perm])));
  $('perms-eyebrow').textContent = permsMode === 'onboarding' ? 'Almost there' : 'Settings';
  $('perm-continue').textContent = permsMode === 'onboarding' ? 'Continue' : 'Done';
  updateContinue();
  showView('permissions');
}

function setAllowed(item, allowed) {
  item.classList.toggle('allowed', allowed);
  const button = item.querySelector('.btn-allow');
  button.textContent = allowed ? 'Allowed' : 'Allow';
  button.disabled = allowed;
}

function allow(item) {
  // TODO(backend): request the real OS permission here (screen capture, UI Automation, microphone).
  const button = item.querySelector('.btn-allow');
  button.textContent = 'Requesting…';
  button.disabled = true;
  setTimeout(() => {
    const perms = store.get('lefty.permissions') ?? {};
    perms[item.dataset.perm] = true;
    store.set('lefty.permissions', perms);
    setAllowed(item, true);
    updateContinue();
  }, 450);
}

function updateContinue() {
  const perms = store.get('lefty.permissions') ?? {};
  $('perm-continue').disabled = !REQUIRED_PERMS.every((p) => perms[p]);
}

document.querySelectorAll('.perm').forEach((item) => {
  item.querySelector('.btn-allow').addEventListener('click', () => allow(item));
});
$('perm-all').addEventListener('click', () => {
  document.querySelectorAll('.perm:not(.allowed)').forEach(allow);
});
$('perm-continue').addEventListener('click', enterHome);

/* ---------- Home ---------- */
function formatAccelerator(accelerator) {
  return accelerator.split('+').map((key) => (key === 'CommandOrControl' ? 'Ctrl' : key));
}

async function enterHome() {
  const user = store.get('lefty.user');
  if (!user) { showView('login'); return; }
  $('hello-name').textContent = user.name;
  $('user-name').textContent = user.name;
  $('user-email').textContent = user.email;
  $('avatar').textContent = user.name.charAt(0).toUpperCase();
  showView('home');

  const { ok, accelerator } = await api.setLoggedIn(true);
  $('keycaps').replaceChildren(...formatAccelerator(accelerator).map((key) => {
    const kbd = document.createElement('kbd');
    kbd.textContent = key;
    return kbd;
  }));
  const status = $('shortcut-status');
  status.classList.toggle('warn', !ok);
  status.textContent = ok ? 'Shortcut active' : 'Shortcut taken by another app';
  if (!ok) toast('Another app is using this shortcut. Type to Lefty here for now.');
  refresh();
}

/* ---------- Settings: Learn / Do it, size, talking and private apps (kept by the main process, shared with the overlay) ---------- */
let privateApps = [];

function showSettings(settings) {
  for (const [id, value] of [['pref-mode', settings.mode], ['pref-access', settings.access], ['pref-size', settings.size], ['pref-speak', settings.speak]]) {
    $(id).querySelectorAll('button').forEach((b) => {
      const on = b.dataset.value === value;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', String(on));
    });
  }
  privateApps = Array.isArray(settings.privateApps) ? settings.privateApps : [];
  showPrivateApps();
}

const SETTING_TOASTS = {
  mode: (now) => (now.mode === 'auto' ? 'Do it: Lefty clicks and types for you. Esc stops him.' : 'Learn: Lefty points and you click.'),
  speak: (now) => (now.speak === 'on' ? 'Lefty will read his answers out loud.' : 'Lefty is quiet now.'),
};

if (api.getSettings) {
  api.getSettings().then(showSettings).catch(() => {});
  api.onSettings(showSettings);
  for (const [id, key] of [['pref-mode', 'mode'], ['pref-access', 'access'], ['pref-size', 'size'], ['pref-speak', 'speak']]) {
    $(id).querySelectorAll('button').forEach((b) => {
      b.addEventListener('click', async () => {
        const now = await api.setSettings({ [key]: b.dataset.value });
        showSettings(now);
        if (SETTING_TOASTS[key]) toast(SETTING_TOASTS[key](now));
      });
    });
  }
} else {
  showSettings({ mode: 'learn', access: 'auto', size: 'normal', speak: 'off', privateApps: [] }); // previewed in a plain browser
}

/* ---------- Private apps: no screenshots, no code sent ---------- */
const SUGGESTED_NAMES = { '1password': '1Password', bitwarden: 'Bitwarden', keepass: 'KeePass', keepassxc: 'KeePassXC' };
let runningNames = {}; // process -> the name people know, from the apps open now

function showPrivateApps() {
  const list = $('private-list');
  if (!privateApps.length) {
    const none = document.createElement('span');
    none.className = 'none';
    none.textContent = 'None yet. Lefty may take screenshots in every app when you ask him something.';
    list.replaceChildren(none);
  } else {
    list.replaceChildren(...privateApps.map((process) => {
      const chip = document.createElement('span');
      chip.className = 'app-chip';
      chip.textContent = runningNames[process] || SUGGESTED_NAMES[process] || process;
      chip.title = `${process}.exe`;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = '×';
      remove.setAttribute('aria-label', `Remove ${chip.textContent} from private apps`);
      remove.addEventListener('click', () => setPrivateApps(privateApps.filter((p) => p !== process)));
      chip.append(remove);
      return chip;
    }));
  }
  document.querySelectorAll('.private-suggest [data-app]').forEach((b) => { b.disabled = privateApps.includes(b.dataset.app); });
}

async function setPrivateApps(next) {
  if (!api.setSettings) { privateApps = next; showPrivateApps(); return; }
  const now = await api.setSettings({ privateApps: next });
  showSettings(now);
}

function addPrivateApp(name) {
  const process = String(name || '').trim().toLowerCase().replace(/\.exe$/, '');
  if (!process) return;
  if (!/^[\p{L}\p{N}][\p{L}\p{N} ._()+-]{0,63}$/u.test(process)) { toast("That doesn't look like a program name. Try the name of its .exe file."); return; }
  if (privateApps.includes(process)) { toast('That app is already private.'); return; }
  setPrivateApps([...privateApps, process]);
  toast(`${runningNames[process] || SUGGESTED_NAMES[process] || process}: no screenshots from now on.`);
}

// The apps open right now, for the drop-down (asked again each time it's opened, so it's never stale).
async function fillRunningApps() {
  if (!api.runningApps) return;
  const apps = await api.runningApps().catch(() => []);
  runningNames = Object.fromEntries(apps.map((a) => [a.process, a.app]));
  const select = $('private-open');
  const first = select.options[0];
  select.replaceChildren(first, ...apps.filter((a) => !privateApps.includes(a.process)).map((a) => {
    const option = document.createElement('option');
    option.value = a.process;
    option.textContent = a.app && a.app.toLowerCase() !== a.process ? `${a.app} (${a.process})` : a.app || a.process;
    return option;
  }));
}

$('private-open').addEventListener('focus', fillRunningApps);
$('private-open').addEventListener('change', (event) => {
  if (event.target.value) addPrivateApp(event.target.value);
  event.target.value = '';
});
$('private-form').addEventListener('submit', (event) => {
  event.preventDefault();
  addPrivateApp($('private-name').value);
  $('private-name').value = '';
});
document.querySelectorAll('.private-suggest [data-app]').forEach((b) => b.addEventListener('click', () => addPrivateApp(b.dataset.app)));

/* ---------- Focus mode: a timer, and only the work apps until it ends ---------- */
let focusNow = { on: false };
let focusTick = null;
const minutesLeft = (until) => Math.max(1, Math.ceil((until - Date.now()) / 60000));
function showFocus(state) {
  focusNow = state || { on: false };
  $('focus-off').hidden = focusNow.on;
  $('focus-on').hidden = !focusNow.on;
  clearInterval(focusTick);
  if (!focusNow.on) return;
  const paint = () => {
    const m = minutesLeft(focusNow.until);
    $('focus-left').textContent = m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min left` : `${m} min left`;
  };
  paint();
  focusTick = setInterval(paint, 15000);
  $('focus-apps').textContent = `Only ${focusNow.allow.join(', ')}`;
}
if (api.getFocus) {
  api.getFocus().then(showFocus).catch(() => showFocus(null));
  api.onFocus(showFocus);
  $('focus-off').addEventListener('submit', async (event) => {
    event.preventDefault();
    const allow = $('focus-allow').value.split(/,|\band\b/).map((s) => s.trim()).filter(Boolean);
    const r = await api.startFocus({ minutes: Number($('focus-minutes').value), allow });
    if (!r.ok) toast(r.error);
    else toast("Focus mode on. Anything that isn't your work gets closed.");
  });
  $('focus-stop').addEventListener('click', () => api.stopFocus());
} else {
  showFocus(null);
}

/* ---------- Chats: the list on the left, the open chat in the middle ----------
   Typing here hands the goal to Lefty: this window steps aside and he works on the app behind it, in the same chat.
   The chats themselves are kept by main (history.js: the user's Supabase project, or this PC). */
let chats = [];
let currentChat = null;    // the open chat's id, or null for a new one
let waitingForNew = false; // sent from a new chat: open it as soon as it is saved

const when = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (days < 1) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return days < 7 ? d.toLocaleDateString([], { weekday: 'short' }) : d.toLocaleDateString();
};

function listNote(text) {
  const note = document.createElement('p');
  note.className = 'chat-empty';
  note.textContent = text;
  $('chat-list').replaceChildren(note);
}

function renderChats() {
  if (!chats.length) { listNote('No chats yet.'); return; }
  $('chat-list').replaceChildren(...chats.map((c) => {
    const title = c.title || 'New chat';
    const row = document.createElement('div');
    row.className = `chat-item${c.id === currentChat ? ' on' : ''}`;
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'open';
    open.textContent = title;
    open.title = c.updated_at ? `${title} · ${when(c.updated_at)}` : title;
    open.addEventListener('click', () => openChat(c.id));
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'del';
    del.textContent = 'Delete';
    del.setAttribute('aria-label', `Delete the chat "${title}"`);
    del.addEventListener('click', async () => {
      if (!del.classList.contains('confirm')) { // a second click deletes, so nothing goes by accident
        del.classList.add('confirm');
        del.textContent = 'Sure?';
        setTimeout(() => { del.classList.remove('confirm'); del.textContent = 'Delete'; }, 3000);
        return;
      }
      const r = await api.chatRemove(c.id);
      if (!r.ok) { toast(`Couldn't delete it: ${r.error}`); return; }
      if (currentChat === c.id) showNewChat();
      toast('Chat deleted.');
      refresh();
    });
    row.append(open, del);
    return row;
  }));
}

async function loadChats() {
  if (!api.chats) return;
  const r = await api.chats().catch((e) => ({ ok: false, error: e.message }));
  if (!r.ok) { listNote(r.setup ? r.error : "Couldn't load your chats."); return; }
  const before = new Set(chats.map((c) => c.id));
  chats = r.chats || [];
  if (waitingForNew && !currentChat) {
    const fresh = chats.find((c) => !before.has(c.id));
    if (fresh) { waitingForNew = false; currentChat = fresh.id; }
  }
  renderChats();
}

function bubble(text, role) {
  const el = document.createElement('div');
  el.className = `bubble-msg ${role === 'user' ? 'user' : 'lefty'}`;
  el.textContent = text;
  return el;
}

async function showThread() {
  if (!currentChat || !api.chatGet || streaming) return;
  const asked = currentChat;
  const r = await api.chatGet(asked).catch(() => null);
  if (asked !== currentChat) return; // another chat was opened meanwhile
  if (!r || !r.ok) return;
  if (!r.chat) { showNewChat(); return; }
  $('chat-title').textContent = r.chat.title || 'Chat';
  $('welcome').hidden = true;
  const thread = $('thread');
  thread.hidden = false;
  const parts = r.chat.messages.map((m) => bubble(m.text, m.role));
  if (r.chat.project) {
    const note = document.createElement('p');
    note.className = 'thread-note';
    note.textContent = `Project: ${r.chat.project}`;
    parts.unshift(note);
  }
  thread.replaceChildren(...parts);
  const scroll = $('chat-scroll');
  scroll.scrollTop = scroll.scrollHeight;
}

function openChat(id) {
  closeSettings();
  currentChat = id;
  waitingForNew = false;
  renderChats();
  showThread();
  $('composer-input').focus();
}

function showNewChat() {
  closeSettings();
  currentChat = null;
  waitingForNew = false;
  $('chat-title').textContent = 'New chat';
  $('thread').hidden = true;
  $('thread').replaceChildren();
  $('welcome').hidden = false;
  if (chats.length) renderChats();
}

// The storage bar: how full the database is (Supabase's free plan counts the whole database) or the file on this PC.
const size = (bytes) => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
async function loadUsage() {
  if (!api.storageUsage) return;
  const r = await api.storageUsage().catch((e) => ({ ok: false, error: e.message }));
  const bar = $('storage-bar');
  $('storage-where').textContent = r.where === 'supabase' ? 'Supabase' : 'This PC';
  if (!r.ok) {
    $('storage-fill').style.width = '0%';
    $('storage-text').textContent = r.setup ? r.error : "Can't reach the storage right now.";
    return;
  }
  const pct = Math.min(100, (r.used / r.limit) * 100);
  $('storage-fill').style.width = `${r.used ? Math.max(pct, 1) : 0}%`;
  bar.setAttribute('aria-valuenow', String(Math.round(pct)));
  bar.classList.toggle('high', pct >= 75 && pct < 95);
  bar.classList.toggle('full', pct >= 95);
  const mine = r.where === 'supabase' ? ` · your chats ${size(r.mine)}` : '';
  const hint = pct >= 75 ? '. Delete old chats to free space.' : '';
  $('storage-text').textContent = r.used
    ? `${size(r.used)} of ${size(r.limit)} used, ${size(Math.max(0, r.limit - r.used))} left${mine}${hint}`
    : `Nothing saved yet. ${size(r.limit)} free.`;
}

let refreshTimer = null;
function refresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => { await loadChats(); showThread(); loadUsage(); }, 250);
}

function send(text) {
  const goal = String(text || '').trim();
  if (!goal) return;
  if (!api.homeAsk) { toast('Lefty answers here when running inside the app.'); return; }
  if (currentChat) $('thread').append(bubble(goal, 'user'));
  else waitingForNew = true;
  api.homeAsk({ goal, chatId: currentChat });
}

/* An answer in the main page, word by word. While it's being written the thread is left alone: a reload from the
   history would wipe the words already on the page. */
let streaming = null;
function follow() { const scroll = $('chat-scroll'); scroll.scrollTop = scroll.scrollHeight; }
if (api.onChatStream) {
  api.onChatStream(async (event) => {
    if (event.type === 'open') { openChat(event.chatId); return; }
    if (event.type === 'start') {
      if (event.chatId) { closeSettings(); currentChat = event.chatId; waitingForNew = false; }
      streaming = null;
      await showThread();
      $('welcome').hidden = true;
      $('thread').hidden = false;
      streaming = streaming || bubble('', 'lefty');
      streaming.classList.add('writing');
      $('thread').append(streaming);
      follow();
      return;
    }
    if (event.type === 'text') {
      streaming = streaming || bubble('', 'lefty');
      streaming.classList.add('writing');
      if (!streaming.isConnected) { $('thread').hidden = false; $('thread').append(streaming); }
      streaming.append(document.createTextNode(event.text));
      follow();
      return;
    }
    const done = streaming;
    streaming = null;
    if (done) done.classList.remove('writing');
    if (event.error) {
      if (done && !done.textContent) done.remove();
      toast(event.error);
      $('thread').append(bubble(event.error, 'lefty'));
      follow();
    }
    refresh();
  });
}
if (api.onTaskStatus) {
  api.onTaskStatus((status) => {
    $('task-status').hidden = !status;
    $('task-text').textContent = status || '';
    if (!status) refresh();
  });
}

const composerInput = $('composer-input');
const fitComposer = () => { composerInput.style.height = 'auto'; composerInput.style.height = `${Math.min(composerInput.scrollHeight, 180)}px`; };
composerInput.addEventListener('input', fitComposer);
composerInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('composer').requestSubmit(); }
});
$('composer').addEventListener('submit', (event) => {
  event.preventDefault();
  send(composerInput.value);
  composerInput.value = '';
  fitComposer();
});
document.querySelectorAll('[data-try]').forEach((b) => b.addEventListener('click', () => { composerInput.value = b.dataset.try; fitComposer(); composerInput.focus(); }));
$('new-chat').addEventListener('click', () => { showNewChat(); composerInput.focus(); });
if (api.onChatsChanged) api.onChatsChanged(refresh);
window.addEventListener('focus', refresh); // back from Lefty's work: the chat has his answers now

/* ---------- Settings: in place of the chat ---------- */
function openSettings() { $('settings-main').hidden = false; document.querySelector('.home-main').hidden = true; }
function closeSettings() { $('settings-main').hidden = true; document.querySelector('.home-main').hidden = false; }
$('open-settings').addEventListener('click', openSettings);
$('close-settings').addEventListener('click', closeSettings);
$('open-permissions').addEventListener('click', () => openPermissions('settings'));
$('logout').addEventListener('click', async () => {
  await api.setLoggedIn(false);
  store.remove('lefty.user');
  setMode('login');
  showView('login');
});

/* ---------- Start ---------- */
// The build, next to the wordmark. Saved chats keep what older builds said, so without this an
// update that fixed something looks like it didn't.
if (api.version) api.version().then((v) => { $('brand-version').textContent = v ? `v${v}` : ''; }).catch(() => {});

const savedUser = store.get('lefty.user');
if (!savedUser) showView('login');
else signIn(savedUser);

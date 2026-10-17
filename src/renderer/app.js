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
  button.textContent = allowed ? 'Allowed ✓' : 'Allow';
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
  if (!ok) toast('Another app is using this shortcut. Use "Try it now" for now.');
}

$('try-now').addEventListener('click', () => api.summon());
$('new-goal').addEventListener('click', () => api.summon());
$('open-settings').addEventListener('click', () => openPermissions('settings'));
$('logout').addEventListener('click', async () => {
  await api.setLoggedIn(false);
  store.remove('lefty.user');
  setMode('login');
  showView('login');
});

/* ---------- Start ---------- */
const savedUser = store.get('lefty.user');
if (!savedUser) showView('login');
else signIn(savedUser);

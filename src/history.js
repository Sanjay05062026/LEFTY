// Lefty's chat history: each conversation with its messages (text only: never screenshots, audio or what is on
// screen), so a chat can be opened again and continued. Kept in the user's Supabase project when SUPABASE_URL and
// SUPABASE_ANON_KEY are set (in the environment or .env; tables from server/supabase.sql), else in a file on this PC.
//
// On Supabase each install signs in as an anonymous user, and row level security keeps every user to their own
// chats. The session (not a password: there is none) is kept in Lefty's data folder.

const fs = require('fs');
const path = require('path');
const { setting } = require('./brain');

const MAX_TEXT = 8000;            // one message
const MAX_TITLE = 80;
const MAX_CHATS = 200;            // listed at once
const PC_LIMIT_BYTES = 50 * 1024 * 1024;
const SUPABASE_FREE_MB = 500;     // the free plan's database size; LEFTY_STORAGE_MB changes it
const TIMEOUT_MS = 15000;

let dataDir = '';
let fetchImpl = (...args) => fetch(...args);

function init(dir) { dataDir = dir; }
function useFetch(fn) { fetchImpl = fn; session = null; }

const supabaseUrl = () => (setting('SUPABASE_URL') || '').trim().replace(/\/+$/, '');
const supabaseKey = () => (setting('SUPABASE_ANON_KEY') || '').trim();
const where = () => (supabaseUrl() && supabaseKey() ? 'supabase' : 'pc');

const clean = (text, max) => String(text || '').replace(/\u0000/g, '').slice(0, max);
const titleOf = (text) => clean(String(text || '').replace(/\s+/g, ' ').trim(), MAX_TITLE) || 'New chat';

/* ---------- On this PC: one JSON file ---------- */
const pcFile = () => path.join(dataDir, 'chats.json');
function pcRead() {
  try {
    const data = JSON.parse(fs.readFileSync(pcFile(), 'utf8'));
    return Array.isArray(data.chats) ? data : { chats: [] };
  } catch { return { chats: [] }; }
}
function pcWrite(data) {
  fs.mkdirSync(dataDir, { recursive: true });
  const tmp = `${pcFile()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, pcFile()); // never a half-written file
}
const newId = () => require('crypto').randomUUID();

const pc = {
  async list() {
    return pcRead().chats.map(({ id, title, project, updated_at }) => ({ id, title, project, updated_at }))
      .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at))).slice(0, MAX_CHATS);
  },
  async get(id) {
    const chat = pcRead().chats.find((c) => c.id === id);
    return chat ? { id: chat.id, title: chat.title, project: chat.project, messages: chat.messages || [] } : null;
  },
  async create(title) {
    const data = pcRead();
    const now = new Date().toISOString();
    const chat = { id: newId(), title: titleOf(title), project: null, created_at: now, updated_at: now, messages: [] };
    data.chats.push(chat);
    pcWrite(data);
    return { id: chat.id, title: chat.title };
  },
  async add(id, role, text) {
    const data = pcRead();
    const chat = data.chats.find((c) => c.id === id);
    if (!chat) return false;
    const at = new Date().toISOString();
    chat.messages.push({ role, text, at });
    chat.updated_at = at;
    pcWrite(data);
    return true;
  },
  async setProject(id, folder) {
    const data = pcRead();
    const chat = data.chats.find((c) => c.id === id);
    if (!chat) return false;
    chat.project = folder;
    pcWrite(data);
    return true;
  },
  async remove(id) {
    const data = pcRead();
    data.chats = data.chats.filter((c) => c.id !== id);
    pcWrite(data);
    return true;
  },
  async usage() {
    let used = 0;
    try { used = fs.statSync(pcFile()).size; } catch { /* nothing saved yet */ }
    return { ok: true, where: 'pc', used, mine: used, limit: PC_LIMIT_BYTES };
  },
};

/* ---------- Supabase: REST, signed in as an anonymous user ---------- */
let session = null; // { access_token, refresh_token, expires_at (ms) }
const sessionFile = () => path.join(dataDir, 'supabase-session.json');

async function call(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { ...options, signal: controller.signal });
    const body = await response.text();
    let data = null;
    try { data = body ? JSON.parse(body) : null; } catch { data = body; }
    if (!response.ok) {
      const message = (data && (data.message || data.msg || data.error_description || data.error)) || `HTTP ${response.status}`;
      throw Object.assign(new Error(String(message)), { status: response.status });
    }
    return data;
  } catch (error) {
    if (error.name === 'AbortError') throw Object.assign(new Error('Supabase timed out'), { timeout: true });
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function keep(data) {
  session = { access_token: data.access_token, refresh_token: data.refresh_token, expires_at: Date.now() + (Number(data.expires_in) || 3600) * 1000 };
  try { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(sessionFile(), JSON.stringify(session)); } catch { /* kept in memory */ }
}

async function token() {
  if (!session) { try { session = JSON.parse(fs.readFileSync(sessionFile(), 'utf8')); } catch { session = null; } }
  const headers = { apikey: supabaseKey(), 'Content-Type': 'application/json' };
  if (session && session.access_token && session.expires_at - Date.now() > 60000) return session.access_token;
  if (session && session.refresh_token) {
    try {
      keep(await call(`${supabaseUrl()}/auth/v1/token?grant_type=refresh_token`, { method: 'POST', headers, body: JSON.stringify({ refresh_token: session.refresh_token }) }));
      return session.access_token;
    } catch (error) {
      if (!error.status || error.status >= 500) throw error; // offline: try again later, keep the session
    }
  }
  // First run (or the session was revoked): a new anonymous user. Needs "Allow anonymous sign-ins" in Supabase.
  try {
    keep(await call(`${supabaseUrl()}/auth/v1/signup`, { method: 'POST', headers, body: JSON.stringify({ data: {} }) }));
  } catch (error) {
    if (error.status === 422 || /anonymous/i.test(error.message)) throw Object.assign(new Error('Turn on anonymous sign-ins in Supabase (Authentication > Sign In / Providers)'), { setup: true });
    throw error;
  }
  return session.access_token;
}

async function rest(route, { method = 'GET', body, prefer } = {}) {
  const headers = { apikey: supabaseKey(), Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json' };
  if (prefer) headers.Prefer = prefer;
  try {
    return await call(`${supabaseUrl()}${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch (error) {
    if (error.status === 404 || /relation .* does not exist|Could not find the (table|function)/i.test(error.message)) {
      throw Object.assign(new Error('Run server/supabase.sql in the Supabase SQL editor first'), { setup: true });
    }
    throw error;
  }
}

const enc = encodeURIComponent;
const supabase = {
  async list() {
    return (await rest(`/rest/v1/lefty_chats?select=id,title,project,updated_at&order=updated_at.desc&limit=${MAX_CHATS}`)) || [];
  },
  async get(id) {
    const [chat] = (await rest(`/rest/v1/lefty_chats?select=id,title,project&id=eq.${enc(id)}`)) || [];
    if (!chat) return null;
    const rows = (await rest(`/rest/v1/lefty_messages?select=role,text,created_at&chat_id=eq.${enc(id)}&order=id.asc&limit=1000`)) || [];
    return { ...chat, messages: rows.map((m) => ({ role: m.role, text: m.text, at: m.created_at })) };
  },
  async create(title) {
    const [chat] = await rest('/rest/v1/lefty_chats?select=id,title', { method: 'POST', body: { title: titleOf(title) }, prefer: 'return=representation' });
    return chat;
  },
  async add(id, role, text) {
    await rest('/rest/v1/lefty_messages', { method: 'POST', body: { chat_id: id, role, text }, prefer: 'return=minimal' });
    return true;
  },
  async setProject(id, folder) {
    await rest(`/rest/v1/lefty_chats?id=eq.${enc(id)}`, { method: 'PATCH', body: { project: folder }, prefer: 'return=minimal' });
    return true;
  },
  async remove(id) {
    await rest(`/rest/v1/lefty_chats?id=eq.${enc(id)}`, { method: 'DELETE', prefer: 'return=minimal' });
    return true;
  },
  async usage() {
    const u = await rest('/rest/v1/rpc/lefty_usage', { method: 'POST', body: {} });
    const limitMb = Number(setting('LEFTY_STORAGE_MB')) || SUPABASE_FREE_MB;
    return { ok: true, where: 'supabase', used: Number(u && u.database) || 0, mine: Number(u && u.mine) || 0, limit: limitMb * 1024 * 1024 };
  },
};

const store = () => (where() === 'supabase' ? supabase : pc);

// Every call answers { ok, ... } and never throws; errors carry a short message for the home screen.
async function safe(run) {
  try {
    return { ok: true, ...(await run()) };
  } catch (error) {
    return { ok: false, where: where(), setup: Boolean(error.setup), error: error.message };
  }
}

module.exports = {
  init,
  useFetch,
  where,
  list: () => safe(async () => ({ chats: await store().list() })),
  get: (id) => safe(async () => ({ chat: await store().get(String(id || '')) })),
  create: (title) => safe(async () => ({ chat: await store().create(title) })),
  add: (id, role, text) => safe(async () => {
    if (!['user', 'lefty'].includes(role)) throw new Error('bad role');
    const body = clean(text, MAX_TEXT).trim();
    return { added: body ? await store().add(String(id || ''), role, body) : false };
  }),
  setProject: (id, folder) => safe(async () => ({ set: await store().setProject(String(id || ''), clean(folder, 400) || null) })),
  remove: (id) => safe(async () => ({ removed: await store().remove(String(id || '')) })),
  usage: () => safe(() => store().usage()),
};

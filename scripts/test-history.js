// Checks the chat history (src/history.js): saved on this PC without Supabase, and through Supabase's REST API
// (faked here) with an anonymous sign-in when SUPABASE_URL and SUPABASE_ANON_KEY are set.
const fs = require('fs');
const os = require('os');
const path = require('path');

let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed += 1; };

delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_ANON_KEY;
const history = require('../src/history');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lefty-history-'));
history.init(dir);

(async () => {
  // --- On this PC ---
  if (history.where() !== 'pc') { console.log('skipped: a Supabase project is set in .env'); process.exit(0); }
  const made = await history.create('  Build me a portfolio website\nwith a contact page  ');
  check(made.ok && made.chat.id && made.chat.title === 'Build me a portfolio website with a contact page', 'a new chat is titled after the first message, on one line');
  await history.add(made.chat.id, 'user', 'Build me a portfolio website');
  await history.add(made.chat.id, 'lefty', 'Which folder should I use?');
  check(!(await history.add(made.chat.id, 'admin', 'x')).ok, 'only "user" and "lefty" messages are saved');
  await history.add(made.chat.id, 'lefty', 'x'.repeat(9000));
  await history.setProject(made.chat.id, 'C:\\Users\\me\\Documents\\Lefty Projects\\portfolio');
  const got = await history.get(made.chat.id);
  check(got.ok && got.chat.messages.length === 3 && got.chat.messages[0].role === 'user', 'the chat comes back with its messages in order');
  check(got.chat.messages[2].text.length === 8000, 'a very long message is cut to 8000 characters');
  check(/portfolio$/.test(got.chat.project), "the chat remembers its project's folder");
  const second = await history.create('Focus 30 minutes on VS Code');
  await history.add(second.chat.id, 'user', 'Focus 30 minutes on VS Code');
  const list = await history.list();
  check(list.ok && list.chats.length === 2 && list.chats[0].id === second.chat.id, 'the list shows the newest chat first');
  const usage = await history.usage();
  check(usage.ok && usage.where === 'pc' && usage.used > 8000 && usage.limit === 50 * 1024 * 1024, `the storage bar knows what's used on this PC (${usage.used} bytes)`);
  check((await history.remove(made.chat.id)).ok && (await history.list()).chats.length === 1, 'deleting a chat removes it');
  const after = await history.usage();
  check(after.used < usage.used, 'deleting frees space');

  // --- Supabase (a fake server) ---
  process.env.SUPABASE_URL = 'https://demo.supabase.co/';
  process.env.SUPABASE_ANON_KEY = 'anon-key';
  check(history.where() === 'supabase', 'with a Supabase URL and key, chats go to Supabase');
  const calls = [];
  let signups = 0;
  const rows = [];
  const reply = (status, body) => ({ ok: status < 400, status, text: async () => (body === undefined ? '' : JSON.stringify(body)) });
  history.useFetch(async (url, options = {}) => {
    calls.push({ url, method: options.method || 'GET', headers: options.headers || {}, body: options.body });
    if (url.endsWith('/auth/v1/signup')) { signups += 1; return reply(200, { access_token: 'tok-1', refresh_token: 'ref-1', expires_in: 3600 }); }
    if (url.includes('/rest/v1/lefty_chats') && options.method === 'POST') { rows.push({ id: 'c1', title: JSON.parse(options.body).title }); return reply(201, [rows[0]]); }
    if (url.includes('/rest/v1/lefty_chats?select=id,title,project,updated_at')) return reply(200, rows);
    if (url.includes('/rest/v1/lefty_messages') && options.method === 'POST') return reply(201);
    if (url.includes('/rest/v1/rpc/lefty_usage')) return reply(200, { database: 30 * 1024 * 1024, mine: 4096 });
    if (url.includes('/rest/v1/lefty_chats?id=eq.') && options.method === 'DELETE') return reply(204);
    return reply(404, { message: 'not found' });
  });
  const cloud = await history.create('Make it dark');
  check(cloud.ok && cloud.chat.id === 'c1' && signups === 1, 'the first use signs in as an anonymous user, then saves the chat');
  const authed = calls.find((c) => c.url.includes('/rest/v1/lefty_chats'));
  check(authed.headers.apikey === 'anon-key' && authed.headers.Authorization === 'Bearer tok-1' && authed.url.startsWith('https://demo.supabase.co/rest/v1/'), 'requests carry the anon key and the user token');
  await history.add('c1', 'user', 'Make it dark');
  check(signups === 1, 'the session is reused, not a new user each time');
  check(fs.existsSync(path.join(dir, 'supabase-session.json')), "the session is kept in Lefty's data folder");
  const cloudUsage = await history.usage();
  check(cloudUsage.ok && cloudUsage.where === 'supabase' && cloudUsage.used === 30 * 1024 * 1024 && cloudUsage.limit === 500 * 1024 * 1024 && cloudUsage.mine === 4096,
    "the storage bar counts the whole database against the free plan's 500 MB");
  check((await history.remove('c1')).ok, 'a chat can be deleted on Supabase');

  // Not set up yet: a clear message, never a crash.
  history.useFetch(async (url) => (url.includes('/auth/') ? reply(422, { msg: 'Anonymous sign-ins are disabled' }) : reply(500, {})));
  fs.rmSync(path.join(dir, 'supabase-session.json'));
  const off = await history.list();
  check(!off.ok && off.setup && /anonymous sign-ins/i.test(off.error), 'with anonymous sign-ins off, Lefty says which switch to turn on');
  history.useFetch(async (url) => (url.includes('/auth/') ? reply(200, { access_token: 't', refresh_token: 'r', expires_in: 3600 }) : reply(404, { message: 'relation "public.lefty_chats" does not exist' })));
  const noTables = await history.list();
  check(!noTables.ok && noTables.setup && /supabase\.sql/.test(noTables.error), 'without the tables, Lefty says to run supabase.sql');
  history.useFetch(async () => { throw new TypeError('fetch failed'); });
  const offline = await history.usage();
  check(!offline.ok && !offline.setup, 'offline: the call fails quietly with ok: false');

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(failed ? `\n${failed} history check(s) failed.` : '\nAll history checks passed.');
  process.exit(failed ? 1 : 0);
})();

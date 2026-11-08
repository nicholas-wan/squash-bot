// Counts D1 and Telegram round trips per flow, against the real worker and the
// real schema, with a fixed fake latency on every call: elapsed / LAT is
// roughly the number of hops one after another. Local only: the database is
// an in-memory SQLite and every Telegram call is answered here.
//
//   node bench/latency.mjs            every flow, each in a fresh process
//   node bench/latency.mjs settle     one flow, with its call log
//
// Hop counts are approximate (timer granularity varies by OS);
// test/speed.test.js pins the ones that matter exactly.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
const FLOWS = ['join', 'leave', 'openjoin', 'parse', 'confirm', 'cancel', 'settle', 'debt',
  'chat', 'app', 'cron'];
const flow = process.argv[2] || 'all';
if (flow === 'all') {
  for (const name of FLOWS) {
    const out = execFileSync(process.execPath, [fileURLToPath(import.meta.url), name, '--quiet'],
      { encoding: 'utf8' });
    process.stdout.write(out);
  }
  process.exit(0);
}
const QUIET = process.argv.includes('--quiet');
const src = (f) => pathToFileURL(`${ROOT}/src/${f}`).href;
const worker = (await import(src('index.js'))).default;
const { signInitData } = await import(src('miniapp-auth.js'));
const { clearAdminCache } = await import(src('players.js'));

const LAT = 10;
// The worker logs a line of its own per tap; a summary run keeps only ours.
const print = console.log;
if (QUIET) console.log = () => {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CHAT = -1001;
const OWNER_ID = 111;
const MEMBER = { id: 222, username: 'alice', first_name: 'Alice' };
const ADMIN = { id: OWNER_ID, username: 'nicholaswan', first_name: 'Nick' };

let db, ops, t0;
function now() { return Date.now() - t0; }
function log(kind, what) { ops.push({ at: now(), kind, what }); }

function makeDb() {
  db = new DatabaseSync(':memory:');
  db.exec(readFileSync(`${ROOT}/schema.sql`, 'utf8'));
  const stmt = (sql, args) => ({
    sql, args,
    async first() { log('d1', sql.slice(0, 60)); await sleep(LAT); return db.prepare(sql).get(...args) || null; },
    async all() { log('d1', sql.slice(0, 60)); await sleep(LAT); return { results: db.prepare(sql).all(...args) }; },
    async run() { log('d1', sql.slice(0, 60)); await sleep(LAT); return raw(sql, args); },
  });
  const raw = (sql, args) => {
    if (/RETURNING/i.test(sql)) { const rows = db.prepare(sql).all(...args); return { results: rows, meta: { changes: rows.length } }; }
    if (/^\s*(SELECT|WITH)/i.test(sql)) return { results: db.prepare(sql).all(...args), meta: {} };
    const r = db.prepare(sql).run(...args);
    return { meta: { changes: r.changes, last_row_id: Number(r.lastInsertRowid) } };
  };
  return {
    prepare(sql) { return { bind(...args) { return stmt(sql, args); } }; },
    async batch(list) {
      log('d1', `BATCH[${list.length}] ${list[0].sql.slice(0, 40)}`); await sleep(LAT);
      db.exec('BEGIN');
      try { const out = list.map((s) => raw(s.sql, s.args)); db.exec('COMMIT'); return out; }
      catch (e) { db.exec('ROLLBACK'); throw e; }
    },
  };
}

let msgId = 1000;
globalThis.fetch = async (url, init) => {
  const method = String(url).split('/').pop();
  const body = init && init.body && typeof init.body === 'string' ? JSON.parse(init.body) : {};
  log('tg', method);
  await sleep(LAT);
  let result = true;
  if (method === 'getChatMember') result = { status: body.user_id === OWNER_ID ? 'creator' : 'member' };
  if (method === 'sendMessage') result = body.receiver_user_id ? { ephemeral_message_id: ++msgId } : { message_id: ++msgId };
  if (method === 'getMe') result = { username: 'squashbot' };
  return new Response(JSON.stringify({ ok: true, result }), { headers: { 'Content-Type': 'application/json' } });
};

const env = {
  BOT_TOKEN: '1:test', WEBHOOK_SECRET: 's', ALLOWED_CHATS: String(CHAT), DEFAULT_TIMEZONE: 'Asia/Singapore',
  OWNER: '@nicholaswan', OWNER_USER_ID: String(OWNER_ID), DEFAULT_PLAYERS: `${OWNER_ID}:@nicholaswan,333:@dodgerblueee`,
  DEFAULT_CAPACITY: '3',
};

function seed() {
  env.DB = makeDb(); warmed = false;
  clearAdminCache();
  const start = Date.now() + 2 * 86400000;
  db.exec(`INSERT INTO settings (chat_id, board_message_id, tab_message_id) VALUES (${CHAT}, 50, 51)`);
  db.prepare(`INSERT INTO bookings (id, chat_id, court, starts_at, ends_at, reminder_at, pre_reminder_at, capacity, created_by_user_id, created_by_name, created_at)
    VALUES (7, ?, '4', ?, ?, ?, ?, 4, ?, '@nicholaswan', ?)`).run(CHAT, start, start + 3600000, start - 3 * 3600000, start - 7200000, OWNER_ID, Date.now());
  db.prepare(`INSERT INTO booking_players (booking_id, chat_id, user_id, slug, name, created_at) VALUES (7, ?, ?, '@nicholaswan', '@nicholaswan', 0), (7, ?, 333, '@dodgerblueee', '@dodgerblueee', 0)`).run(CHAT, OWNER_ID, CHAT);
  db.prepare(`INSERT INTO availability_notices (chat_id, booking_id, message_id, html) VALUES (?, 7, 60, 'x')`).run(CHAT);
  db.prepare(`INSERT INTO ledger (chat_id, slug, user_id, name, amount_cents, created_at, reason) VALUES (?, 'u222', 222, '@alice', 600, 1, 'Court')`).run(CHAT);
  db.exec(`UPDATE maintenance_schedule SET next_due = 0`);
}

let uid = 1; let warmed = false;
async function webhook(update) {
  const waits = [];
  const ctx = { waitUntil: (p) => waits.push(p) };
  const req = new Request('https://x/webhook', {
    method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': 's' },
    body: JSON.stringify({ update_id: uid++, ...update }),
  });
  ops = []; t0 = Date.now();
  const res = await worker.fetch(req, env, ctx);
  const answered = now();
  const text = await res.text();
  await Promise.all(waits);
  return { answered, total: now(), text };
}

async function miniapp(method, path, user, body) {
  const fields = { auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify(user), start_param: `g${CHAT}` };
  fields.hash = await signInitData(env.BOT_TOKEN, fields);
  const init = new URLSearchParams(fields).toString();
  const waits = [];
  const ctx = { waitUntil: (p) => waits.push(p) };
  ops = []; t0 = Date.now();
  const res = await worker.fetch(new Request(`https://x/api/app/${path}`, {
    method, headers: { Authorization: `tma ${init}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  }), env, ctx);
  const answered = now();
  const text = await res.text();
  await Promise.all(waits);
  return { answered, total: now(), text: text.slice(0, 80) };
}

function report(name, r, firstTg) {
  const d1 = ops.filter((o) => o.kind === 'd1');
  const tg = ops.filter((o) => o.kind === 'tg');
  const firstUserTg = firstTg ? ops.find((o) => o.kind === 'tg' && firstTg.test(o.what)) : null;
  print(`\n## ${name}`);
  print(`answered at ${r.answered}ms (~${Math.round(r.answered / LAT)} hops)` +
    (firstUserTg ? `; first ${firstUserTg.what} starts at ${firstUserTg.at}ms (~${Math.round(firstUserTg.at / LAT)} hops)` : '') +
    `; all work done ${r.total}ms (~${Math.round(r.total / LAT)} hops); D1 calls ${d1.length}, TG calls ${tg.length}`);
  if (!QUIET) for (const o of ops) print(`  ${String(o.at).padStart(5)} ${o.kind} ${o.what.replace(/\s+/g, ' ')}`);
}

const cb = (from, data, extra = {}) => ({
  callback_query: { id: `cb${uid}`, from, data, message: { message_id: 50, chat: { id: CHAT, type: 'supergroup' }, ...extra } },
});
const msg = (from, text) => ({ message: { message_id: 900 + uid, chat: { id: CHAT, type: 'supergroup' }, from, text } });

const want = (n) => flow === n;

if (want('join')) { seed(); report('Join tap (sb:join:7) from pinned board', await webhook(cb(MEMBER, 'sb:join:7'))); }
if (want('leave')) {
  seed(); db.prepare(`INSERT INTO booking_players (booking_id, chat_id, user_id, slug, name, created_at) VALUES (7, ?, 222, '@alice', '@alice', 0)`).run(CHAT);
  report('Leave tap (sb:leave:7)', await webhook(cb(MEMBER, 'sb:leave:7')));
}
if (want('openjoin')) { seed(); report('Open 🙋 Join picker (sb:join)', await webhook(cb(MEMBER, 'sb:join'))); }
if (want('parse')) { seed(); report('Admin posts "13 Dec court 4 9pm"', await webhook(msg(ADMIN, '13 Dec court 4 9pm')), /sendMessage/); }
if (want('confirm')) {
  seed(); await webhook(msg(ADMIN, '13 Dec court 4 9pm'));
  const draft = db.prepare('SELECT id FROM booking_drafts').get();
  report('Wizard confirm (bw:id:y)', await webhook(cb(ADMIN, `bw:${draft.id}:y`, { message_id: 0, ephemeral_message_id: 99 })));
}
if (want('cancel')) { seed(); report('/cancel 7', await webhook(msg(ADMIN, '/cancel 7')), /sendMessage/); }
if (want('settle')) { seed(); report('Settle tap (tb:paid:600:u222)', await webhook(cb(ADMIN, 'tb:paid:600:u222', { message_id: 0, ephemeral_message_id: 88 }))); }
if (want('debt')) {
  seed(); await webhook(msg(ADMIN, '/debt +2 alice ice cream'));
  const d = db.prepare('SELECT id FROM debt_drafts').get();
  report('/debt confirm (tb:debt:id)', await webhook(cb(ADMIN, `tb:debt:${d.id}`, { message_id: 0, ephemeral_message_id: 88 })));
}
if (want('chat')) { seed(); report('Plain chat message from member', await webhook(msg(MEMBER, 'see you all tonight'))); }
if (want('app')) {
  seed(); report('Mini App GET courts (member, cold role cache)', await miniapp('GET', 'courts', MEMBER));
  report('Mini App GET courts (member, warm)', await miniapp('GET', 'courts', MEMBER));
  report('Mini App GET courts (admin, cold)', await miniapp('GET', 'courts', ADMIN));
  report('Mini App POST join (member, warm)', await miniapp('POST', 'court/7/join', MEMBER, {}));
  report('Mini App GET tab (member)', await miniapp('GET', 'tab', MEMBER));
  report('Mini App GET court/7 (admin)', await miniapp('GET', 'court/7', ADMIN));
  report('Mini App POST pay (admin)', await miniapp('POST', 'tab/person/u222/pay', ADMIN, { cents: 600, expected: 600 }));
}
async function cron(name) {
  const waits = []; const ctx = { waitUntil: (p) => waits.push(p) };
  ops = []; t0 = Date.now();
  await worker.scheduled({}, env, ctx); await Promise.all(waits);
  report(name, { answered: now(), total: now() });
}
if (want('cron')) {
  seed();
  await cron('Cron tick: forced full sweep (next_due = 0), nothing actually due');
  await cron('Cron tick: idle (schedule says not due)');
  // A reminder due now for a 3-player court.
  db.exec(`UPDATE bookings SET reminder_at = ${Date.now() - 1000}`);
  db.prepare(`INSERT INTO booking_players (booking_id, chat_id, user_id, slug, name, created_at) VALUES (7, ?, 222, '@alice', '@alice', 0)`).run(CHAT);
  db.exec('UPDATE maintenance_schedule SET next_due = 0');
  await cron('Cron tick: day reminder due for 3 players');
}

// The speed pass (8 Nov 2026), held in place. Latency here is round trips:
// D1 and Telegram are each a network hop from the Worker, and a tap from
// Singapore pays every one of them twice over. These run the Worker's own
// entry points against the real schema and count waves: a call that starts
// before the one ahead of it has finished shares its wave, one that waits for
// it starts the next. A wave is one hop of wall clock however many calls
// ride in it.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index.js';
import { signInitData } from '../src/miniapp-auth.js';
import { clearAdminCache } from '../src/players.js';
import { updateBoard } from '../src/bookings.js';
import { updateTab } from '../src/tab.js';

const CHAT = -1001;
const OWNER_ID = 111;
const MEMBER = { id: 222, username: 'alice', first_name: 'Alice' };
const ADMIN = { id: OWNER_ID, username: 'nicholaswan', first_name: 'Nick' };
const HOUR = 3600000;

let sql, env, calls, done, tasks, nextId, sendFails;

// Every call is one hop. `done` is the latest wave that has finished, so a
// call starting now waits behind exactly that many.
async function hop(kind, what, work) {
  const call = { kind, what, wave: done + 1 };
  calls.push(call);
  await new Promise((resolve) => setTimeout(resolve, 2));
  const out = await work();
  done = Math.max(done, call.wave);
  return out;
}

// D1 as the Worker sees it: a batch is one round trip and one transaction,
// and a read in a batch answers with its rows.
function d1(db) {
  const exec = (query, args) => {
    const statement = db.prepare(query);
    if (/^\s*(SELECT|WITH)/i.test(query) || /RETURNING/i.test(query)) {
      const rows = statement.all(...args);
      return { results: rows, meta: { changes: /RETURNING/i.test(query) ? rows.length : 0 } };
    }
    const result = statement.run(...args);
    return { results: [], meta: { changes: result.changes, last_row_id: Number(result.lastInsertRowid) } };
  };
  return {
    prepare(query) {
      return {
        bind(...args) {
          return {
            query, args,
            first: () => hop('d1', query, () => exec(query, args).results[0] || null),
            all: () => hop('d1', query, () => exec(query, args)),
            run: () => hop('d1', query, () => exec(query, args)),
          };
        },
      };
    },
    batch(statements) {
      return hop('d1', `batch of ${statements.length}`, () => {
        db.exec('BEGIN');
        try {
          const results = statements.map((statement) => exec(statement.query, statement.args));
          db.exec('COMMIT');
          return results;
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
      });
    },
  };
}

beforeEach(() => {
  sql = new DatabaseSync(':memory:');
  sql.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  calls = [];
  done = 0;
  tasks = [];
  nextId = 1000;
  sendFails = null;
  clearAdminCache();
  env = {
    BOT_TOKEN: '1:test', WEBHOOK_SECRET: 's', ALLOWED_CHATS: String(CHAT),
    DEFAULT_TIMEZONE: 'Asia/Singapore', OWNER: '@nicholaswan', OWNER_USER_ID: String(OWNER_ID),
    DEFAULT_PLAYERS: `${OWNER_ID}:@nicholaswan,333:@dodgerblueee`, DEFAULT_CAPACITY: '3',
    DB: d1(sql),
  };
  const start = Date.now() + 2 * 24 * HOUR;
  sql.exec(`INSERT INTO settings (chat_id, board_message_id, tab_message_id) VALUES (${CHAT}, 50, 51)`);
  sql.prepare(`INSERT INTO bookings (id, chat_id, court, starts_at, ends_at, reminder_at,
      pre_reminder_at, capacity, created_by_user_id, created_by_name, created_at)
    VALUES (7, ?, '4', ?, ?, ?, ?, 4, ?, '@nicholaswan', ?)`)
    .run(CHAT, start, start + HOUR, start - 3 * HOUR, start - 2 * HOUR, OWNER_ID, Date.now());
  sql.prepare(`INSERT INTO booking_players (booking_id, chat_id, user_id, slug, name, created_at)
    VALUES (7, ?, ?, '@nicholaswan', '@nicholaswan', 0), (7, ?, 333, '@dodgerblueee', '@dodgerblueee', 0)`)
    .run(CHAT, OWNER_ID, CHAT);
  sql.prepare(`INSERT INTO availability_notices (chat_id, booking_id, message_id, html)
    VALUES (?, 7, 60, 'x')`).run(CHAT);
  sql.prepare(`INSERT INTO ledger (chat_id, slug, user_id, name, amount_cents, created_at, reason)
    VALUES (?, 'u222', 222, '@alice', 600, 1, 'Court')`).run(CHAT);
  // Both senders already linked, as anybody who has tapped before is.
  sql.prepare(`INSERT INTO ledger_identity_aliases (chat_id, slug, user_id)
    VALUES (?, '@alice', 222), (?, '@nicholaswan', ?)`).run(CHAT, CHAT, OWNER_ID);
  vi.stubGlobal('fetch', vi.fn((url, init) => {
    const method = String(url).split('/').pop();
    const body = JSON.parse(init.body);
    return hop('tg', method, () => {
      if (sendFails && sendFails(method, body)) throw sendFails(method, body);
      let result = true;
      if (method === 'getChatMember') {
        result = { status: body.user_id === OWNER_ID ? 'creator' : 'member' };
      }
      if (method === 'sendMessage') {
        result = body.receiver_user_id ? { ephemeral_message_id: ++nextId } : { message_id: ++nextId };
      }
      return new Response(JSON.stringify({ ok: true, result }));
    });
  }));
});

afterEach(() => {
  sql.close();
  vi.unstubAllGlobals();
});

const ctx = () => ({ waitUntil: (task) => tasks.push(task) });
const settle = async () => { for (let i = 0; i < tasks.length; i += 1) await tasks[i]; };
const d1Calls = () => calls.filter((call) => call.kind === 'd1');
let updateId = 1;

// Answers the wave the toast went out after, which is what the tapper waits.
async function tap(from, data, message = { message_id: 50 }) {
  const response = await worker.fetch(new Request('https://squash.test/webhook', {
    method: 'POST',
    headers: { 'X-Telegram-Bot-Api-Secret-Token': 's' },
    body: JSON.stringify({ update_id: updateId++, callback_query: {
      id: `cb${updateId}`, from, data,
      message: { chat: { id: CHAT, type: 'supergroup' }, ...message },
    } }),
  }), env, ctx());
  const answeredAfter = done;
  const toast = await response.json();
  await settle();
  return { answeredAfter, toast };
}

async function say(from, text) {
  await worker.fetch(new Request('https://squash.test/webhook', {
    method: 'POST',
    headers: { 'X-Telegram-Bot-Api-Secret-Token': 's' },
    body: JSON.stringify({ update_id: updateId++, message: {
      message_id: 900 + updateId, chat: { id: CHAT, type: 'supergroup' }, from, text,
    } }),
  }), env, ctx());
  await settle();
}

async function app(method, path, user, body) {
  const fields = {
    auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify(user),
    start_param: `g${CHAT}`,
  };
  fields.hash = await signInitData(env.BOT_TOKEN, fields);
  calls = [];
  done = 0;
  const response = await worker.fetch(new Request(`https://squash.test/api/app/${path}`, {
    method,
    headers: { Authorization: `tma ${new URLSearchParams(fields)}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  }), env, ctx());
  const answeredAfter = done;
  const json = await response.json();
  await settle();
  return { answeredAfter, json };
}

describe('round trips before the answer', () => {
  it('answers a Join tap after the entry batch and one more hop', async () => {
    const { answeredAfter, toast } = await tap(MEMBER, 'sb:join:7');
    expect(toast.text).toContain('You are in');
    // The update, its sender and any waiting notice in one batch; the
    // booking read and the guarded insert together.
    expect(answeredAfter).toBeLessThanOrEqual(2);
    expect(sql.prepare('SELECT COUNT(*) AS n FROM booking_players WHERE booking_id = 7').get().n)
      .toBe(3);
  });

  it('answers a Leave tap the same way', async () => {
    sql.prepare(`INSERT INTO booking_players (booking_id, chat_id, user_id, slug, name, created_at)
      VALUES (7, ?, 222, '@alice', '@alice', 0)`).run(CHAT);
    const { answeredAfter, toast } = await tap(MEMBER, 'sb:leave:7');
    expect(toast.text).toContain('You are out');
    expect(answeredAfter).toBeLessThanOrEqual(2);
  });

  it('settles a balance without waiting for the pinned tab', async () => {
    const { answeredAfter, toast } = await tap(ADMIN, 'tb:paid:600:u222',
      { message_id: 0, ephemeral_message_id: 88 });
    expect(toast.text).toContain('cleared');
    // Entry, balances, the guarded payment, then the receipt beside the
    // redrawn list. The tab redraw used to add about nine hops before this.
    expect(answeredAfter).toBeLessThanOrEqual(4);
    // And the tab is still redrawn, once the toast has gone.
    expect(calls.some((call) => call.what === 'unpinChatMessage' || call.what === 'editMessageText'))
      .toBe(true);
  });

  it('opens the Mini App court list with the membership check beside the reads', async () => {
    const { answeredAfter, json } = await app('GET', 'courts', MEMBER);
    expect(json.ok).toBe(true);
    const member = calls.find((call) => call.what === 'getChatMember');
    const bookings = calls.find((call) => call.kind === 'd1' && /FROM bookings/.test(call.what));
    expect(member.wave).toBe(bookings.wave);
    expect(answeredAfter).toBe(1);
  });

  it('still turns away somebody no longer in the group, having written nothing', async () => {
    const stranger = { id: 999, username: 'gone', first_name: 'Gone' };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ok: true, result: { status: 'left' },
    }))));
    const before = sql.prepare('SELECT COUNT(*) AS n FROM ledger_identity_aliases').get().n;
    const { json } = await app('POST', 'court/7/join', stranger, {});
    expect(json.ok).toBe(false);
    expect(sql.prepare('SELECT COUNT(*) AS n FROM ledger_identity_aliases').get().n).toBe(before);
  });

  it('records a Mini App payment without waiting for the pinned tab', async () => {
    const { answeredAfter, json } = await app('POST', 'tab/person/u222/pay', ADMIN,
      { cents: 600, expected: 600 });
    expect(json.ok).toBe(true);
    expect(json.message).toContain('They have a receipt.');
    expect(answeredAfter).toBeLessThanOrEqual(5);
  });

  it('costs a plain chat message one database round trip', async () => {
    await say(MEMBER, 'see you all tonight');
    // The update, its sender, any waiting notice and the cold timezone: one batch.
    expect(d1Calls()).toHaveLength(1);
    expect(d1Calls()[0].what).toMatch(/^batch/);
  });
});

describe('redraws', () => {
  it('draws the board in three database waves', async () => {
    calls = [];
    done = 0;
    await updateBoard(env, CHAT);
    // Board reads with the pinned ids; the announcement's lease beside its
    // reads; its last write giving the lease back. Two Telegram edits between
    // them make five waves in all, where it used to be nine.
    expect(new Set(d1Calls().map((call) => call.wave)).size).toBe(3);
    expect(Math.max(...calls.map((call) => call.wave))).toBe(5);
  });

  it('shares one waiting redraw between a burst of requests', async () => {
    calls = [];
    done = 0;
    await Promise.all([1, 2, 3, 4, 5].map(() => updateBoard(env, CHAT)));
    const edits = calls.filter((call) => call.what === 'editMessageText');
    // One running, one waiting that covers the other four: two boards, and
    // an announcement edit at most each.
    expect(edits.length).toBeLessThanOrEqual(4);
  });

  it('leaves the announcement alone when the tab is edited in place', async () => {
    calls = [];
    done = 0;
    await updateTab(env, CHAT);
    expect(d1Calls().some((call) => /availability_notices/.test(call.what))).toBe(false);
  });
});

describe('a send cut off by the timeout', () => {
  it('is not sent again, and nobody is tagged in the group instead', async () => {
    const now = Date.now();
    sql.prepare('UPDATE bookings SET reminder_at = ? WHERE id = 7').run(now - 1000);
    sql.exec('UPDATE maintenance_schedule SET next_due = 0');
    sendFails = (method, body) => (method === 'sendMessage' && body.receiver_user_id
      ? Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })
      : null);
    await worker.scheduled({}, env, ctx());
    await settle();
    const sends = () => calls.filter((call) => call.what === 'sendMessage');
    const first = sends().length;
    expect(first).toBeGreaterThan(0);
    // Still spent, so the next tick has nothing to resend.
    expect(sql.prepare('SELECT SUM(reminder_sent) AS n FROM booking_players WHERE booking_id = 7').get().n)
      .toBe(2);
    sql.exec('UPDATE maintenance_schedule SET next_due = 0');
    await worker.scheduled({}, env, ctx());
    await settle();
    expect(sends().length).toBe(first);
  });
});

describe('the review of the speed pass', () => {
  it('still handles an update whose first batch committed but answered with an error', async () => {
    const batch = env.DB.batch;
    let failOnce = true;
    env.DB.batch = async (statements) => {
      const results = await batch(statements);
      if (failOnce && statements.length > 2) {
        failOnce = false;
        throw new Error('D1 connection lost after commit');
      }
      return results;
    };
    const { toast } = await tap(MEMBER, 'sb:join:7');
    expect(toast.text).toContain('You are in');
  });

  it('keeps reminders that went out spent when their cleanup rows fail', async () => {
    const now = Date.now();
    sql.prepare('UPDATE bookings SET reminder_at = ? WHERE id = 7').run(now - 1000);
    sql.exec('UPDATE maintenance_schedule SET next_due = 0');
    const batch = env.DB.batch;
    env.DB.batch = async (statements) => {
      if (statements.some((statement) => /INSERT INTO sent_messages/.test(statement.query))) {
        throw new Error('D1 write failed');
      }
      return batch(statements);
    };
    await worker.scheduled({}, env, ctx());
    await settle();
    expect(sql.prepare('SELECT SUM(reminder_sent) AS n FROM booking_players WHERE booking_id = 7').get().n)
      .toBe(2);
  });
});

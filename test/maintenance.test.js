import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { addPlayerView, runMaintenance } from '../src/bookings.js';
import { adminAddPlayer } from '../src/players.js';

let db, env, requests, reply;
const now = Date.UTC(2026, 8, 10); // Thu 10 Sep 2026, 8am SGT
const HOUR = 3600000;
const DAY = 24 * HOUR;
beforeEach(() => {
  // Some paths read the clock themselves rather than taking it as an argument.
  vi.useFakeTimers({ now, toFake: ['Date'] });
  db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  env = { BOT_TOKEN: 'test', ALLOWED_CHATS: '-123', DB: {
    prepare(sql) { return { bind(...args) {
      const statement = db.prepare(sql);
      return {
        async first() { return statement.get(...args) || null; },
        async all() { return { results: statement.all(...args) }; },
        async run() {
          const result = statement.run(...args);
          return { meta: { changes: result.changes, last_row_id: Number(result.lastInsertRowid) } };
        },
      };
    } }; },
  } };
  requests = [];
  reply = () => null;
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    const method = String(url).split('/').at(-1);
    const body = JSON.parse(init.body);
    requests.push({ method, ...body });
    const result = reply(method, body) || { ok: true, result: { message_id: requests.length + 100 } };
    return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
  }));
});
afterEach(() => { db.close(); vi.unstubAllGlobals(); vi.useRealTimers(); });

function book(id, startsAt, { endsAt = startsAt + HOUR, preReminderAt = startsAt - 2 * HOUR } = {}) {
  db.prepare(`INSERT INTO bookings
    (id, chat_id, court, starts_at, ends_at, reminder_at, reminder_sent, pre_reminder_at, created_at)
    VALUES (?, -123, '4', ?, ?, ?, 1, ?, ?)`)
    .run(id, startsAt, endsAt, startsAt - 3 * HOUR, preReminderAt, now - DAY);
}

function seat(bookingId, userId, slug = `u${userId}`, name = 'Player') {
  db.prepare(`INSERT INTO booking_players (booking_id, chat_id, user_id, slug, name, created_at)
    VALUES (?, -123, ?, ?, ?, ?)`).run(bookingId, userId, slug, name, now - DAY);
}

function pinBoard({ boardDay = '2026-9-10' } = {}) {
  db.prepare('INSERT INTO settings (chat_id, board_message_id, board_day) VALUES (-123, 50, ?)')
    .run(boardDay);
}

it('still puts new charges on the pinned tab when the board cannot be edited', async () => {
  book(1, now - 2 * HOUR);
  seat(1, 5);
  book(2, now + 3 * DAY);
  pinBoard();
  reply = (method, body) => (method === 'editMessageText' && body.message_id === 50
    ? { ok: false, description: 'Too Many Requests: retry after 5' } : null);
  await runMaintenance(env, now);
  const tab = requests.find((request) => request.method === 'sendMessage'
    && String(request.text).includes('Squash tab'));
  expect(tab).toBeDefined();
  expect(db.prepare('SELECT tab_message_id FROM settings WHERE chat_id = -123').get().tab_message_id)
    .not.toBeNull();
  // The board is still owed a redraw.
  expect(db.prepare('SELECT board FROM pending_refreshes WHERE chat_id = -123').get().board).toBe(1);
});

it('stops retrying a chat the bot has been removed from, so maintenance can finish', async () => {
  book(1, now + 3 * DAY);
  pinBoard();
  db.prepare('INSERT INTO pending_refreshes (chat_id, board, tab, updated_at) VALUES (-123, 1, 0, ?)')
    .run(now - 5000);
  reply = (method, body) => (method === 'editMessageText' && body.message_id === 50
    ? { ok: false, description: 'Forbidden: bot was kicked from the supergroup chat' } : null);
  const result = await runMaintenance(env, now);
  expect(result.failures.join('; ')).not.toContain('queued pinned refreshes');
  expect(db.prepare('SELECT * FROM pending_refreshes').all()).toEqual([]);
});

it('keeps retrying a chat whose failure is only temporary', async () => {
  book(1, now + 3 * DAY);
  pinBoard();
  db.prepare('INSERT INTO pending_refreshes (chat_id, board, tab, updated_at) VALUES (-123, 1, 0, ?)')
    .run(now - 5000);
  reply = (method, body) => (method === 'editMessageText' && body.message_id === 50
    ? { ok: false, description: 'Too Many Requests: retry after 5' } : null);
  const result = await runMaintenance(env, now);
  expect(result.failures.join('; ')).toContain('queued pinned refreshes');
  expect(db.prepare('SELECT board FROM pending_refreshes WHERE chat_id = -123').get().board).toBe(1);
});

it('never reminds a player twice when the public fallback fails', async () => {
  // Starts in an hour, so the two-hour reminder is due.
  book(1, now + HOUR);
  seat(1, 1);
  seat(1, 2);
  seat(1, 3);
  reply = (method, body) => {
    if (method !== 'sendMessage') return null;
    // Player 2 cannot be reached privately, and the group fallback fails too.
    if (body.receiver_user_id === 2) return { ok: true, result: { message_id: 9 } };
    if (!body.receiver_user_id) return { ok: false, description: 'Internal Server Error' };
    return { ok: true, result: { message_id: 8, ephemeral_message_id: body.receiver_user_id } };
  };
  await runMaintenance(env, now);
  await runMaintenance(env, now + 60000);
  const remindersTo = (userId) => requests.filter((request) => request.method === 'sendMessage'
    && request.receiver_user_id === userId).length;
  expect(remindersTo(1)).toBe(1);
  expect(remindersTo(3)).toBe(1);
  // Player 2 is still owed theirs, and gets another try.
  expect(remindersTo(2)).toBe(2);
});

it('never offers the same person twice under their handle and their account', async () => {
  book(1, now + 3 * DAY);
  // Seated by handle before they ever posted, so the row has no id yet...
  seat(1, null, '@foo', '@foo');
  // ...but their charges are filed under their account, which the alias links.
  db.prepare("INSERT INTO ledger_identity_aliases (chat_id, slug, user_id) VALUES (-123, '@foo', 42)").run();
  db.prepare(`INSERT INTO ledger (chat_id, slug, user_id, name, amount_cents, reason, created_at)
    VALUES (-123, 'u42', 42, '@foo', 600, 'Court', ?), (-123, 'u7', 7, '@bar', 600, 'Court', ?)`)
    .run(now - DAY, now - DAY);
  const view = await addPlayerView(env, -123, 1);
  const targets = view.replyMarkup.inline_keyboard.flat().map((button) => button.callback_data);
  expect(targets).toContain('sb:addp:1:1:u7');
  expect(targets.some((target) => target.endsWith(':u42'))).toBe(false);
});

it('refuses to seat somebody already on the court under another key', async () => {
  book(1, now + 3 * DAY);
  seat(1, 42, '@foo', '@foo');
  const result = await adminAddPlayer(env, -123, 1, { slug: 'u42', user_id: 42, name: '@foo' }, 9);
  expect(result.status).toBe('already');
  expect(db.prepare('SELECT COUNT(*) AS n FROM booking_players').get().n).toBe(1);
});

it('offers every known player once when nobody overlaps', async () => {
  book(1, now + 3 * DAY);
  db.prepare(`INSERT INTO ledger (chat_id, slug, user_id, name, amount_cents, reason, created_at)
    VALUES (-123, 'u7', 7, '@bar', 600, 'Court', ?), (-123, 'u8', 8, '@baz', 600, 'Court', ?)`)
    .run(now - DAY, now - DAY);
  const view = await addPlayerView(env, -123, 1);
  const names = view.replyMarkup.inline_keyboard.flat().map((button) => button.text)
    .filter((text) => text.startsWith('➕'));
  expect(names).toEqual(['➕ @bar', '➕ @baz']);
});

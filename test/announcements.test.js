import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { NO_COURTS_HTML, syncAnnouncements } from '../src/announcements.js';
import { addBooking, runMaintenance, updateBoard } from '../src/bookings.js';
import { clearAdminCache } from '../src/players.js';
import { sendPrivateNote } from '../src/tab.js';
import { handleBookingCallback } from '../src/wizard.js';
import { handleUpdate } from '../src/index.js';

let db, env, requests, failure, failWrite;
const now = Date.UTC(2026, 8, 10);
const DAY = 86400000;
beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  // Verify the incremental migration is safe on the complete schema too.
  db.exec(readFileSync(new URL('../migrations/014-availability-notices.sql', import.meta.url), 'utf8'));
  env = { BOT_TOKEN: 'test', ALLOWED_CHATS: '-123', DB: {
    prepare(sql) { return { bind(...args) {
      const statement = db.prepare(sql);
      return {
        async first() { return statement.get(...args) || null; },
        async all() { return { results: statement.all(...args) }; },
        async run() {
          if (failWrite?.(sql)) throw new Error('Injected database write failure');
          const result = statement.run(...args);
          return { meta: { changes: result.changes, last_row_id: Number(result.lastInsertRowid) } };
        },
      };
    } }; },
    async batch(statements) {
      db.exec('BEGIN');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        db.exec('COMMIT');
        return results;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
  } };
  // Booking 1 is three days out; a nearer court can be added in front of it.
  book(1, now + 3 * DAY, '4');
  requests = [];
  failure = null;
  failWrite = null;
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    const method = String(url).split('/').at(-1);
    const body = JSON.parse(init.body);
    requests.push({ method, ...body });
    const result = failure?.(method) || { ok: true, result: { message_id: requests.length + 100 } };
    return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
  }));
});
afterEach(() => { db.close(); vi.unstubAllGlobals(); });

function book(id, startsAt, court = '2', chatId = -123) {
  db.prepare(`INSERT INTO bookings
    (id, chat_id, court, starts_at, ends_at, reminder_at, pre_reminder_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, chatId, court, startsAt, startsAt + 3600000, now, now, now);
}

function seat(id, heads = 1, bookingId = 1) {
  db.prepare(`INSERT INTO booking_players
    (booking_id, chat_id, user_id, slug, name, heads, created_at)
    VALUES (?, -123, ?, ?, 'Player', ?, ?)`)
    .run(bookingId, id, `u${id}`, heads, now);
}

const sends = () => requests.filter(r => r.method === 'sendMessage');
const joinTarget = r => r.reply_markup.inline_keyboard[0][0].callback_data;
const notice = () => db.prepare('SELECT * FROM availability_notices WHERE chat_id = -123').get();

it('redraws the message when only its keyboard has changed', async () => {
  seat(1);
  await syncAnnouncements(env, -123, now);
  // A deploy that changes the buttons alone: the stored rendering carries the
  // keyboard, so a message with unchanged text is still brought up to date.
  db.prepare("UPDATE availability_notices SET html = 'stale' WHERE chat_id = -123").run();
  expect(await syncAnnouncements(env, -123, now)).toBe(0);
  expect(requests.at(-1)).toMatchObject({ method: 'editMessageText', message_id: 101 });
  expect(requests.at(-1).reply_markup.inline_keyboard[1][0].callback_data).toBe('sb:addp:1');
  // Text and keyboard both unchanged: nothing is sent.
  const before = requests.length;
  await syncAnnouncements(env, -123, now);
  expect(requests.length).toBe(before);
});

it('sends admins straight to the court in the Mini App once one is registered', async () => {
  seat(1);
  env.MINI_APP_URL = 'https://t.me/squash_book_bot/manage';
  await syncAnnouncements(env, -123, now);
  const [join, admin] = requests[0].reply_markup.inline_keyboard;
  // Join stays a one-tap callback: it needs no screen at all.
  expect(join).toEqual([{ text: '🙋 Join', callback_data: 'sb:join:1' }]);
  expect(admin).toHaveLength(1);
  const link = new URL(admin[0].url);
  expect(link.searchParams.get('startapp')).toBe('g-123_b1');
  expect(link.searchParams.get('mode')).toBe('compact');
});

it('posts one silent message for the next open court, edits its slot count, and moves on when it fills', async () => {
  seat(1);
  expect(await syncAnnouncements(env, -123, now)).toBe(0);
  expect(requests[0]).toMatchObject({ method: 'sendMessage', disable_notification: true,
    reply_markup: { inline_keyboard: [
      [{ text: '🙋 Join', callback_data: 'sb:join:1' }],
      // Admin shortcuts to the seat and remove pickers; members are refused.
      [
        { text: '➕ Admin: add', callback_data: 'sb:addp:1' },
        { text: '➖ Admin: remove', callback_data: 'sb:kick:1' },
      ],
    ] } });
  expect(requests[0].ephemeral_message_parameters?.receiver_user_id).toBeUndefined();
  // An invitation: the free slots lead, then when, then who is on it already,
  // tagged where the id is known.
  expect(requests[0].text).toMatch(new RegExp('^🙋 <b>2 slots left on Court 4</b>\\n'
    + 'In 3 days · Sun 13 Sept? · 8am\\n'
    + 'Playing: <a href="tg://user\\?id=1">Player</a>$'));
  await syncAnnouncements(env, -123, now);
  expect(requests).toHaveLength(1);
  seat(2);
  await syncAnnouncements(env, -123, now);
  expect(requests[1]).toMatchObject({ method: 'editMessageText', message_id: 101 });
  expect(requests[1].text).toContain('<b>1 slot left on Court 4</b>');
  expect(requests[1].text).toContain('Player</a>, <a href="tg://user?id=2">Player</a>');
  seat(3);
  await syncAnnouncements(env, -123, now);
  expect(requests[2]).toMatchObject({ method: 'deleteMessage', message_id: 101 });
  expect(requests[2]).toBeDefined();
  expect(requests).toHaveLength(3);
  expect(notice()).toMatchObject({ booking_id: null, message_id: null });
  db.exec('DELETE FROM booking_players WHERE user_id = 3');
  await syncAnnouncements(env, -123, now);
  expect(requests[3]).toMatchObject({ method: 'sendMessage', disable_notification: true });
});

it('replaces the message when a nearer court is booked, so the latest message is the most upcoming court', async () => {
  await syncAnnouncements(env, -123, now);
  expect(joinTarget(requests[0])).toBe('sb:join:1');
  book(2, now + DAY);
  await syncAnnouncements(env, -123, now);
  expect(requests.slice(1).map(r => r.method)).toEqual(['deleteMessage', 'sendMessage']);
  expect(requests[1].message_id).toBe(101);
  expect(joinTarget(requests[2])).toBe('sb:join:2');
  expect(requests[2].text).toContain('Tomorrow');
  expect(notice()).toMatchObject({ booking_id: 2, message_id: 103 });
});

it('keeps a further-out booking quiet: one message per group, not one per court', async () => {
  book(2, now + 5 * DAY);
  book(3, now + 7 * DAY);
  book(4, now + 9 * DAY);
  await syncAnnouncements(env, -123, now);
  await syncAnnouncements(env, -123, now);
  expect(sends()).toHaveLength(1);
  expect(joinTarget(sends()[0])).toBe('sb:join:1');
});

it('skips full and started courts and stays inside its own group', async () => {
  seat(1, 3);
  book(2, now + 4 * DAY);
  book(3, now + 6 * DAY);
  book(4, now - 1);
  book(5, now + 1, '2', -456);
  await syncAnnouncements(env, -123, now);
  expect(sends()).toHaveLength(1);
  expect(joinTarget(requests[0])).toBe('sb:join:2');
});

it.each(['cancelled', 'started'])('removes the message for a %s court and points at the next one', async (state) => {
  book(2, now + 5 * DAY);
  await syncAnnouncements(env, -123, now);
  expect(joinTarget(requests[0])).toBe('sb:join:1');
  if (state === 'cancelled') db.exec('DELETE FROM bookings WHERE id = 1');
  await syncAnnouncements(env, -123, state === 'started' ? now + 3 * DAY : now);
  expect(requests.slice(1).map(r => r.method)).toEqual(['deleteMessage', 'sendMessage']);
  expect(joinTarget(requests[2])).toBe('sb:join:2');
});

it('deletes the message and sends nothing when no court is open', async () => {
  await syncAnnouncements(env, -123, now);
  db.exec('DELETE FROM bookings WHERE id = 1');
  await syncAnnouncements(env, -123, now);
  expect(requests.at(-1)).toMatchObject({ method: 'deleteMessage', message_id: 101 });
  expect(requests).toHaveLength(2);
  expect(notice()).toMatchObject({ booking_id: null, message_id: null });
});

it('updates time and court changes in the same message', async () => {
  await syncAnnouncements(env, -123, now);
  db.exec("UPDATE bookings SET court = '2', starts_at = starts_at + 3600000");
  await syncAnnouncements(env, -123, now);
  expect(requests.at(-1)).toMatchObject({ method: 'editMessageText', message_id: 101 });
  expect(requests.at(-1).text).toContain('Court 2');
});

it('replaces the message when the tracked court is moved behind another one', async () => {
  book(2, now + 4 * DAY);
  await syncAnnouncements(env, -123, now);
  db.exec('UPDATE bookings SET starts_at = starts_at + 2 * 86400000, ends_at = ends_at + 2 * 86400000 WHERE id = 1');
  await syncAnnouncements(env, -123, now);
  expect(requests.slice(1).map(r => r.method)).toEqual(['deleteMessage', 'sendMessage']);
  expect(joinTarget(requests[2])).toBe('sb:join:2');
});

it('retries transient edit/delete failures without sending duplicate messages', async () => {
  await syncAnnouncements(env, -123, now);
  seat(1);
  failure = () => ({ ok: false, description: 'Too Many Requests: retry after 5' });
  expect(await syncAnnouncements(env, -123, now)).toBe(1);
  seat(2, 2);
  expect(await syncAnnouncements(env, -123, now)).toBe(1);
  failure = null;
  expect(await syncAnnouncements(env, -123, now)).toBe(0);
  expect(sends()).toHaveLength(1);
  expect(notice().message_id).toBeNull();
});

const undeletable = method => method === 'deleteMessage'
  ? { ok: false, description: "Bad Request: message can't be deleted" } : null;

it('says no courts are available on an undeletable message, once, instead of naming the last court', async () => {
  await syncAnnouncements(env, -123, now);
  seat(1, 3);
  failure = undeletable;
  expect(await syncAnnouncements(env, -123, now)).toBe(0);
  expect(requests.at(-1)).toMatchObject({
    method: 'editMessageText', message_id: 101, text: NO_COURTS_HTML, reply_markup: { inline_keyboard: [] },
  });
  expect(notice()).toMatchObject({ message_id: 101, booking_id: null, html: NO_COURTS_HTML });
  // The next sweep finds nothing to change and calls Telegram for nothing.
  const count = requests.length;
  expect(await syncAnnouncements(env, -123, now)).toBe(0);
  expect(requests).toHaveLength(count);
});

it('says no courts are available whether the last court was cancelled or played', async () => {
  await syncAnnouncements(env, -123, now);
  failure = undeletable;
  db.prepare('DELETE FROM bookings WHERE id = 1').run();
  await syncAnnouncements(env, -123, now);
  expect(requests.at(-1).text).toBe(NO_COURTS_HTML);
  // A court that started reads the same: nothing is open.
  book(2, now - 60000, '1');
  seat(5, 1, 2);
  await syncAnnouncements(env, -123, now - DAY);
  expect(joinTarget(requests.at(-1))).toBe('sb:join:2');
  await syncAnnouncements(env, -123, now);
  expect(requests.at(-1).text).toBe(NO_COURTS_HTML);
  expect(requests.every(r => !/pinned board|played|cancelled/.test(r.text || ''))).toBe(true);
});

it('rewrites a message closed with the old last-court text', async () => {
  await syncAnnouncements(env, -123, now);
  db.prepare(`UPDATE availability_notices SET booking_id = NULL,
    html = '🎾 <b>Court 4</b> · Sun 13 Sept · 8am · played'`).run();
  db.prepare('DELETE FROM bookings WHERE id = 1').run();
  requests = [];
  expect(await syncAnnouncements(env, -123, now)).toBe(0);
  expect(requests).toEqual([expect.objectContaining({
    method: 'editMessageText', message_id: 101, text: NO_COURTS_HTML,
  })]);
});

it('stops tracking a closed message that has gone from the chat', async () => {
  await syncAnnouncements(env, -123, now);
  failure = method => method === 'deleteMessage' ? undeletable(method)
    : method === 'editMessageText' ? { ok: false, description: 'Bad Request: message to edit not found' } : null;
  db.prepare('DELETE FROM bookings WHERE id = 1').run();
  expect(await syncAnnouncements(env, -123, now)).toBe(0);
  expect(notice()).toMatchObject({ message_id: null, booking_id: null, html: null });
});

it('rewrites an undeletable message in place for the next court instead of leaving a stub', async () => {
  await syncAnnouncements(env, -123, now);
  failure = undeletable;
  // A nearer court is booked: the old message becomes its announcement.
  book(2, now + DAY, '1');
  expect(await syncAnnouncements(env, -123, now)).toBe(0);
  expect(requests.at(-1)).toMatchObject({ method: 'editMessageText', message_id: 101 });
  expect(joinTarget(requests.at(-1))).toBe('sb:join:2');
  expect(notice()).toMatchObject({ message_id: 101, booking_id: 2 });
  // Both courts fill, then one reopens: the closed message is reused too.
  seat(1, 3, 1); seat(2, 3, 2);
  await syncAnnouncements(env, -123, now);
  expect(requests.at(-1).text).toBe(NO_COURTS_HTML);
  db.prepare('DELETE FROM booking_players WHERE booking_id = 2').run();
  await syncAnnouncements(env, -123, now);
  expect(requests.at(-1)).toMatchObject({ method: 'editMessageText', message_id: 101 });
  expect(joinTarget(requests.at(-1))).toBe('sb:join:2');
  expect(sends()).toHaveLength(1);
  expect(requests.every(r => !/pinned board/.test(r.text || ''))).toBe(true);
});

it('serializes overlapping refreshes and keeps shared-chat message ids separate', async () => {
  env.DATA_CHAT_ID = '-123'; env.ALLOWED_CHATS = '-123,-456';
  await Promise.all([syncAnnouncements(env, -123, now), syncAnnouncements(env, -123, now)]);
  await syncAnnouncements(env, -456, now);
  expect(sends().map(r => r.chat_id)).toEqual([-123, -456]);
  seat(1, 3);
  await syncAnnouncements(env, -456, now);
  expect(requests.at(-1)).toMatchObject({ method: 'deleteMessage', chat_id: -456, message_id: 102 });
});

it('reconciles through a real booking and board refresh', async () => {
  // addBooking and updateBoard read the wall clock, so the fixture moves with it.
  const today = Date.now();
  db.prepare('UPDATE bookings SET starts_at = ?, ends_at = ? WHERE id = 1')
    .run(today + 3 * DAY, today + 3 * DAY + 3600000);
  await syncAnnouncements(env, -123, today);
  expect(joinTarget(requests[0])).toBe('sb:join:1');
  const startsAt = today + DAY;
  const id = await addBooking(env, -123, {
    court: '2', startsAt, endsAt: startsAt + 3600000, reminderAt: startsAt - 7200000,
  }, { id: 9, first_name: 'Booker' });
  const posted = sends().filter(r => r.text.includes('left on Court'));
  expect(posted).toHaveLength(2);
  expect(joinTarget(posted[1])).toBe(`sb:join:${id}`);
  expect(posted[1]).toMatchObject({ disable_notification: true });
  expect(notice().booking_id).toBe(id);
  db.prepare('UPDATE bookings SET capacity = 1 WHERE id = ?').run(id);
  await updateBoard(env, -123);
  expect(notice().booking_id).toBe(1);
  expect(requests.at(-1).text).toContain('In 3 days');
});

it('moves on to the next court through end-of-booking maintenance without reposting', async () => {
  book(90, now - 3600000, '1');
  // A board already pinned, so it is edited in place rather than posted below.
  // The daily redraw reads the clock, so the clock is the test's own.
  db.prepare('INSERT INTO settings (chat_id, board_message_id) VALUES (-123, 50)').run();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now);
  onTestFinished(() => vi.useRealTimers());
  // Reminders for booking 1 fall due in the same sweep; only notices count here.
  const notices = () => sends().filter(r => r.text?.includes('left on Court'));
  expect((await runMaintenance(env, now)).ok).toBe(true);
  expect(db.prepare('SELECT * FROM bookings WHERE id = 90').get()).toBeUndefined();
  expect(notices()).toHaveLength(1);
  expect(joinTarget(notices()[0])).toBe('sb:join:1');
  await runMaintenance(env, now);
  expect(notices()).toHaveLength(1);
});

it('removes a sent message if its tracking write fails, so retry cannot leave a duplicate', async () => {
  failWrite = sql => sql.includes('SET booking_id = ?, message_id = ?, html = ?');
  expect(await syncAnnouncements(env, -123, now)).toBe(1);
  expect(requests.map(r => r.method)).toEqual(['sendMessage', 'deleteMessage']);
  expect(notice().message_id).toBeNull();
  failWrite = null;
  expect(await syncAnnouncements(env, -123, now)).toBe(0);
  expect(requests.at(-1).method).toBe('sendMessage');
});

it('hands messages tracked by the old tables to the cleanup sweep when migrating', async () => {
  const legacy = new DatabaseSync(':memory:');
  legacy.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  legacy.exec(readFileSync(new URL('../migrations/010-booking-announcements.sql', import.meta.url), 'utf8'));
  legacy.exec(readFileSync(new URL('../migrations/011-booking-followups.sql', import.meta.url), 'utf8'));
  legacy.exec(`INSERT INTO booking_announcements (booking_id, chat_id, data_chat_id, message_id)
    VALUES (1, -123, -123, 501), (2, -123, -123, NULL), (3, -456, -123, 502)`);
  legacy.exec(readFileSync(new URL('../migrations/014-availability-notices.sql', import.meta.url), 'utf8'));
  expect(legacy.prepare('SELECT chat_id, message_id, delete_after FROM sent_messages ORDER BY message_id').all())
    .toEqual([{ chat_id: -123, message_id: 501, delete_after: 0 }, { chat_id: -456, message_id: 502, delete_after: 0 }]);
  expect(legacy.prepare("SELECT name FROM sqlite_master WHERE name IN ('booking_announcements', 'booking_followups')").all())
    .toHaveLength(0);
  legacy.close();
});

it('posts the board above the announcement when both are new', async () => {
  seat(1);
  await updateBoard(env, -123, now);
  const posted = sends().map(r => r.text.includes('left on Court') ? 'notice' : 'board');
  expect(posted).toEqual(['board', 'notice']);
});

it('moves an announcement buried under a freshly posted board back to the bottom', async () => {
  seat(1);
  await syncAnnouncements(env, -123, now);
  expect(notice().message_id).toBe(101);
  // A tab posted afresh after the announcement now sits below it.
  db.prepare('INSERT INTO settings (chat_id, tab_message_id) VALUES (-123, 102)').run();
  requests.push({ method: 'sendMessage', text: 'tab' });
  const before = requests.length;
  expect(await syncAnnouncements(env, -123, now)).toBe(0);
  expect(requests.slice(before).map(r => r.method)).toEqual(['deleteMessage', 'sendMessage']);
  expect(requests[before]).toMatchObject({ message_id: 101 });
  expect(notice().message_id).toBeGreaterThan(102);
  // Below everything pinned again: nothing more to do.
  const settled = requests.length;
  await syncAnnouncements(env, -123, now);
  expect(requests.length).toBe(settled);
});

const pinnedRow = () => db.prepare(
  'SELECT board_message_id, tab_message_id FROM settings WHERE chat_id = -123'
).get();

it('swaps jobs with the board when a buried announcement cannot be deleted', async () => {
  seat(1);
  await syncAnnouncements(env, -123, now);
  // The live shape: tab oldest, then the stuck announcement, then a newer board.
  db.prepare(`INSERT INTO settings (chat_id, board_message_id, tab_message_id)
    VALUES (-123, 150, 17)`).run();
  failure = undeletable;
  requests = [];
  await updateBoard(env, -123, now);
  // The board's edit of 150 comes first, then the swap.
  const swap = requests.slice(1);
  expect(swap.map(r => [r.method, r.message_id])).toEqual([
    ['deleteMessage', 101],
    ['pinChatMessage', 101],
    ['unpinChatMessage', 150],
    ['editMessageText', 101],
    ['editMessageText', 150],
  ]);
  expect(swap[3].text).toContain('Court schedule');
  expect(swap[4].text).toContain('left on Court');
  expect(pinnedRow()).toEqual({ board_message_id: 101, tab_message_id: 17 });
  expect(notice().message_id).toBe(150);
  expect(notice().booking_id).toBe(1);
  expect(db.prepare('SELECT count(*) AS n FROM pending_refreshes').get().n).toBe(0);
  // In order now: the next sync has nothing to do.
  requests = [];
  await syncAnnouncements(env, -123, now);
  expect(requests).toEqual([]);
});

it('queues a redraw when maintenance swaps a message it did not draw', async () => {
  seat(1);
  await syncAnnouncements(env, -123, now);
  db.prepare('INSERT INTO settings (chat_id, board_message_id, tab_message_id) VALUES (-123, 120, 150)').run();
  failure = undeletable;
  expect(await syncAnnouncements(env, -123, now)).toBe(0);
  // The newest pinned message is the one traded, whichever it is.
  expect(pinnedRow()).toEqual({ board_message_id: 120, tab_message_id: 101 });
  expect(notice().message_id).toBe(150);
  expect(db.prepare('SELECT board, tab FROM pending_refreshes WHERE chat_id = -123').get())
    .toEqual({ board: 0, tab: 1 });
});

it('leaves everything in place when the swap cannot pin', async () => {
  seat(1);
  await syncAnnouncements(env, -123, now);
  db.prepare('INSERT INTO settings (chat_id, board_message_id) VALUES (-123, 150)').run();
  failure = method => undeletable(method)
    || (method === 'pinChatMessage' ? { ok: false, description: 'Bad Request: not enough rights' } : null);
  requests = [];
  expect(await syncAnnouncements(env, -123, now)).toBe(0);
  expect(requests.map(r => r.method)).toEqual(['deleteMessage', 'pinChatMessage']);
  expect(notice().message_id).toBe(101);
  expect(pinnedRow().board_message_id).toBe(150);
});

it('takes the pin back when the swap cannot be saved', async () => {
  seat(1);
  await syncAnnouncements(env, -123, now);
  db.prepare('INSERT INTO settings (chat_id, board_message_id) VALUES (-123, 150)').run();
  failure = undeletable;
  failWrite = sql => sql.startsWith('UPDATE settings');
  requests = [];
  expect(await syncAnnouncements(env, -123, now)).toBe(1);
  expect(requests.map(r => [r.method, r.message_id])).toEqual([
    ['deleteMessage', 101], ['pinChatMessage', 101], ['unpinChatMessage', 150],
    ['pinChatMessage', 150], ['unpinChatMessage', 101],
  ]);
  expect(notice().message_id).toBe(101);
  expect(pinnedRow().board_message_id).toBe(150);
});

it('moves nothing when the old pin cannot be taken off, so maintenance retries', async () => {
  seat(1);
  await syncAnnouncements(env, -123, now);
  db.prepare('INSERT INTO settings (chat_id, board_message_id) VALUES (-123, 150)').run();
  failure = method => undeletable(method)
    || (method === 'unpinChatMessage' ? { ok: false, error_code: 500, description: 'Internal Server Error' } : null);
  requests = [];
  expect(await syncAnnouncements(env, -123, now)).toBe(1);
  expect(requests.map(r => [r.method, r.message_id])).toEqual([
    ['deleteMessage', 101], ['pinChatMessage', 101], ['unpinChatMessage', 150], ['unpinChatMessage', 101],
  ]);
  expect(notice().message_id).toBe(101);
  expect(pinnedRow().board_message_id).toBe(150);
});

it('finishes the swap when the save landed but its answer was lost', async () => {
  seat(1);
  await syncAnnouncements(env, -123, now);
  db.prepare('INSERT INTO settings (chat_id, board_message_id) VALUES (-123, 150)').run();
  failure = undeletable;
  const batch = env.DB.batch;
  env.DB.batch = async (statements) => {
    await batch(statements);
    env.DB.batch = batch;
    throw new Error('D1 connection lost');
  };
  requests = [];
  expect(await syncAnnouncements(env, -123, now)).toBe(0);
  expect(requests.filter(r => r.method === 'pinChatMessage').map(r => r.message_id)).toEqual([101]);
  expect(requests.filter(r => r.method === 'unpinChatMessage').map(r => r.message_id)).toEqual([150]);
  expect(pinnedRow().board_message_id).toBe(101);
  expect(notice().message_id).toBe(150);
});

it('posts afresh instead of failing forever on a message it can no longer edit', async () => {
  seat(1);
  await syncAnnouncements(env, -123, now);
  db.prepare("UPDATE availability_notices SET html = 'stale' WHERE chat_id = -123").run();
  failure = method => (method === 'editMessageText'
    ? { ok: false, description: "Bad Request: message can't be edited" } : null);
  requests = [];
  expect(await syncAnnouncements(env, -123, now)).toBe(0);
  expect(requests.map(r => r.method)).toEqual(['editMessageText', 'sendMessage']);
  expect(notice().message_id).not.toBe(101);
});

it('forgets a kept message it can neither delete nor edit once no court is open', async () => {
  seat(1);
  await syncAnnouncements(env, -123, now);
  db.prepare('DELETE FROM bookings').run();
  failure = method => undeletable(method) || (method === 'editMessageText'
    ? { ok: false, description: "Bad Request: message can't be edited" } : null);
  expect(await syncAnnouncements(env, -123, now)).toBe(0);
  expect(notice().message_id).toBe(null);
});

it('repairs the announcement when a redraw from before a swap lands on it', async () => {
  seat(1);
  await syncAnnouncements(env, -123, now);
  requests = [];
  // The caller read 101 as its board, and has just drawn the board there.
  expect(await syncAnnouncements(env, -123, now, {
    pinned: { board_message_id: 101, tab_message_id: null },
  })).toBe(0);
  expect(requests.map(r => [r.method, r.message_id])).toEqual([['editMessageText', 101]]);
  expect(requests[0].text).toContain('left on Court');
  expect(db.prepare('SELECT board, tab FROM pending_refreshes WHERE chat_id = -123').get())
    .toEqual({ board: 1, tab: 0 });
});

it('takes down a typed-field prompt that came back public', async () => {
  db.prepare(`INSERT INTO booking_drafts (id, chat_id, user_id, user_name, payload, wizard_message_id,
    wizard_ephemeral, created_at) VALUES (9, -123, 7, 'Player', '{}', 55, 1, ?)`).run(now);
  requests = [];
  await handleBookingCallback(env, {
    id: 'tap', data: 'bw:9:u:d', from: { id: 7 }, message: { chat: { id: -123 }, message_id: 55 },
  });
  const prompt = requests.find(r => r.method === 'sendMessage');
  expect(prompt.ephemeral_message_parameters).toEqual({ receiver_user_id: 7, callback_query_id: 'tap' });
  expect(requests.some(r => r.method === 'deleteMessage')).toBe(true);
  expect(requests.find(r => r.method === 'answerCallbackQuery').text).toBe('Could not open the input box.');
  expect(db.prepare('SELECT pending_field, reply_prompt_message_id AS id FROM booking_drafts WHERE id = 9').get())
    .toEqual({ pending_field: null, id: null });
});

describe('command notes', () => {
  let nextEphemeral;
  const say = (text, ephemeral = false) => handleUpdate(env, { message: {
    message_id: ephemeral ? 0 : 500,
    ...(ephemeral ? { ephemeral_message_id: 44 } : {}),
    chat: { id: -123, type: 'supergroup' },
    from: { id: 7, first_name: 'Player', username: 'player' },
    text,
  } });
  const notes = () => db.prepare(
    'SELECT message_id, is_ephemeral, receiver_user_id, delete_after - created_at AS life FROM sent_messages ORDER BY id'
  ).all();
  beforeEach(() => {
    nextEphemeral = 900;
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      const method = String(url).split('/').at(-1);
      const body = JSON.parse(init.body);
      requests.push({ method, ...body });
      const result = method === 'getChatMember' ? { status: 'member' }
        : method === 'sendMessage' && body.ephemeral_message_parameters
          ? { message_id: 0, ephemeral_message_id: nextEphemeral++ }
          : { message_id: requests.length + 100 };
      return new Response(JSON.stringify({ ok: true, result }), { headers: { 'Content-Type': 'application/json' } });
    });
  });

  it.each(['/courts', '/tab', '/help', '/nonsense', '/cancel'])('%s clears itself a day later', async (command) => {
    await say(command, true);
    expect(notes()).toEqual([{ message_id: 900, is_ephemeral: 1, receiver_user_id: 7, life: DAY }]);
  });

  it('clears a failed /cancel, which is no record of anything', async () => {
    await say('/cancel 99', true);
    expect(requests.find(r => r.method === 'sendMessage').text).toContain("couldn't find");
    expect(notes()).toEqual([{ message_id: 900, is_ephemeral: 1, receiver_user_id: 7, life: DAY }]);
  });

  it('keeps a /cancel that removed a court, which is a receipt', async () => {
    await admin();
    // A court already played cannot be cancelled, so this one is still to come.
    db.prepare('UPDATE bookings SET starts_at = ?, ends_at = ? WHERE id = 1')
      .run(Date.now() + DAY, Date.now() + DAY + 3600000);
    await say('/cancel 1', true);
    expect(requests.find(r => r.method === 'sendMessage' && /Removed booking/.test(r.text))).toBeTruthy();
    expect(notes()).toEqual([]);
  });

  it('takes a note Telegram delivered publicly straight back out of the group', async () => {
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      const method = String(url).split('/').at(-1);
      requests.push({ method, ...JSON.parse(init.body) });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 321 } }),
        { headers: { 'Content-Type': 'application/json' } });
    });
    await say('/nonsense', true);
    expect(requests.find(r => r.method === 'deleteMessage').message_id).toBe(321);
    expect(notes()).toEqual([]);
  });

  it('never expires the only copy of a booking that failed', async () => {
    failWrite = sql => /INSERT INTO booking_drafts/.test(sql);
    await admin();
    await handleUpdate(env, { message: {
      message_id: 500,
      chat: { id: -123, type: 'supergroup' },
      from: { id: 7, first_name: 'Player', username: 'player' },
      text: 'court 4 tomorrow 7pm',
    } });
    const handedBack = requests.find(r => r.method === 'sendMessage' && r.text.includes('court 4 tomorrow 7pm'));
    expect(handedBack).toBeTruthy();
    expect(notes()).toEqual([]);
  });

  const tapInNote = (data, ephemeralId) => handleUpdate(env, { callback_query: {
    id: 'tap',
    data,
    from: { id: 7, first_name: 'Player', username: 'player' },
    message: { message_id: 0, ephemeral_message_id: ephemeralId, chat: { id: -123, type: 'supergroup' }, text: 'note' },
  } });
  const seatDebtor = () => db.prepare(`INSERT INTO booking_players
    (booking_id, chat_id, user_id, slug, name, heads, created_at)
    VALUES (1, -123, 8, 'u8', 'Jared', 1, ?)`).run(now);
  const buttonData = (pattern) => requests.filter(r => r.method === 'sendMessage')
    .flatMap(r => r.reply_markup?.inline_keyboard.flat() || [])
    .map(b => b.callback_data).find(d => pattern.test(d || ''));

  it('keeps the receipt that an abandoned-preview sweep would have taken', async () => {
    await admin();
    seatDebtor();
    await say('/debt +2 jared ice cream', true);
    expect(notes()).toEqual([{ message_id: 900, is_ephemeral: 1, receiver_user_id: 7, life: DAY }]);
    await tapInNote(buttonData(/^tb:debt:/), 900);
    expect(notes().filter(n => n.message_id === 900)).toEqual([]);
  });

  it('keeps the receipt when the /debt undo list becomes one', async () => {
    await admin();
    seatDebtor();
    await say('/debt +2 jared ice cream', true);
    await tapInNote(buttonData(/^tb:debt:/), 900);
    db.prepare('DELETE FROM sent_messages').run();
    requests.length = 0;
    nextEphemeral = 950;
    await say('/debt undo', true);
    expect(notes().map(n => n.message_id)).toEqual([950]);
    await tapInNote(buttonData(/^tb:undo:/), 950);
    expect(notes().filter(n => n.message_id === 950)).toEqual([]);
  });

  it('takes a dismissed note off the sweep, but not one whose delete failed', async () => {
    await say('/nonsense', true);
    expect(notes()).toHaveLength(1);
    const real = vi.mocked(fetch).getMockImplementation();
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      if (String(url).endsWith('/deleteEphemeralMessage')) {
        return new Response(JSON.stringify({ ok: false, error_code: 500, description: 'Internal Server Error' }),
          { headers: { 'Content-Type': 'application/json' } });
      }
      return real(url, init);
    });
    await tapInNote('sb:ok', 900);
    expect(notes()).toHaveLength(1);
    vi.mocked(fetch).mockImplementation(real);
    await tapInNote('sb:ok', 900);
    expect(notes()).toEqual([]);
  });

  // The default mock answers getChatMember as a plain member, and the role is
  // remembered across tests unless the cache is cleared on both sides.
  async function admin() {
    clearAdminCache();
    onTestFinished(() => clearAdminCache());
    const real = vi.mocked(fetch).getMockImplementation();
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      if (String(url).endsWith('/getChatMember')) {
        return new Response(JSON.stringify({ ok: true, result: { status: 'administrator' } }),
          { headers: { 'Content-Type': 'application/json' } });
      }
      return real(url, init);
    });
  }
});

it('puts a private note on the sweep when its public copy will not delete yet', async () => {
  failure = method => (method === 'deleteMessage'
    ? { ok: false, error_code: 500, description: 'Internal Server Error' } : null);
  expect(await sendPrivateNote(env, -123, 7, 'Your balance')).toBe('failed');
  expect(db.prepare('SELECT is_ephemeral, receiver_user_id FROM sent_messages').all())
    .toEqual([{ is_ephemeral: 0, receiver_user_id: null }]);
  db.prepare('DELETE FROM sent_messages').run();
  failure = method => (method === 'deleteMessage'
    ? { ok: false, description: 'Bad Request: message to delete not found' } : null);
  await sendPrivateNote(env, -123, 7, 'Your balance');
  expect(db.prepare('SELECT count(*) AS n FROM sent_messages').get().n).toBe(0);
});

it('clears a court reminder when the court ends, and retries a public copy it could not delete', async () => {
  const startsAt = now + 3600000;
  db.prepare('DELETE FROM bookings').run();
  book(2, startsAt);
  db.prepare(`INSERT INTO booking_players
    (booking_id, chat_id, user_id, slug, name, heads, created_at)
    VALUES (2, -123, 7, 'u7', 'Player', 1, ?)`).run(now - 1);
  vi.mocked(fetch).mockImplementation(async (url, init) => {
    const method = String(url).split('/').at(-1);
    const body = JSON.parse(init.body);
    requests.push({ method, ...body });
    const result = method === 'sendMessage' && body.ephemeral_message_parameters?.receiver_user_id
      ? { ok: true, result: { ephemeral_message_id: 900 } }
      : { ok: true, result: { message_id: requests.length + 100 } };
    return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
  });
  await runMaintenance(env, now);
  const row = db.prepare('SELECT * FROM sent_messages WHERE message_id = 900').get();
  expect(row.delete_after).toBe(startsAt + 3600000);

  db.prepare('DELETE FROM sent_messages').run();
  db.prepare('UPDATE booking_players SET reminder_sent = 0, pre_reminder_sent = 0').run();
  vi.mocked(fetch).mockImplementation(async (url, init) => {
    const method = String(url).split('/').at(-1);
    requests.push({ method, ...JSON.parse(init.body) });
    const result = method === 'deleteMessage'
      ? { ok: false, error_code: 500, description: 'Internal Server Error' }
      : { ok: true, result: { message_id: 777 } };
    return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
  });
  await runMaintenance(env, now);
  // The private send fell back to a public copy (777) that would not delete.
  expect(db.prepare('SELECT count(*) AS n FROM sent_messages WHERE message_id = 777 AND is_ephemeral = 0')
    .get().n).toBeGreaterThan(0);
});

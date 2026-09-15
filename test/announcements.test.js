import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { syncAnnouncements } from '../src/announcements.js';
import { addBooking, runMaintenance, updateBoard } from '../src/bookings.js';

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

it('posts one silent message for the next open court, edits its slot count, and moves on when it fills', async () => {
  seat(1);
  expect(await syncAnnouncements(env, -123, now)).toBe(0);
  expect(requests[0]).toMatchObject({ method: 'sendMessage', disable_notification: true,
    reply_markup: { inline_keyboard: [[{ text: '🙋 Join', callback_data: 'sb:join:1' }]] } });
  expect(requests[0].receiver_user_id).toBeUndefined();
  expect(requests[0].text).toContain('Next available court');
  expect(requests[0].text).toContain('in 3 days');
  expect(requests[0].text).toContain('2 slots · 1/3');
  await syncAnnouncements(env, -123, now);
  expect(requests).toHaveLength(1);
  seat(2);
  await syncAnnouncements(env, -123, now);
  expect(requests[1]).toMatchObject({ method: 'editMessageText', message_id: 101 });
  expect(requests[1].text).toContain('1 slot · 2/3');
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
  expect(requests[2].text).toContain('tomorrow');
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

it('retires an undeletable old message by removing its Join button', async () => {
  await syncAnnouncements(env, -123, now);
  seat(1, 3);
  failure = method => method === 'deleteMessage'
    ? { ok: false, description: "Bad Request: message can't be deleted" } : null;
  expect(await syncAnnouncements(env, -123, now)).toBe(0);
  expect(requests.at(-1)).toMatchObject({ method: 'editMessageText', reply_markup: { inline_keyboard: [] } });
  expect(requests.at(-1).text).toContain('no longer open');
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
  const posted = sends().filter(r => r.text.includes('Next available court'));
  expect(posted).toHaveLength(2);
  expect(joinTarget(posted[1])).toBe(`sb:join:${id}`);
  expect(posted[1]).toMatchObject({ disable_notification: true });
  expect(notice().booking_id).toBe(id);
  db.prepare('UPDATE bookings SET capacity = 1 WHERE id = ?').run(id);
  await updateBoard(env, -123);
  expect(notice().booking_id).toBe(1);
  expect(requests.at(-1).text).toContain('in 3 days');
});

it('moves on to the next court through end-of-booking maintenance without reposting', async () => {
  book(90, now - 3600000, '1');
  // Reminders for booking 1 fall due in the same sweep; only notices count here.
  const notices = () => sends().filter(r => r.text?.includes('Next available court'));
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

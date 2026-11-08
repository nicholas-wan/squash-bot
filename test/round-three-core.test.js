import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import worker, { handleUpdate } from '../src/index.js';
import { addBooking, notifyRemovedPlayer, runMaintenance } from '../src/bookings.js';
import { clearAdminCache } from '../src/players.js';
import { bookingIntent } from '../src/wizard.js';
import { countingDb, d1, schemaDb } from './d1.js';

const HOUR = 3600000;
const now = Date.UTC(2026, 8, 10); // Thu 10 Sep 2026, 8am SGT
const ADMIN = 1;
const BOOKER = { id: 5, first_name: 'Bob', username: 'bob' };
const MEMBER = { id: 6, first_name: 'Mel', username: 'mel' };

let sql, env, requests;
const json = (body) => new Response(JSON.stringify(body), {
  headers: { 'Content-Type': 'application/json' },
});

// Private sends come back ephemeral and group sends public, unless a test
// says otherwise; every admin check answers for ADMIN alone.
function stubTelegram(reply = () => null) {
  requests = [];
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    const method = String(url).split('/').at(-1);
    const body = JSON.parse(init.body);
    requests.push({ method, body });
    const custom = reply(method, body);
    if (custom) return json(custom);
    if (method === 'getChatMember') {
      return json({ ok: true, result: { status: body.user_id === ADMIN ? 'administrator' : 'member' } });
    }
    if (method === 'sendMessage') {
      const id = 500 + requests.length;
      return json({ ok: true, result: body.receiver_user_id ? { ephemeral_message_id: id } : { message_id: id } });
    }
    return json({ ok: true, result: true });
  }));
}

beforeEach(() => {
  vi.useFakeTimers({ now, toFake: ['Date'] });
  clearAdminCache();
  sql = schemaDb();
  env = { BOT_TOKEN: '42:test', ALLOWED_CHATS: '-123', DB: d1(sql) };
  stubTelegram();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  sql.close();
});

function book(id, startsAt, { chatId = -123, endsAt = startsAt + HOUR, createdBy = null } = {}) {
  sql.prepare(`INSERT INTO bookings
    (id, chat_id, court, starts_at, ends_at, reminder_at, reminder_sent, pre_reminder_at,
     pre_reminder_sent, created_by_user_id, created_by_name, created_at)
    VALUES (?, ?, '4', ?, ?, ?, 1, ?, 1, ?, ?, ?)`)
    .run(id, chatId, startsAt, endsAt, startsAt - 3 * HOUR, startsAt - 2 * HOUR,
      createdBy, createdBy ? '@bob' : null, now - 24 * HOUR);
}

function seat(bookingId, userId, chatId = -123) {
  sql.prepare(`INSERT INTO booking_players (booking_id, chat_id, user_id, slug, name, created_at)
    VALUES (?, ?, ?, ?, 'Player', ?)`).run(bookingId, chatId, userId, `u${userId}`, now - 24 * HOUR);
}

function message(text, from = { id: ADMIN, first_name: 'Nick' }) {
  return { message: { message_id: 10, chat: { id: -123, type: 'supergroup' }, from, text, date: 1 } };
}

function tap(data, from, messageFields = { message_id: 0, ephemeral_message_id: 77 }) {
  return { callback_query: {
    id: `cb-${data}`, from, data, message: { chat: { id: -123, type: 'supergroup' }, ...messageFields },
  } };
}

const sent = (method) => requests.filter((request) => request.method === method);

it('reads booking intent from the same text the form does, so an admin\'s chat is never deleted for nothing', async () => {
  for (const text of ['+1 for squash', 'squash @wei2', '+1 court']) {
    expect(bookingIntent(text, { text })).toBe(false);
    await handleUpdate(env, message(text));
  }
  expect(sent('deleteMessage')).toHaveLength(0);
  expect(bookingIntent('tmr c4 2100', { text: 'tmr c4 2100' })).toBe(true);
});

it('redraws the board when a court starts, so it stops offering its slots', async () => {
  const start = now + 10 * HOUR;
  book(1, start);
  seat(1, 5);
  sql.prepare("INSERT INTO settings (chat_id, board_message_id, board_day) VALUES (-123, 50, '2026-9-10')").run();
  vi.setSystemTime(start + 60000);
  await runMaintenance(env, start + 60000);
  const board = sent('editMessageText').filter((request) => request.body.message_id === 50);
  expect(board).toHaveLength(1);
  expect(board[0].body.text).toContain('playing now');
});

it('only ever gives the board\'s buttons to the pinned board', async () => {
  book(1, now + 10 * HOUR);
  sql.prepare('INSERT INTO settings (chat_id, board_message_id, tab_message_id) VALUES (-123, 50, 60)').run();
  // A hand-sent sb:back aimed at the pinned tab leaves its keyboard alone.
  await handleUpdate(env, tap('sb:back', MEMBER, { message_id: 60 }));
  expect(sent('editMessageReplyMarkup')).toHaveLength(0);
  await handleUpdate(env, tap('sb:back', MEMBER, { message_id: 50 }));
  expect(sent('editMessageReplyMarkup').map((request) => request.body.message_id)).toEqual([50]);
});

it('starts the sender\'s identity writes alongside the redelivery record', async () => {
  const counted = countingDb(sql);
  env = { ...env, DB: counted.DB, WEBHOOK_SECRET: 'secret' };
  const waits = [];
  const response = await worker.fetch(new Request('https://bot.test/webhook', {
    method: 'POST',
    headers: { 'X-Telegram-Bot-Api-Secret-Token': 'secret' },
    body: JSON.stringify({ update_id: 1, ...message('hello', MEMBER) }),
  }), env, { waitUntil: (promise) => waits.push(promise) });
  expect(response.status).toBe(200);
  await Promise.all(waits);
  const waveOf = (needle) => counted.ops.find((op) => [].concat(op.sql).some((text) => text.includes(needle))).wave;
  expect(waveOf('processed_updates')).toBe(waveOf('UPDATE booking_players SET user_id'));
});

it('lets the booker cancel from their receipt, and puts the receipt back on Keep', async () => {
  const startsAt = now + 10 * HOUR;
  const id = await addBooking(env, -123, {
    court: '4', startsAt, endsAt: startsAt + HOUR, reminderAt: startsAt - 3 * HOUR,
  }, BOOKER);
  const receipt = sent('sendMessage').find((request) => request.body.text.includes('Court 4 booked'));
  expect(receipt.body.reply_markup.inline_keyboard[0]).toEqual([
    { text: '👍 OK', callback_data: 'sb:ok' },
    { text: '🗑 Cancel booking', callback_data: `sb:delete:${id}:r` },
  ]);

  requests.length = 0;
  await handleUpdate(env, tap(`sb:delete:${id}:r`, BOOKER));
  const confirm = sent('editEphemeralMessageText')[0].body.reply_markup.inline_keyboard;
  expect(confirm[0][0].callback_data).toBe(`sb:cancel:${id}`);
  // Keep goes back to the receipt, not to Manage, which a member is refused.
  expect(confirm[1][0].callback_data).toBe(`sb:keep:${id}`);

  // The receipt names the roster, so nobody else can have it drawn.
  requests.length = 0;
  await handleUpdate(env, tap(`sb:keep:${id}`, MEMBER));
  expect(sent('editEphemeralMessageText')).toHaveLength(0);
  expect(sent('answerCallbackQuery')[0].body.show_alert).toBe(true);

  requests.length = 0;
  await handleUpdate(env, tap(`sb:keep:${id}`, BOOKER));
  expect(sent('editEphemeralMessageText')[0].body.text).toContain('Court 4 booked');

  requests.length = 0;
  await handleUpdate(env, tap(`sb:cancel:${id}`, BOOKER));
  expect(sent('answerCallbackQuery')[0].body.text).toBe('Booking cancelled');
  expect(sent('editEphemeralMessageText')[0].body.text).toBe('🗑 <b>Booking cancelled.</b>');
  expect(sql.prepare('SELECT COUNT(*) AS n FROM bookings').get().n).toBe(0);
});

it('hands an opened court list to the message sweep a day later', async () => {
  book(1, now + 10 * HOUR);
  sql.prepare('INSERT INTO settings (chat_id, board_message_id) VALUES (-123, 50)').run();
  await handleUpdate(env, tap('sb:join', MEMBER, { message_id: 50 }));
  const row = sql.prepare('SELECT * FROM sent_messages').get();
  expect(row).toMatchObject({ receiver_user_id: MEMBER.id, is_ephemeral: 1, delete_after: now + 24 * HOUR });
});

it('names the board\'s real button, and sends nobody back to a court that has started', async () => {
  const booking = { court: '4', starts_at: now - 1000 };
  await notifyRemovedPlayer(env, -123, { user_id: 5 }, booking);
  expect(sent('sendMessage')[0].body.text).toContain('Ask a group admin if that was a mistake.');

  requests.length = 0;
  env.MINI_APP_URL = 'https://t.me/SquashBot/manage';
  await notifyRemovedPlayer(env, -123, { user_id: 5 }, { ...booking, starts_at: now + HOUR });
  expect(sent('sendMessage')[0].body.text).toContain('Tap 🎾 Courts on the pinned board');

  requests.length = 0;
  await handleUpdate(env, message('/help'));
  const help = sent('sendMessage').find((request) => request.body.text.includes('SquashBot'));
  expect(help.body.text).toContain('tap 🎾 Courts on the pinned board to join or leave');
});

it('keeps the availability message below a freshly posted tab', async () => {
  book(1, now - 2 * HOUR);
  seat(1, 5);
  book(2, now + 10 * HOUR);
  sql.prepare("INSERT INTO settings (chat_id, board_message_id, board_day) VALUES (-123, 50, '2026-9-10')").run();
  await runMaintenance(env, now);
  const { tab_message_id: tab } = sql.prepare('SELECT tab_message_id FROM settings').get();
  const { message_id: notice } = sql.prepare('SELECT message_id FROM availability_notices').get();
  expect(tab).toBeTruthy();
  expect(notice).toBeGreaterThan(tab);
});

it('redraws shared boards once at midnight, not once per group', async () => {
  env = { ...env, ALLOWED_CHATS: '-123,-456', DATA_CHAT_ID: '-999' };
  book(1, now + 10 * HOUR, { chatId: -999 });
  sql.prepare(`INSERT INTO settings (chat_id, board_message_id, board_day)
    VALUES (-123, 50, '2026-9-9'), (-456, 70, '2026-9-9')`).run();
  await runMaintenance(env, now);
  const boards = sent('editMessageText').filter((request) => [50, 70].includes(request.body.message_id));
  expect(boards.map((request) => request.body.message_id).sort()).toEqual([50, 70]);
  expect(sql.prepare('SELECT board_day FROM settings ORDER BY chat_id').all().map((row) => row.board_day))
    .toEqual(['2026-9-10', '2026-9-10']);
});

it('takes down a booking form Telegram posted publicly, and says so', async () => {
  stubTelegram((method, body) => (method === 'sendMessage'
    ? { ok: true, result: { message_id: 900 + requests.length } } : null));
  await handleUpdate(env, message('/book tmr c4 9pm', BOOKER));
  const form = requests.findIndex((request) => request.method === 'sendMessage');
  const formId = 900 + form + 1;
  expect(sent('deleteMessage').map((request) => request.body.message_id)).toContain(formId);
  expect(sql.prepare('SELECT COUNT(*) AS n FROM booking_drafts').get().n).toBe(0);
  expect(sent('sendMessage').at(-1).body.text)
    .toContain('Telegram would not deliver your booking form privately');
});

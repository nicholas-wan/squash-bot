import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  addBooking, BookingConflictError, boardHtml, cancelBooking, runMaintenance,
  showBoardManager, showCancelConfirmation, showDeleteConfirmation, updateBooking,
} from '../src/bookings.js';

const startsAt = Date.UTC(2026, 7, 19, 13, 0);
const endsAt = Date.UTC(2026, 7, 19, 14, 0);
const storedBooking = {
  id: 3, chat_id: -123, court: '4', starts_at: startsAt, ends_at: endsAt,
};

function bookingDb(activeBookings, roster = []) {
  return {
    prepare(sql) {
      return {
        bind() {
          return {
            async first() {
              if (sql.includes('SELECT tz')) return { tz: 'Asia/Singapore' };
              if (sql.includes('board_message_id')) return { board_message_id: 55 };
              if (sql.includes('SELECT * FROM bookings WHERE id')) return storedBooking;
              return null;
            },
            async all() {
              if (sql.includes('FROM booking_players')) return { results: roster };
              if (sql.includes('FROM ledger')) return { results: [] };
              return { results: sql.includes('ends_at >') ? activeBookings : [] };
            },
            async run() {
              if (sql.startsWith('INSERT INTO bookings')) {
                return { meta: { changes: 1, last_row_id: 3 } };
              }
              return { meta: { changes: 1 } };
            },
          };
        },
      };
    },
  };
}

describe('public booking announcements', () => {
  afterEach(() => vi.unstubAllGlobals());

  function captureTelegram() {
    const requests = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ ok: true, result: true }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }));
    return requests;
  }

  it('announces a new booking once, with the roster and a join button', async () => {
    const requests = captureTelegram();
    const roster = [{ id: 1, booking_id: 3, user_id: 7, slug: 'u7', name: 'Nick' }];
    await addBooking({ BOT_TOKEN: 'test', DB: bookingDb([storedBooking], roster) }, -123, {
      court: '4', startsAt, endsAt, reminderAt: startsAt - 3600000,
    }, { id: 7, first_name: 'Nick' });
    const announcements = requests.filter((request) => request.url.endsWith('/sendMessage'));
    expect(announcements).toHaveLength(1);
    expect(announcements[0].body.text).toContain('Court 4 booked');
    expect(announcements[0].body.text)
      .toContain('👥 <a href="tg://user?id=7">Nick</a> · 2 slots');
    expect(announcements[0].body).not.toHaveProperty('receiver_user_id');
    expect(announcements[0].body.reply_markup.inline_keyboard[0][0].callback_data)
      .toBe('sb:join:3');
  });

  it('removes a booking without posting to the group', async () => {
    const requests = captureTelegram();
    await cancelBooking({ BOT_TOKEN: 'test', DB: bookingDb([]) }, -123, 3);
    expect(requests.some((request) => request.url.endsWith('/sendMessage'))).toBe(false);
  });

  it('labels edit buttons with court, date, and time instead of an ID', async () => {
    const requests = captureTelegram();
    await showBoardManager(
      { BOT_TOKEN: 'test', DB: bookingDb([storedBooking]) },
      -123, 7, startsAt - 60000
    );
    const manager = requests.find((request) => request.url.endsWith('/editMessageReplyMarkup'));
    const label = manager.body.reply_markup.inline_keyboard[0][0].text;
    expect(label).toContain('✏️ Court 4');
    expect(label).toContain('19 Aug');
    expect(label).toContain('9:00 pm');
    expect(label).not.toContain('#3');
  });

  it('shows edit actions before an explicit delete confirmation', async () => {
    const requests = captureTelegram();
    const found = await showCancelConfirmation(
      { BOT_TOKEN: 'test', DB: bookingDb([storedBooking]) }, -123, 99, 3
    );
    expect(found).toBe(true);
    const actions = requests.find(
      (request) => request.url.endsWith('/editMessageReplyMarkup')
    );
    const labels = actions.body.reply_markup.inline_keyboard.flat().map((button) => button.text);
    expect(labels).toContain('📅 Change date');
    expect(labels).toContain('🔢 Change court');
    expect(labels).toContain('🕐 Change time');
    expect(labels).toContain('🗑 Delete booking');

    requests.length = 0;
    await showDeleteConfirmation(
      { BOT_TOKEN: 'test', DB: bookingDb([storedBooking]) }, -123, 99, 3
    );
    const confirmation = requests.find(
      (request) => request.url.endsWith('/editMessageReplyMarkup')
    );
    const deleteLabel = confirmation.body.reply_markup.inline_keyboard[0][0].text;
    expect(deleteLabel).toContain('🗑 Confirm delete · Court 4');
    expect(deleteLabel).toContain('19 Aug');
    expect(deleteLabel).toContain('9:00 pm');
  });

  it('renders each pinned booking with its roster and free slots', async () => {
    const roster = [
      { id: 1, booking_id: 3, user_id: 7, slug: 'u7', name: 'Nick' },
      {
        id: 2, booking_id: 3, user_id: null,
        slug: '@dodgerblueee', name: '@Dodgerblueee',
      },
    ];
    const html = await boardHtml(
      { DB: bookingDb([storedBooking], roster) }, -123, Date.UTC(2026, 7, 12, 12, 0)
    );
    expect(html).toContain(
      'in 7 days · Wed 19 Aug · 9pm · <b>Court 4</b>'
    );
    // Tagged where the id is known, plain @handle where it is not yet.
    expect(html).toContain(
      '👥 <a href="tg://user?id=7">Nick</a>, @Dodgerblueee · 1 slot'
    );
    expect(html).not.toContain('$');
    expect(html.split('\n')).toHaveLength(4);
  });

  it('rejects an overlapping court booking in the insert itself', async () => {
    const db = {
      prepare(sql) {
        return { bind() { return {
          async all() {
            return { results: sql.includes('LOWER(TRIM(court))') ? [storedBooking] : [] };
          },
          async run() { return { meta: { changes: 0 } }; },
        }; } };
      },
    };
    await expect(addBooking({ DB: db }, -123, {
      court: '4', startsAt, endsAt, reminderAt: startsAt - 3600000,
    }, { id: 7, first_name: 'Nick' })).rejects.toBeInstanceOf(BookingConflictError);
  });

  it('records an immutable audit row and keeps an edit off the group feed', async () => {
    const requests = captureTelegram();
    const sqlSeen = [];
    const base = bookingDb([storedBooking]);
    const db = {
      prepare(sql) {
        sqlSeen.push(sql);
        return base.prepare(sql);
      },
    };
    const changed = await updateBooking({ BOT_TOKEN: 'test', DB: db }, -123, 3, {
      court: '5', startsAt, endsAt, reminderAt: startsAt - 3600000,
    }, { id: 7, first_name: 'Nick' }, 'Changed court');
    expect(changed).toBe(true);
    expect(sqlSeen.some((sql) => sql.includes('INSERT INTO booking_audit'))).toBe(true);
    expect(requests.some((request) => request.url.endsWith('/sendMessage'))).toBe(false);
  });

  const roster = [
    { id: 1, booking_id: 3, chat_id: -123, user_id: 7, slug: 'u7', name: 'Nick' },
    { id: 2, booking_id: 3, chat_id: -123, user_id: 9, slug: 'u9', name: '@alice' },
    {
      id: 3, booking_id: 3, chat_id: -123, user_id: null,
      slug: '@dodgerblueee', name: '@dodgerblueee',
    },
  ];

  function reminderDb() {
    const due = roster.filter((player) => player.user_id).map((player) => ({
      ...storedBooking,
      created_by_user_id: 7,
      created_by_name: 'Nick',
      pre_reminder_at: startsAt - 2 * 60 * 60 * 1000,
      player_row_id: player.id,
      player_user_id: player.user_id,
      player_chat_id: player.chat_id,
    }));
    // Reminders are claimed per player, and a claim only succeeds once. That is
    // what stops the public fallback from being sent per player.
    const claimed = new Set();
    return {
      prepare(sql) {
        return {
          bind(...args) {
            return {
              async first() {
                return sql.includes('SELECT tz') ? { tz: 'Asia/Singapore' } : null;
              },
              async all() {
                // Only the two-hour pass has anything due.
                if (sql.includes('p.pre_reminder_sent = 0')) return { results: due };
                if (sql.includes('FROM booking_players AS p')) return { results: [] };
                if (sql.includes('NOT EXISTS')) return { results: [] };
                if (sql.includes('FROM booking_players')) return { results: roster };
                return { results: [] };
              },
              async run() {
                if (sql.includes('UPDATE booking_players SET pre_reminder_sent = 1')) {
                  if (sql.includes('WHERE booking_id = ?')) {
                    for (const player of roster) claimed.add(player.id);
                    return { meta: { changes: roster.length } };
                  }
                  if (claimed.has(args[0])) return { meta: { changes: 0 } };
                  claimed.add(args[0]);
                  return { meta: { changes: 1 } };
                }
                return { meta: { changes: 1 } };
              },
            };
          },
        };
      },
    };
  }

  it('sends the two-hour reminder to each player, visible only to them', async () => {
    const requests = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(init.body) });
      return new Response(JSON.stringify({
        ok: true, result: { message_id: 1, ephemeral_message_id: 12 },
      }), { headers: { 'Content-Type': 'application/json' } });
    }));
    await runMaintenance(
      { BOT_TOKEN: 'test', DB: reminderDb() }, startsAt - 2 * 60 * 60 * 1000
    );
    const reminders = requests.filter((request) => request.url.endsWith('/sendMessage'));
    expect(reminders).toHaveLength(2);
    // Posted in the group chat, but addressed to one player each.
    expect(reminders.every((request) => request.body.chat_id === -123)).toBe(true);
    expect(reminders.map((request) => request.body.receiver_user_id)).toEqual([7, 9]);
    for (const reminder of reminders) {
      expect(reminder.body.text).toContain('Squash in 2 hours!');
      expect(reminder.body.text).toContain('Court 4');
      expect(reminder.body.text).toContain(
        '<a href="tg://user?id=7">Nick</a>, <a href="tg://user?id=9">@alice</a>, @dodgerblueee'
      );
    }
  });

  it('falls back to one public reminder instead of one per player', async () => {
    // Telegram returns an ordinary group message when it cannot deliver an
    // ephemeral one. Sending to every player regardless would post the same
    // reminder to the group once per person.
    const requests = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 77 } }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }));
    await runMaintenance(
      { BOT_TOKEN: 'test', DB: reminderDb() }, startsAt - 2 * 60 * 60 * 1000
    );
    const sent = requests.filter((request) => request.url.endsWith('/sendMessage'));
    const deleted = requests.filter((request) => request.url.endsWith('/deleteMessage'));
    expect(sent).toHaveLength(2);
    expect(sent[0].body.receiver_user_id).toBe(7);
    expect(deleted).toHaveLength(1);
    expect(deleted[0].body.message_id).toBe(77);
    expect(sent[1].body).not.toHaveProperty('receiver_user_id');
    expect(sent[1].body.text).toContain('tg://user?id=7');
    expect(sent[1].body.text).toContain('tg://user?id=9');
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  addBooking, bookingPanelView, BookingConflictError, boardHtml, cancelBooking,
  deletePanelView, managerView, notifyRosterOfJoin, runMaintenance, updateBooking,
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

  it('confirms a new booking to the booker alone, never to the group', async () => {
    const requests = captureTelegram();
    const roster = [{ id: 1, booking_id: 3, user_id: 7, slug: 'u7', name: 'Nick' }];
    await addBooking({ BOT_TOKEN: 'test', DB: bookingDb([storedBooking], roster) }, -123, {
      court: '4', startsAt, endsAt, reminderAt: startsAt - 3600000,
    }, { id: 7, first_name: 'Nick' });
    const sent = requests.filter((request) => request.url.endsWith('/sendMessage'));
    expect(sent).toHaveLength(1);
    expect(sent[0].body.text).toContain('Court 4 booked');
    expect(sent[0].body.text).toContain('👥 <a href="tg://user?id=7">Nick</a> · 2 slots');
    // Visible only to whoever booked it, and dismissable.
    expect(sent[0].body.receiver_user_id).toBe(7);
    expect(sent[0].body.reply_markup.inline_keyboard[0][0])
      .toEqual({ text: '👍 OK', callback_data: 'sb:ok' });
  });

  it('removes a booking without posting to the group', async () => {
    const requests = captureTelegram();
    await cancelBooking({ BOT_TOKEN: 'test', DB: bookingDb([]) }, -123, 3);
    expect(requests.some((request) => request.url.endsWith('/sendMessage'))).toBe(false);
  });

  // Every write is recorded so a test can tell a refusal from a deletion.
  function auditedDb(booking) {
    const ran = [];
    return {
      ran,
      prepare(sql) {
        return { bind(...args) { return {
          async first() {
            if (sql.includes('SELECT tz')) return { tz: 'Asia/Singapore' };
            if (sql.includes('board_message_id')) return { board_message_id: 55 };
            if (sql.includes('SELECT * FROM bookings WHERE id')) return booking;
            return null;
          },
          async all() { return { results: [] }; },
          async run() { ran.push({ sql, args }); return { meta: { changes: 1 } }; },
        }; } };
      },
    };
  }

  function captureTelegramAs(memberStatus) {
    const requests = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(init.body) });
      const result = String(url).endsWith('/getChatMember')
        ? { status: memberStatus } : { message_id: 1 };
      return new Response(JSON.stringify({ ok: true, result }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }));
    return requests;
  }

  // Cancelling is refused once a court has been played, so this fixture has to
  // stay in the future as the wall clock moves rather than pinning a date.
  const bookedByNick = {
    ...storedBooking, created_by_user_id: 7, created_by_name: '@nick',
    starts_at: Date.now() + 24 * 60 * 60 * 1000,
    ends_at: Date.now() + 25 * 60 * 60 * 1000,
    source_text: '19 Aug Court 4 9pm',
  };

  it('refuses a cancellation from anyone but the booker or an admin', async () => {
    captureTelegramAs('member');
    const db = auditedDb(bookedByNick);
    const result = await cancelBooking(
      { BOT_TOKEN: 'test', DB: db }, -123, 3, { id: 11, username: 'alice' }, '/cancel 3'
    );
    expect(result.status).toBe('forbidden');
    expect(result.message).toBe('Only @nick or a group admin can cancel that booking.');
    // The refusal says who to ask and nothing else about the booking.
    expect(result.booking).toBeNull();
    expect(db.ran.some((query) => query.sql.startsWith('DELETE FROM bookings'))).toBe(false);
  });

  it('refuses to cancel a court that has already been played', async () => {
    captureTelegramAs('creator');
    const played = {
      ...bookedByNick,
      starts_at: Date.now() - 2 * 60 * 60 * 1000,
      ends_at: Date.now() - 60 * 60 * 1000,
    };
    const db = auditedDb(played);
    const result = await cancelBooking(
      { BOT_TOKEN: 'test', DB: db }, -123, 3, { id: 7, first_name: 'Nick' }, '/cancel 3'
    );
    // The tab is charged when a booking expires, so deleting it erases the bill.
    expect(result.status).toBe('played');
    expect(db.ran.some((query) => query.sql.startsWith('DELETE FROM bookings'))).toBe(false);
  });

  it('lets the booker cancel, and keeps the original text in the audit trail', async () => {
    captureTelegramAs('member');
    const db = auditedDb(bookedByNick);
    const result = await cancelBooking(
      { BOT_TOKEN: 'test', DB: db }, -123, 3, { id: 7, first_name: 'Nick' }, '/cancel 3'
    );
    expect(result.status).toBe('cancelled');
    expect(db.ran.some((query) => query.sql.startsWith('DELETE FROM bookings'))).toBe(true);
    const audit = db.ran.find((query) => query.sql.includes('INSERT INTO booking_audit'));
    expect(JSON.parse(audit.args[6])).toMatchObject({
      court: '4', sourceText: '19 Aug Court 4 9pm',
    });
  });

  it('deletes a booking receipt Telegram could not keep private', async () => {
    const requests = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 77 } }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }));
    await addBooking({ BOT_TOKEN: 'test', DB: bookingDb([storedBooking]) }, -123, {
      court: '4', startsAt, endsAt, reminderAt: startsAt - 3600000,
    }, { id: 7, first_name: 'Nick' });
    const receipt = requests.find((request) => request.url.endsWith('/sendMessage'));
    expect(receipt.body.text).toContain('Court 4 booked');
    // The roster would otherwise sit in the group until the end of the day.
    const deleted = requests.filter((request) => request.url.endsWith('/deleteMessage'));
    expect(deleted.map((request) => request.body.message_id)).toContain(77);
  });

  it('labels edit buttons with court, date, and time instead of an ID', async () => {
    const view = await managerView(
      { BOT_TOKEN: 'test', DB: bookingDb([storedBooking]) },
      -123, { id: 7, first_name: 'Nick' }, false, startsAt - 60000
    );
    const label = view.replyMarkup.inline_keyboard[0][0].text;
    expect(label).toContain('✏️ Court 4');
    expect(label).toContain('19 Aug');
    expect(label).toContain('9:00 pm');
    expect(label).not.toContain('#3');
  });

  it('lists a full court in the manager, matching the board', async () => {
    const full = ['@a', '@b', '@c'].map((slug, index) => ({
      id: index + 1, booking_id: 3, user_id: null, slug, name: slug,
    }));
    const view = await managerView(
      { BOT_TOKEN: 'test', DB: bookingDb([storedBooking], full) }, -123, startsAt - 1
    );
    // Hiding it here would protect nothing the pinned board does not show, and
    // would leave a booked-out court with no way to edit or delete it.
    expect(view.replyMarkup.inline_keyboard[0][0].callback_data).toBe('sb:pick:3');
  });

  it('names who is playing on the court panel', async () => {
    const roster = [
      { id: 1, booking_id: 3, user_id: 7, slug: 'u7', name: 'Nick' },
      { id: 2, booking_id: 3, user_id: null, slug: '@bo', name: '@Bo' },
    ];
    const panel = await bookingPanelView(
      { BOT_TOKEN: 'test', DB: bookingDb([storedBooking], roster) }, -123, 3
    );
    // The board cannot carry this; a private panel about one court can.
    expect(panel.html).toContain('<a href="tg://user?id=7">Nick</a>, @Bo');
    expect(panel.html).toContain('1 slot');
  });

  it('shows edit actions before an explicit delete confirmation', async () => {
    const env = { BOT_TOKEN: 'test', DB: bookingDb([storedBooking]) };
    const panel = await bookingPanelView(env, -123, 3);
    const labels = panel.replyMarkup.inline_keyboard.flat().map((button) => button.text);
    expect(labels).toContain('📅 Change date');
    expect(labels).toContain('🔢 Change court');
    expect(labels).toContain('🕐 Change time');
    expect(labels).toContain('🗑 Delete booking');

    const confirmation = await deletePanelView(env, -123, 3);
    expect(confirmation.html).toContain('Court 4');
    expect(confirmation.html).toContain('19 Aug');
    expect(confirmation.html).toContain('9:00 pm');
    expect(confirmation.replyMarkup.inline_keyboard[0][0].callback_data).toBe('sb:cancel:3');
  });

  it('renders each pinned booking on two short lines that will not wrap', async () => {
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
    expect(html).toContain('in 7 days · Wed 19 Aug\n9pm · <b>Court 4</b> · 1 slot');
    // The roster repeats the same handles on every row, so it moved behind Join.
    expect(html).not.toContain('👥');
    expect(html).not.toContain('@Dodgerblueee');
    expect(html).not.toContain('$');
    // Nothing a phone would wrap: the tags are markup, not visible characters.
    const widest = Math.max(...html.replace(/<[^>]+>/g, '').split('\n')
      .map((line) => line.length));
    expect(widest).toBeLessThanOrEqual(30);
  });

  it('tells the people already on a court when somebody joins, once each', async () => {
    const requests = captureTelegram();
    const roster = [
      { id: 1, booking_id: 3, chat_id: -123, user_id: 7, slug: 'u7', name: 'Nick' },
      // The same human mid-merge: two rows, one id. One message, not two.
      { id: 2, booking_id: 3, chat_id: -123, user_id: 7, slug: '@nick', name: '@nick' },
      { id: 3, booking_id: 3, chat_id: -123, user_id: null, slug: '@bo', name: '@bo' },
      { id: 4, booking_id: 3, chat_id: -123, user_id: 11, slug: '@alice', name: '@alice' },
    ];
    await notifyRosterOfJoin(
      { BOT_TOKEN: 'test', DB: bookingDb([storedBooking], roster) },
      -123, storedBooking, { id: 11, username: 'alice' }
    );
    const sent = requests.filter((request) => request.url.endsWith('/sendMessage'));
    // Nick once; @bo has no id to send to; the joiner is not told about herself.
    expect(sent.map((request) => request.body.receiver_user_id)).toEqual([7]);
    expect(sent[0].body.text).toContain('@alice');
    expect(sent[0].body.text).toContain('Court 4');
  });

  it('lists a full court on the board, marked full', async () => {
    const full = ['u7', '@dodgerblueee', '@alice'].map((slug, index) => ({
      id: index + 1, booking_id: 3, user_id: null, slug, name: slug,
    }));
    const html = await boardHtml(
      { DB: bookingDb([storedBooking], full) }, -123, Date.UTC(2026, 7, 12, 12, 0)
    );
    // A court missing from the board would read as a court nobody booked.
    expect(html).toContain('in 7 days · Wed 19 Aug\n9pm · <b>Court 4</b> · full');
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

  // Rosters are seeded with their own flags unspent, so a booking made inside a
  // reminder window can only be silenced by the booking-level flag.
  function lateBookingDb() {
    const due = roster.filter((player) => player.user_id).map((player) => ({
      ...storedBooking,
      reminder_sent: 1,
      pre_reminder_sent: 1,
      pre_reminder_at: startsAt - 2 * 60 * 60 * 1000,
      player_row_id: player.id,
      player_user_id: player.user_id,
      player_chat_id: player.chat_id,
    }));
    return {
      prepare(sql) {
        return { bind() { return {
          async first() {
            return sql.includes('SELECT tz') ? { tz: 'Asia/Singapore' } : null;
          },
          async all() {
            if (!sql.includes('FROM booking_players AS p')) return { results: [] };
            return { results: /b\.(pre_)?reminder_sent = 0/.test(sql) ? [] : due };
          },
          async run() { return { meta: { changes: 1 } }; },
        }; } };
      },
    };
  }

  it('marks the reminders of a booking made inside their window as spent', async () => {
    captureTelegram();
    const inserts = [];
    const db = {
      prepare(sql) {
        return { bind(...args) {
          if (sql.startsWith('INSERT INTO bookings')) inserts.push({ sql, args });
          return {
            async first() {
              return sql.includes('SELECT tz') ? { tz: 'Asia/Singapore' } : null;
            },
            async all() { return { results: [] }; },
            async run() { return { meta: { changes: 1, last_row_id: 3 } }; },
          };
        } };
      },
    };
    const soon = Date.now() + 30 * 60 * 1000;
    await addBooking({ BOT_TOKEN: 'test', DB: db }, -123, {
      court: '4', startsAt: soon, endsAt: soon + 60 * 60 * 1000, reminderAt: soon - 13 * 60 * 60 * 1000,
    }, { id: 7, first_name: 'Nick' });
    const [insert] = inserts;
    const columns = insert.sql
      .slice(insert.sql.indexOf('(') + 1, insert.sql.indexOf(')'))
      .split(',').map((column) => column.trim());
    // Neither "Squash today!" nor "Squash in 2 hours!" is news at 8:30pm.
    expect(insert.args[columns.indexOf('reminder_sent')]).toBe(1);
    expect(insert.args[columns.indexOf('pre_reminder_sent')]).toBe(1);
  });

  it('sends no roster reminder for a booking whose own flag is already spent', async () => {
    const requests = captureTelegram();
    await runMaintenance(
      { BOT_TOKEN: 'test', DB: lateBookingDb() }, startsAt - 2 * 60 * 60 * 1000
    );
    expect(requests.filter((request) => request.url.endsWith('/sendMessage'))).toHaveLength(0);
  });

  it('hands the roster reminders back when a booking moves to another date', async () => {
    captureTelegram();
    const db = auditedDb(storedBooking);
    const moved = startsAt + 7 * 24 * 60 * 60 * 1000;
    await updateBooking({ BOT_TOKEN: 'test', DB: db }, -123, 3, {
      court: '4', startsAt: moved, endsAt: moved + 60 * 60 * 1000,
      reminderAt: moved - 13 * 60 * 60 * 1000,
    }, { id: 7, first_name: 'Nick' }, 'Changed date');
    const reset = db.ran.find(
      (query) => query.sql.startsWith('UPDATE booking_players SET reminder_sent')
    );
    // Everyone already reminded about the old date has to hear about the new one.
    expect(reset.args).toEqual([0, 0, 3]);
  });

  function strayChatDb(bookings) {
    const seen = [];
    const db = {
      seen,
      prepare(sql) {
        return { bind(...args) {
          seen.push({ sql, args });
          return {
            async first() {
              if (sql.includes('SELECT tz')) return { tz: 'Asia/Singapore' };
              if (sql.includes('board_message_id')) return { board_message_id: 55 };
              return null;
            },
            async all() {
              if (sql.includes('ends_at <=')) {
                return {
                  results: sql.includes('chat_id IN')
                    ? bookings.filter((booking) => args.includes(booking.chat_id)) : bookings,
                };
              }
              if (sql.includes('ends_at >')) return { results: bookings };
              return { results: [] };
            },
            async run() { return { meta: { changes: 1 } }; },
          };
        } };
      },
    };
    return db;
  }

  it('keeps cron maintenance inside ALLOWED_CHATS', async () => {
    const now = Date.now();
    // What a group promoted to a supergroup leaves behind: rows under an id the
    // bot no longer serves.
    const stray = { ...storedBooking, id: 9, chat_id: -999, ends_at: now - 1000 };
    const requests = captureTelegram();
    await runMaintenance(
      { BOT_TOKEN: 'test', ALLOWED_CHATS: '-123', DB: strayChatDb([stray]) }, now
    );
    expect(requests.some((request) => request.body.chat_id === -999)).toBe(false);
    expect(requests).toHaveLength(0);

    requests.length = 0;
    await runMaintenance({ BOT_TOKEN: 'test', DB: strayChatDb([stray]) }, now);
    // With no allow list configured the sweep stays unscoped, as it always was.
    expect(requests.some((request) => request.body.chat_id === -999)).toBe(true);
  });

  it('sweeps the shared data chat as well when DATA_CHAT_ID is set', async () => {
    captureTelegram();
    const db = strayChatDb([]);
    await runMaintenance({
      BOT_TOKEN: 'test', ALLOWED_CHATS: '-123', DATA_CHAT_ID: '-222', DB: db,
    }, Date.now());
    const sweep = db.seen.find((query) => query.sql.includes('ends_at <='));
    expect(sweep.args).toContain(-222);
    expect(sweep.args).toContain(-123);
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

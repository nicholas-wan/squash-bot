import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  addBooking, bookingPanelView, BookingConflictError, boardHtml, cancelBooking,
  deletePanelView, managerView, notifyRosterOfChange, runMaintenance, updateBoard,
  updateBooking,
} from '../src/bookings.js';
import { clearAdminCache } from '../src/players.js';

const startsAt = Date.UTC(2026, 7, 19, 13, 0);
const endsAt = Date.UTC(2026, 7, 19, 14, 0);
const storedBooking = {
  id: 3, chat_id: -123, court: '4', starts_at: startsAt, ends_at: endsAt,
};

// The same court, still ahead of the wall clock. Editing one that has already
// started is an admin's business, so a fixture pinned in the past is refused
// rather than saved once that date goes by.
const upcoming = {
  ...storedBooking,
  starts_at: Date.now() + 24 * 60 * 60 * 1000,
  ends_at: Date.now() + 25 * 60 * 60 * 1000,
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
              if (sql.includes('SELECT * FROM bookings WHERE id')) {
                return activeBookings[0] || storedBooking;
              }
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
  afterEach(() => {
    vi.unstubAllGlobals();
    clearAdminCache();
  });

  function captureTelegram() {
    const requests = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(init.body) });
      return new Response(JSON.stringify({
        ok: true, result: { ephemeral_message_id: 55 },
      }), {
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

  // Mid-court: started, not finished. The charge is only written when the
  // booking expires, so this is the window a cancellation would erase a bill in.
  const inPlay = {
    ...bookedByNick,
    starts_at: Date.now() - 30 * 60 * 1000,
    ends_at: Date.now() + 30 * 60 * 1000,
  };

  it('refuses the booker a cancellation once the court has started', async () => {
    captureTelegramAs('member');
    const db = auditedDb(inPlay);
    const result = await cancelBooking(
      { BOT_TOKEN: 'test', DB: db }, -123, 3, { id: 7, first_name: 'Nick' }, '/cancel 3'
    );
    // Cancelling during the hour of play would take everyone's share with it.
    expect(result.status).toBe('started');
    expect(result.message).toContain('only a group admin');
    expect(db.ran.some((query) => query.sql.startsWith('DELETE FROM bookings'))).toBe(false);
  });

  it('lets an admin cancel a court that has started', async () => {
    captureTelegramAs('administrator');
    const db = auditedDb(inPlay);
    const result = await cancelBooking(
      { BOT_TOKEN: 'test', DB: db }, -123, 3, { id: 11, username: 'alice' }, '/cancel 3'
    );
    // A court nobody could get into is an admin's to sort out.
    expect(result.status).toBe('cancelled');
    expect(db.ran.some((query) => query.sql.startsWith('DELETE FROM bookings'))).toBe(true);
  });

  it('refuses a non-admin edit saved after the court has started', async () => {
    captureTelegramAs('member');
    const db = auditedDb(inPlay);
    // The wizard form can be saved long after it was opened, so moving a
    // started court to tomorrow — and cancelling it there — is checked here too.
    const saved = await updateBooking(
      { BOT_TOKEN: 'test', DB: db }, -123, 3, {
        court: '4',
        startsAt: inPlay.starts_at + 24 * 60 * 60 * 1000,
        endsAt: inPlay.ends_at + 24 * 60 * 60 * 1000,
        reminderAt: inPlay.starts_at + 11 * 60 * 60 * 1000,
      }, { id: 7, first_name: 'Nick' }, 'Edited with SquashBot'
    );
    expect(saved).toBe('started');
    expect(db.ran.some((query) => query.sql.startsWith('UPDATE bookings SET'))).toBe(false);
  });

  it('refuses even an admin edit saved after the court has finished', async () => {
    const played = {
      ...bookedByNick,
      starts_at: Date.now() - 2 * 60 * 60 * 1000,
      ends_at: Date.now() - 60 * 60 * 1000,
    };
    const db = auditedDb(played);
    const saved = await updateBooking(
      { BOT_TOKEN: 'test', DB: db }, -123, 3, {
        court: '4',
        startsAt: Date.now() + 24 * 60 * 60 * 1000,
        endsAt: Date.now() + 25 * 60 * 60 * 1000,
        reminderAt: Date.now() + 12 * 60 * 60 * 1000,
      }, { id: 11, username: 'admin' }, 'Stale edit form'
    );
    expect(saved).toBe('played');
    expect(db.ran.some((query) => query.sql.startsWith('UPDATE bookings SET'))).toBe(false);
  });

  it('warns an admin that deleting a court in play charges nobody', async () => {
    const inPlayPanel = await deletePanelView(
      { BOT_TOKEN: 'test', DB: auditedDb(inPlay) }, -123, 3
    );
    expect(inPlayPanel.html).toContain('This court is in progress');
    const futurePanel = await deletePanelView(
      { BOT_TOKEN: 'test', DB: auditedDb(bookedByNick) }, -123, 3
    );
    expect(futurePanel.html).not.toContain('in progress');
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

  // The cancel and edit notices share this shape: roster on the court, a
  // private send that stays private, and getChatMember for the admin gate.
  function rosteredDb(booking, roster) {
    return {
      prepare(sql) {
        return { bind() { return {
          async first() {
            if (sql.includes('SELECT tz')) return { tz: 'Asia/Singapore' };
            if (sql.includes('board_message_id')) return { board_message_id: 55 };
            if (sql.includes('SELECT * FROM bookings WHERE id')) return booking;
            return null;
          },
          async all() {
            if (sql.includes('FROM booking_players')) return { results: roster };
            return { results: [] };
          },
          async run() { return { meta: { changes: 1 } }; },
        }; } };
      },
      async batch(statements) {
        return Promise.all(statements.map((statement) => statement.run()));
      },
    };
  }

  function capturePrivateTelegram() {
    const requests = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(init.body) });
      const result = String(url).endsWith('/getChatMember')
        ? { status: 'member' } : { ephemeral_message_id: 12 };
      return new Response(JSON.stringify({ ok: true, result }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }));
    return requests;
  }

  it('tells the rest of the court when a booking is cancelled', async () => {
    const requests = capturePrivateTelegram();
    const roster = [
      { id: 1, booking_id: 3, user_id: 7, slug: 'u7', name: 'Nick' },
      { id: 2, booking_id: 3, user_id: 9, slug: 'u9', name: 'Alice' },
    ];
    const result = await cancelBooking(
      { BOT_TOKEN: 'test', DB: rosteredDb(bookedByNick, roster) },
      -123, 3, { id: 7, first_name: 'Nick' }, '/cancel 3'
    );
    expect(result.status).toBe('cancelled');
    const sent = requests.filter((request) => request.url.endsWith('/sendMessage'));
    // Alice may already hold her morning reminder; the actor has their own toast.
    expect(sent.map((request) => request.body.receiver_user_id)).toEqual([9]);
    expect(sent[0].body.text).toContain('Cancelled');
    expect(sent[0].body.text).toContain('Court 4');
    expect(sent[0].body.text).toContain('Nick');
  });

  it('tells the rest of the court when a booking moves', async () => {
    const requests = capturePrivateTelegram();
    const roster = [
      { id: 1, booking_id: 3, user_id: 7, slug: 'u7', name: 'Nick' },
      { id: 2, booking_id: 3, user_id: 9, slug: 'u9', name: 'Alice' },
    ];
    const saved = await updateBooking(
      { BOT_TOKEN: 'test', DB: rosteredDb(bookedByNick, roster) },
      -123, 3, {
        court: '5',
        startsAt: bookedByNick.starts_at + 3600000,
        endsAt: bookedByNick.ends_at + 3600000,
        reminderAt: bookedByNick.starts_at,
      }, { id: 7, first_name: 'Nick' }, 'Edited with SquashBot'
    );
    expect(saved).toBe(true);
    const sent = requests.filter((request) => request.url.endsWith('/sendMessage'));
    expect(sent.map((request) => request.body.receiver_user_id)).toEqual([9]);
    // Old details ride along so the change reads as a change.
    expect(sent[0].body.text).toContain('Now: Court 5');
    expect(sent[0].body.text).toContain('Was: Court 4');
  });

  it('names the booker on the admin panel', async () => {
    captureTelegram();
    const view = await bookingPanelView(
      { BOT_TOKEN: 'test', DB: rosteredDb(bookedByNick, []) }, -123, 3
    );
    expect(view.html).toContain('Booked by @nick');
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
    // A nearer court in front, so this one is not the board's nearest.
    const earlier = {
      ...storedBooking, id: 2, starts_at: startsAt - 86400000, ends_at: endsAt - 86400000,
    };
    const html = await boardHtml(
      { DB: bookingDb([earlier, storedBooking], roster) }, -123, Date.UTC(2026, 7, 12, 12, 0)
    );
    expect(html).toContain('in 7 days · Wed 19 Aug\n9pm · <b>Court 4</b> · 1 slot · 2/3');
    // The roster repeats the same handles on every row, so it moved behind Join.
    expect(html).not.toContain('👥');
    expect(html).not.toContain('@Dodgerblueee');
    expect(html).not.toContain('$');
    // Nothing a phone would wrap: the tags are markup, not visible characters.
    const widest = Math.max(...html.replace(/<[^>]+>/g, '').split('\n')
      .map((line) => line.length));
    expect(widest).toBeLessThanOrEqual(30);
  });

  it('names who is on the nearest court, and only that one', async () => {
    const soon = {
      ...storedBooking, id: 2, starts_at: startsAt - 86400000, ends_at: endsAt - 86400000,
    };
    const roster = [
      { id: 1, booking_id: 2, user_id: 7, slug: 'u7', name: 'Nick' },
      { id: 2, booking_id: 2, user_id: null, slug: '@bo', name: '@Bo' },
      { id: 3, booking_id: 3, user_id: null, slug: '@alice', name: '@alice' },
    ];
    const html = await boardHtml(
      { DB: bookingDb([soon, storedBooking], roster) }, -123, Date.UTC(2026, 7, 12, 12, 0)
    );
    // The court people are deciding about tonight answers "who is on it"
    // right on the board; the ones further out still keep it behind Join.
    expect(html).toContain(
      'in 6 days · Tue 18 Aug\n9pm · <b>Court 4</b> · 1 slot · 2/3\n'
      + '👥 <a href="tg://user?id=7">Nick</a>, @Bo'
    );
    expect(html).not.toContain('@alice');
  });

  it('names the roster of every court sharing the earliest start', async () => {
    const twin = { ...storedBooking, id: 4, court: '5' };
    const roster = [
      { id: 1, booking_id: 3, user_id: null, slug: '@bo', name: '@Bo' },
      { id: 2, booking_id: 4, user_id: null, slug: '@alice', name: '@alice' },
    ];
    const html = await boardHtml(
      { DB: bookingDb([storedBooking, twin], roster) }, -123, Date.UTC(2026, 7, 12, 12, 0)
    );
    expect(html).toContain('<b>Court 4</b> · 2 slots · 1/3\n👥 @Bo');
    expect(html).toContain('<b>Court 5</b> · 2 slots · 1/3\n👥 @alice');
  });

  it('names the booker on the board unless the organiser booked it', async () => {
    const env = { OWNER: '@nick', OWNER_USER_ID: '7' };
    const byMember = { ...storedBooking, created_by_user_id: 9, created_by_name: '@jared' };
    const html = await boardHtml(
      { ...env, DB: bookingDb([byMember], []) }, -123, Date.UTC(2026, 7, 12, 12, 0)
    );
    expect(html).toContain('9pm · <b>Court 4</b> · 3 slots · 0/3\n📝 Booked by @jared');

    // The organiser books most courts; naming them on each row is noise.
    for (const byOwner of [
      { ...storedBooking, created_by_user_id: 7, created_by_name: '@nick' },
      // An older row, or a renamed organiser: the id still says who it was.
      { ...storedBooking, created_by_user_id: 7, created_by_name: '@oldhandle' },
      // A booker recorded by name alone, before ids were kept.
      { ...storedBooking, created_by_user_id: null, created_by_name: '@Nick' },
    ]) {
      const quiet = await boardHtml(
        { ...env, DB: bookingDb([byOwner], []) }, -123, Date.UTC(2026, 7, 12, 12, 0)
      );
      expect(quiet).not.toContain('Booked by');
    }
  });

  it('tells the whole roster when somebody joins, once each', async () => {
    const requests = captureTelegram();
    const roster = [
      { id: 1, booking_id: 3, chat_id: -999, user_id: 7, slug: 'u7', name: 'Nick' },
      // The same human mid-merge: two rows, one id. One message, not two.
      { id: 2, booking_id: 3, chat_id: -999, user_id: 7, slug: '@nick', name: '@nick' },
      { id: 3, booking_id: 3, chat_id: -999, user_id: null, slug: '@bo', name: '@bo' },
      { id: 4, booking_id: 3, chat_id: -999, user_id: 11, slug: '@alice', name: '@alice' },
    ];
    await notifyRosterOfChange(
      {
        BOT_TOKEN: 'test', DB: bookingDb([storedBooking], roster),
        ALLOWED_CHATS: '-123,-999', DATA_CHAT_ID: '-999',
      },
      -123, storedBooking, { id: 11, username: 'alice' }, 'joined'
    );
    const sent = requests.filter((request) => request.url.endsWith('/sendMessage'));
    // The joiner's confirmation first, then Nick once; @bo has no id to send to.
    expect(sent.map((request) => request.body.receiver_user_id)).toEqual([11, 7]);
    // Every one of them into the chat the tap came from. An ephemeral message
    // is only visible there, and these rows were created in the other group.
    expect(sent.every((request) => request.body.chat_id === -123)).toBe(true);
    expect(sent[0].body.text).toContain('You are on');
    expect(sent[1].body.text).toContain('@alice');
    expect(sent[1].body.text).toContain('Court 4');
    // Every private note can be dismissed, not just the tapper's own.
    for (const request of sent) {
      expect(request.body.reply_markup.inline_keyboard[0][0].text).toBe('👍 OK');
    }
  });

  it('refuses to announce an action it does not recognise', async () => {
    captureTelegram();
    await expect(notifyRosterOfChange(
      { BOT_TOKEN: 'test', DB: bookingDb([storedBooking], []) },
      -123, storedBooking, { id: 11, username: 'alice' }, 'removed'
    )).rejects.toThrow('unknown action');
  });

  it('admits when somebody on the court could not be told', async () => {
    captureTelegram();
    const roster = [
      { id: 1, booking_id: 3, user_id: 7, slug: 'u7', name: 'Nick' },
      // Seeded from config, never posted: no id to send to.
      { id: 2, booking_id: 3, user_id: null, slug: '@bo', name: '@bo' },
    ];
    const { allTold } = await notifyRosterOfChange(
      { BOT_TOKEN: 'test', DB: bookingDb([storedBooking], roster) },
      -123, storedBooking, { id: 11, username: 'alice' }, 'joined'
    );
    expect(allTold).toBe(false);
  });

  it('writes the cleanup rows for a burst of private copies in one batch', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ ok: true, result: { ephemeral_message_id: 99 } }),
      { headers: { 'Content-Type': 'application/json' } }
    )));
    const roster = [
      { id: 1, booking_id: 3, user_id: 7, slug: 'u7', name: 'Nick' },
      { id: 2, booking_id: 3, user_id: 11, slug: '@alice', name: '@alice' },
    ];
    const db = bookingDb([storedBooking], roster);
    const batches = [];
    db.batch = async (statements) => {
      batches.push(statements);
      return statements.map(() => ({ success: true }));
    };
    const { allTold } = await notifyRosterOfChange(
      { BOT_TOKEN: 'test', DB: db },
      -123, storedBooking, { id: 11, username: 'alice' }, 'joined'
    );
    // Every private copy landed, and the two sent_messages rows went in one
    // batch rather than one INSERT per send.
    expect(allTold).toBe(true);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(2);
  });

  it('tells the rest of the court when somebody leaves, and the leaver too', async () => {
    const requests = captureTelegram();
    // The roster as it stands after the delete: @alice has already gone off it,
    // so her own copy cannot be found in the loop the others are told from.
    const roster = [
      { id: 1, booking_id: 3, chat_id: -999, user_id: 7, slug: 'u7', name: 'Nick' },
      { id: 3, booking_id: 3, chat_id: -999, user_id: null, slug: '@bo', name: '@bo' },
    ];
    await notifyRosterOfChange(
      {
        BOT_TOKEN: 'test', DB: bookingDb([storedBooking], roster),
        ALLOWED_CHATS: '-123,-999', DATA_CHAT_ID: '-999',
      },
      -123, storedBooking, { id: 11, username: 'alice' }, 'left'
    );
    const sent = requests.filter((request) => request.url.endsWith('/sendMessage'));
    // The leaver first, then the one player left who has an id to send to.
    expect(sent.map((request) => request.body.receiver_user_id)).toEqual([11, 7]);
    expect(sent.every((request) => request.body.chat_id === -123)).toBe(true);
    expect(sent[0].body.text).toContain('You are off');
    expect(sent[0].body.reply_markup.inline_keyboard[0][0].text).toBe('👍 OK');
    expect(sent[1].body.text).toContain('@alice');
    expect(sent[1].body.text).toContain('left');
    // The freed slot is what the others are being told about, so it is counted
    // from the roster as it is now rather than as it was before the tap.
    expect(sent[1].body.text).toContain('1 slot');
    expect(sent[1].body.text).not.toContain('@alice</b> joined');
  });

  it('offers only unseated known players when an admin seats somebody', async () => {
    const roster = [{ id: 1, booking_id: 3, user_id: 7, slug: 'u7', name: 'Nick' }];
    const ledger = [
      { slug: '@bo', name: '@bo', user_id: null },
      // Already on the court, so not offered again.
      { slug: 'u7', name: 'Nick', user_id: 7 },
    ];
    const db = { prepare(sql) { return { bind() { return {
      async first() {
        if (sql.includes('SELECT tz')) return { tz: 'Asia/Singapore' };
        if (sql.includes('SELECT * FROM bookings WHERE id')) return storedBooking;
        return null;
      },
      async all() {
        if (sql.includes('FROM ledger')) return { results: ledger };
        if (sql.includes('FROM booking_players')) return { results: roster };
        return { results: [] };
      },
    }; } }; } };
    const { addPlayerView } = await import('../src/bookings.js');
    const view = await addPlayerView({ DB: db }, -123, 3);
    const labels = view.replyMarkup.inline_keyboard.flat().map((button) => button.text);
    // The friend toggle leads, because it changes what tapping a name does.
    expect(labels).toEqual(['👥 Bringing a friend: no', '➕ @bo', '← Back']);
    expect(view.replyMarkup.inline_keyboard[0][0].callback_data).toBe('sb:addp:3:h2');
    expect(view.replyMarkup.inline_keyboard[1][0].callback_data).toBe('sb:addp:3:1:@bo');
    expect(view.html).toContain('billed like anyone');
  });

  it('seats the next tap with a friend once the toggle is on', async () => {
    const seatingDb = (roster) => ({ prepare(sql) { return { bind() { return {
      async first() {
        if (sql.includes('SELECT tz')) return { tz: 'Asia/Singapore' };
        if (sql.includes('SELECT * FROM bookings WHERE id')) return storedBooking;
        return null;
      },
      async all() {
        if (sql.includes('FROM ledger')) {
          return { results: [{ slug: '@bo', name: '@bo', user_id: null }] };
        }
        if (sql.includes('FROM booking_players')) return { results: roster };
        return { results: [] };
      },
    }; } }; } });
    const { addPlayerView } = await import('../src/bookings.js');
    const roster = [{ id: 1, booking_id: 3, user_id: 7, slug: 'u7', name: 'Nick' }];
    const view = await addPlayerView({ DB: seatingDb(roster) }, -123, 3, 2);
    expect(view.replyMarkup.inline_keyboard[0][0]).toEqual({
      text: '👥 Bringing a friend: yes — pays double', callback_data: 'sb:addp:3:h1',
    });
    expect(view.replyMarkup.inline_keyboard[1][0].callback_data).toBe('sb:addp:3:2:@bo');
    // The panel says what it costs before anybody is seated by it.
    expect(view.html).toContain('two slots and pay two shares');

    // Two of the three slots taken. One name still fits; a +1 needs the two it
    // cannot have, and taking half of what it asked for would bill it wrong.
    const crowded = [...roster, { id: 2, booking_id: 3, user_id: 11, slug: '@ann', name: '@ann' }];
    expect(await addPlayerView({ DB: seatingDb(crowded) }, -123, 3, 2)).toBe(null);
    expect(await addPlayerView({ DB: seatingDb(crowded) }, -123, 3)).not.toBe(null);
  });

  it('counts a +1 against the court on the board and the panel', async () => {
    const roster = [{ id: 1, booking_id: 3, user_id: 7, slug: 'u7', name: 'Nick', heads: 2 }];
    const env = { BOT_TOKEN: 'test', DB: bookingDb([storedBooking], roster) };
    // One row, two of the three slots: a friend is a head, not a name.
    const html = await boardHtml(env, -123, Date.UTC(2026, 7, 12, 12, 0));
    expect(html).toContain('in 7 days · Wed 19 Aug\n9pm · <b>Court 4</b> · 1 slot');
    const panel = await bookingPanelView(env, -123, 3);
    expect(panel.html).toContain('<a href="tg://user?id=7">Nick +1</a>');
    expect(panel.html).toContain('1 slot');
  });

  it('strikes out a court filled by a +1 rather than by a third name', async () => {
    const roster = [
      { id: 1, booking_id: 3, user_id: 7, slug: 'u7', name: 'Nick', heads: 2 },
      { id: 2, booking_id: 3, user_id: null, slug: '@bo', name: '@bo', heads: 1 },
    ];
    const html = await boardHtml(
      { DB: bookingDb([storedBooking], roster) }, -123, Date.UTC(2026, 7, 12, 12, 0)
    );
    expect(html).toContain('in 7 days · Wed 19 Aug\n<s>9pm · <b>Court 4</b> · full</s>');
  });

  it('labels the +1 picker with which way each member flips', async () => {
    const roster = [
      { id: 1, booking_id: 3, user_id: 7, slug: 'u7', name: 'Nick', heads: 1 },
      { id: 8, booking_id: 3, user_id: 42, slug: '@jarhead', name: '@jarhead', heads: 2 },
    ];
    const db = { prepare(sql) { return { bind() { return {
      async first() {
        if (sql.includes('SELECT tz')) return { tz: 'Asia/Singapore' };
        if (sql.includes('SELECT * FROM bookings WHERE id')) return storedBooking;
        return null;
      },
      async all() {
        if (sql.includes('FROM booking_players')) return { results: roster };
        return { results: [] };
      },
    }; } }; } };
    const { plusOneView } = await import('../src/bookings.js');
    const view = await plusOneView({ DB: db }, -123, 3);
    const labels = view.replyMarkup.inline_keyboard.flat().map((button) => button.text);
    expect(labels).toEqual([
      '➕ Nick — bring a friend, pays double',
      '➖ @jarhead +1 — back to one share',
      '← Back',
    ]);
    expect(view.replyMarkup.inline_keyboard[1][0].callback_data).toBe('sb:plus:3:8');
  });

  it('lists a full court on the board, marked full', async () => {
    const full = ['u7', '@dodgerblueee', '@alice'].map((slug, index) => ({
      id: index + 1, booking_id: 3, user_id: null, slug, name: slug,
    }));
    const html = await boardHtml(
      { DB: bookingDb([storedBooking], full) }, -123, Date.UTC(2026, 7, 12, 12, 0)
    );
    // A court missing from the board would read as a court nobody booked —
    // it stays listed, struck through, so open slots pop at a glance — and,
    // being the one court nobody can join, it names who took it.
    expect(html).toContain(
      'in 7 days · Wed 19 Aug\n<s>9pm · <b>Court 4</b> · full</s>\n👥 u7, @dodgerblueee, @alice'
    );
  });

  it('names nobody on the board for a later court with room', async () => {
    const two = ['u7', '@dodgerblueee'].map((slug, index) => ({
      id: index + 1, booking_id: 3, user_id: null, slug, name: slug,
    }));
    const earlier = {
      ...storedBooking, id: 2, starts_at: startsAt - 86400000, ends_at: endsAt - 86400000,
    };
    const html = await boardHtml(
      { DB: bookingDb([earlier, storedBooking], two) }, -123, Date.UTC(2026, 7, 12, 12, 0)
    );
    expect(html).toContain('9pm · <b>Court 4</b> · 1 slot · 2/3');
    expect(html).not.toContain('👥');
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
    // Still ahead: a started court can only be edited by an admin.
    const base = bookingDb([upcoming]);
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
    const ran = [];
    return {
      ran,
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
                ran.push({ sql, args });
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
      { BOT_TOKEN: 'test', ALLOWED_CHATS: '-123', DB: reminderDb() }, startsAt - 2 * 60 * 60 * 1000
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
      { BOT_TOKEN: 'test', ALLOWED_CHATS: '-123', DB: lateBookingDb() }, startsAt - 2 * 60 * 60 * 1000
    );
    expect(requests.filter((request) => request.url.endsWith('/sendMessage'))).toHaveLength(0);
  });

  it('hands the roster reminders back when a booking moves to another date', async () => {
    captureTelegram();
    const db = auditedDb(upcoming);
    // Pinned in 2027: the reset only happens for reminder windows still ahead,
    // so a relative date here starts failing the day it ages into the past.
    const moved = Date.UTC(2027, 7, 19, 13, 0);
    await updateBooking({ BOT_TOKEN: 'test', DB: db }, -123, 3, {
      court: '4', startsAt: moved, endsAt: moved + 60 * 60 * 1000,
      reminderAt: moved - 13 * 60 * 60 * 1000,
    }, { id: 7, first_name: 'Nick' }, 'Changed date');
    const reset = db.ran.find(
      (query) => query.sql.startsWith('UPDATE booking_players SET reminder_sent')
    );
    // Everyone already reminded about the old date has to hear about the new one.
    expect(reset.args.slice(0, 3)).toEqual([0, 0, 3]);
    // The reset is conditional on the booking carrying the newly committed
    // state, so a rejected conflicting update cannot re-arm old reminders.
    expect(reset.sql).toContain('EXISTS');
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
              // No pinned board and a claimed month, so the daily redraw and
              // the monthly notices stay out of this sweep's request count.
              if (sql.includes('board_day')) return null;
              if (sql.includes('nudged_month')) return null;
              if (sql.includes('board_message_id')) return { board_message_id: 55 };
              return null;
            },
            async all() {
              if (sql.includes('ends_at <=')) {
                return {
                  results: sql.includes('AND 1 = 0') ? [] : sql.includes('chat_id IN')
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
    // A missing allowlist fails closed just like interactive updates do.
    expect(requests.some((request) => request.body.chat_id === -999)).toBe(false);
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
      { BOT_TOKEN: 'test', ALLOWED_CHATS: '-123', DB: reminderDb() }, startsAt - 2 * 60 * 60 * 1000
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

  // Every cron tick sends to the same player until the court starts, so a
  // Telegram that will never take the message has to be told apart from one
  // that is briefly busy.
  function refusingTelegram(description) {
    const requests = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(init.body) });
      const refused = String(url).endsWith('/sendMessage');
      return new Response(JSON.stringify(refused
        ? { ok: false, error_code: 403, description }
        : { ok: true, result: { message_id: 1 } }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }));
    return requests;
  }

  it('stops reminding a player Telegram has permanently refused', async () => {
    refusingTelegram('Forbidden: bot was blocked by the user');
    const db = reminderDb();
    await runMaintenance(
      { BOT_TOKEN: 'test', ALLOWED_CHATS: '-123', DB: db }, startsAt - 2 * 60 * 60 * 1000
    );
    // Handing the claim back would retry the same refusal every minute until
    // the court starts, and sort that player to the front of the next window.
    expect(db.ran.some((query) => query.sql.includes('SET pre_reminder_sent = 0')))
      .toBe(false);
  });

  it('still retries a reminder that only failed for now', async () => {
    refusingTelegram('Bad Gateway');
    const db = reminderDb();
    await runMaintenance(
      { BOT_TOKEN: 'test', ALLOWED_CHATS: '-123', DB: db }, startsAt - 2 * 60 * 60 * 1000
    );
    const reset = db.ran.find((query) => query.sql.includes('SET pre_reminder_sent = 0'));
    expect(reset).toBeTruthy();
    expect(reset.sql).toContain('WHERE id = ?');
  });

  // One row waiting to be cleaned up, and every write recorded, so a test can
  // tell a row that was forgotten from one that is kept for the next tick.
  function purgeDb(row) {
    const ran = [];
    return {
      ran,
      prepare(sql) {
        return { bind(...args) { return {
          async first() {
            return sql.includes('SELECT tz') ? { tz: 'Asia/Singapore' } : null;
          },
          async all() {
            return { results: sql.includes('FROM sent_messages') ? [row] : [] };
          },
          async run() { ran.push({ sql, args }); return { meta: { changes: 1 } }; },
        }; } };
      },
    };
  }

  function deleteAnswer(body) {
    vi.stubGlobal('fetch', vi.fn(async (url) => new Response(
      JSON.stringify(String(url).endsWith('/deleteMessage')
        ? body : { ok: true, result: { message_id: 1 } }),
      { headers: { 'Content-Type': 'application/json' } }
    )));
  }

  it('keeps a cleanup row Telegram refused, and drops it once it is gone', async () => {
    const now = Date.now();
    const row = {
      id: 4, chat_id: -123, receiver_user_id: null, message_id: 77,
      is_ephemeral: 0, delete_after: now - 60 * 1000,
    };
    // A timeout or a 429 used to lose the row, leaving the message in the chat
    // for good. It waits for the next tick instead.
    deleteAnswer({ ok: false, error_code: 429, description: 'Too Many Requests: retry after 5' });
    const busy = purgeDb(row);
    await runMaintenance({ BOT_TOKEN: 'test', ALLOWED_CHATS: '-123', DB: busy }, now);
    expect(busy.ran.some((query) => query.sql.startsWith('DELETE FROM sent_messages')))
      .toBe(false);

    // Already gone is the same outcome as deleting it.
    deleteAnswer({ ok: false, error_code: 400, description: 'Bad Request: message to delete not found' });
    const missing = purgeDb(row);
    await runMaintenance({ BOT_TOKEN: 'test', ALLOWED_CHATS: '-123', DB: missing }, now);
    expect(missing.ran.some((query) => query.sql.startsWith('DELETE FROM sent_messages')))
      .toBe(true);

    deleteAnswer({ ok: true, result: true });
    const deleted = purgeDb(row);
    await runMaintenance({ BOT_TOKEN: 'test', ALLOWED_CHATS: '-123', DB: deleted }, now);
    expect(deleted.ran.some((query) => query.sql.startsWith('DELETE FROM sent_messages')))
      .toBe(true);
  });

  it('drops an ephemeral cleanup row Telegram reports as MESSAGE_NOT_FOUND', async () => {
    const now = Date.now();
    // Live wording for an ephemeral message that has already expired. The
    // underscore kept it from reading as "not found", so the row was retried
    // every minute for a day and withheld the heartbeat the whole time.
    vi.stubGlobal('fetch', vi.fn(async (url) => new Response(
      JSON.stringify(String(url).endsWith('/deleteEphemeralMessage')
        ? { ok: false, error_code: 400, description: 'Bad Request: MESSAGE_NOT_FOUND' }
        : { ok: true, result: { message_id: 1 } }),
      { headers: { 'Content-Type': 'application/json' } }
    )));
    const expired = purgeDb({
      id: 4, chat_id: -123, receiver_user_id: 42, message_id: 77,
      is_ephemeral: 1, delete_after: now - 60 * 1000,
    });
    const outcome = await runMaintenance({ BOT_TOKEN: 'test', ALLOWED_CHATS: '-123', DB: expired }, now);
    expect(expired.ran.some((query) => query.sql.startsWith('DELETE FROM sent_messages')))
      .toBe(true);
    expect(outcome.ok).toBe(true);
  });

  it('gives up on a cleanup row that has been failing for a week', async () => {
    const now = Date.now();
    deleteAnswer({ ok: false, error_code: 429, description: 'Too Many Requests: retry after 5' });
    // Otherwise one wedged message holds a place in every LIMIT 100 window from
    // then on and starves the rows behind it.
    const stuck = purgeDb({
      id: 4, chat_id: -123, receiver_user_id: null, message_id: 77,
      is_ephemeral: 0, delete_after: now - 8 * 24 * 60 * 60 * 1000,
    });
    await runMaintenance({ BOT_TOKEN: 'test', ALLOWED_CHATS: '-123', DB: stuck }, now);
    expect(stuck.ran.some((query) => query.sql.startsWith('DELETE FROM sent_messages')))
      .toBe(true);
  });

  // 20:00 SGT on 12 Aug 2026: past the 9am notice threshold, mid-month.
  const cronNow = Date.UTC(2026, 7, 12, 12, 0);

  function maintenanceDb({
    boardDay = null, nudgedMonth = '2026-8', balances = [], ledgerRows = [],
  } = {}) {
    const seen = [];
    return {
      seen,
      prepare(sql) {
        return { bind(...args) {
          seen.push({ sql, args });
          return {
            async first() {
              if (sql.includes('SELECT tz')) return { tz: 'Asia/Singapore' };
              if (sql.includes('board_day')) {
                return { board_message_id: 55, board_day: boardDay };
              }
              if (sql.includes('nudged_month')) return { nudged_month: nudgedMonth };
              if (sql.includes('SELECT chat_id FROM booking_players')) {
                return { chat_id: -123 };
              }
              if (sql.includes('board_message_id')) return { board_message_id: 55 };
              return null;
            },
            async all() {
              if (sql.includes('GROUP BY')) return { results: balances };
              if (sql.includes('FROM booking_players')) return { results: [] };
              if (sql.includes('FROM ledger')) return { results: ledgerRows };
              return { results: sql.includes('ends_at >') ? [storedBooking] : [] };
            },
            async run() { return { meta: { changes: 1 } }; },
          };
        } };
      },
    };
  }

  it('redraws each board once per local day so relative labels stay true', async () => {
    const requests = captureTelegram();
    const stale = maintenanceDb({ boardDay: '2026-8-11' });
    await runMaintenance({ BOT_TOKEN: 'test', ALLOWED_CHATS: '-123', DB: stale }, cronNow);
    const edits = requests.filter((request) => request.url.endsWith('/editMessageText'));
    expect(edits).toHaveLength(1);
    expect(edits[0].body.message_id).toBe(55);
    expect(edits[0].body.text).toContain('Court 4');
    // The hour is claimed before the redraw so a throw cannot retry every
    // minute; success trades it for the day's stamp, which ends the retrying.
    // cronNow is 20:00 Singapore time.
    expect(stale.seen
      .filter((query) => query.sql.includes('SET board_day'))
      .map((query) => query.args))
      .toEqual([['2026-8-12~20', -123], ['2026-8-12', -123]]);

    requests.length = 0;
    await runMaintenance({
      BOT_TOKEN: 'test', ALLOWED_CHATS: '-123',
      DB: maintenanceDb({ boardDay: '2026-8-12' }),
    }, cronNow);
    expect(requests.filter((request) => request.url.endsWith('/editMessageText')))
      .toHaveLength(0);
  });

  it('retries a failed redraw the next hour, not the next midnight', async () => {
    // A redraw that died after claiming its hour — a deploy evicting the
    // isolate at the midnight tick — used to leave the countdown wrong until
    // the next midnight.
    const requests = captureTelegram();
    await runMaintenance({
      BOT_TOKEN: 'test', ALLOWED_CHATS: '-123',
      DB: maintenanceDb({ boardDay: '2026-8-12~19' }),
    }, cronNow);
    expect(requests.filter((request) => request.url.endsWith('/editMessageText')))
      .toHaveLength(1);

    // Within the failed hour it stays quiet rather than retrying per minute.
    requests.length = 0;
    await runMaintenance({
      BOT_TOKEN: 'test', ALLOWED_CHATS: '-123',
      DB: maintenanceDb({ boardDay: '2026-8-12~20' }),
    }, cronNow);
    expect(requests.filter((request) => request.url.endsWith('/editMessageText')))
      .toHaveLength(0);
  });

  it('tells each debtor their balance once a month, privately, in the group', async () => {
    const requests = captureTelegram();
    const db = maintenanceDb({
      boardDay: '2026-8-12',
      nudgedMonth: '2026-7',
      balances: [
        // No id to send to until they post once; the pinned tab still names them.
        { slug: '@thadduu', user_id: null, name: '@thadduu', balance: 1400 },
        { slug: 'u9', user_id: 9, name: '@alice', balance: 200 },
        { slug: 'u5', user_id: 5, name: '@settled', balance: -100 },
      ],
      ledgerRows: [{
        slug: 'u9', user_id: 9, name: '@alice', amount_cents: 200,
        booking_id: 5, reason: 'Court 4 · 15 Aug',
        created_at: Date.UTC(2026, 7, 15, 14, 0),
      }],
    });
    // The data chat id points at a group the bot has left: notices must land
    // in the chat each player is actually reachable in, not the storage key.
    await runMaintenance({
      BOT_TOKEN: 'test', ALLOWED_CHATS: '-123', DATA_CHAT_ID: '-999', DB: db,
    }, cronNow);
    const sent = requests.filter((request) => request.url.endsWith('/sendMessage'));
    expect(sent).toHaveLength(1);
    expect(sent[0].body.chat_id).toBe(-123);
    expect(sent[0].body.receiver_user_id).toBe(9);
    expect(sent[0].body.text).toContain('August 2026');
    expect(sent[0].body.text).toContain('$2.00');
    // The ask carries its own story: the itemised lines, no rate card, no
    // pointer to go tap something else first.
    expect(sent[0].body.text).toContain('• Court 4 · 15 Aug — $2.00');
    expect(sent[0].body.text).not.toContain('$6/hour');
    expect(sent[0].body.text).not.toContain('My tab');
    // The month is not stamped complete while a debtor still has no numeric id;
    // if they post later this month, their own notice remains deliverable.
    expect(db.seen.find((query) => query.sql.includes('nudged_month) VALUES')))
      .toBeUndefined();
    expect(db.seen.find((query) => query.sql.includes('SET status = ?')).args)
      .toEqual(['delivered', cronNow, -999, '2026-8', 'u9']);

    // Already stamped for this month: quiet.
    requests.length = 0;
    await runMaintenance({
      BOT_TOKEN: 'test', ALLOWED_CHATS: '-123',
      DB: maintenanceDb({ boardDay: '2026-8-12', nudgedMonth: '2026-8' }),
    }, cronNow);
    expect(requests.filter((request) => request.url.endsWith('/sendMessage')))
      .toHaveLength(0);
  });

  it('keeps a kicked sibling chat from breaking the board update', async () => {
    // The 16 Aug outage: the bot was removed from the data chat, every board
    // loop threw on it, and every command in the healthy chat died with it.
    const requests = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      const body = JSON.parse(init.body);
      requests.push({ url: String(url), body });
      // The sibling chat rejects everything: edit fails, resend fails.
      const kicked = body.chat_id === -999;
      return new Response(JSON.stringify(kicked
        ? { ok: false, error_code: 403, description: 'Forbidden: bot was kicked from the supergroup chat' }
        : { ok: true, result: { message_id: 55 } }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }));
    const db = maintenanceDb({});
    // Acting from the healthy chat: the sibling's failure is logged, not
    // thrown, and the healthy chat's own pinned board still comes back.
    await expect(updateBoard({
      BOT_TOKEN: 'test', ALLOWED_CHATS: '-123,-999', DATA_CHAT_ID: '-999', DB: db,
    }, -123)).resolves.toBe(55);
    const edited = requests.filter((request) => request.url.endsWith('/editMessageText'));
    expect(edited.some((request) => request.body.chat_id === -123)).toBe(true);
    expect(db.seen.some((query) => query.sql.includes('INSERT INTO pending_refreshes')
      && query.args[0] === -999)).toBe(true);

    // Acting from the kicked chat itself, the failure still surfaces.
    await expect(updateBoard({
      BOT_TOKEN: 'test', ALLOWED_CHATS: '-123,-999', DATA_CHAT_ID: '-999', DB: db,
    }, -999)).rejects.toThrow('kicked');
  });

  it('updates shared boards concurrently', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // Holding each edit briefly makes overlap observable without depending on
      // wall-clock totals, which are noisy in CI.
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlight -= 1;
      return new Response(JSON.stringify({ ok: true, result: { message_id: 55 } }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }));
    await updateBoard({
      BOT_TOKEN: 'test', ALLOWED_CHATS: '-123,-999', DATA_CHAT_ID: '-999',
      DB: maintenanceDb({}),
    }, -123);
    expect(maxInFlight).toBe(2);
  });

  it('sends the monthly notice for every chat keeping its own books', async () => {
    const requests = captureTelegram();
    // Without DATA_CHAT_ID each chat is its own set of books; the old shape
    // served only the first and silently skipped every other chat's debtors.
    await runMaintenance({
      BOT_TOKEN: 'test', ALLOWED_CHATS: '-123,-456',
      DB: maintenanceDb({
        boardDay: '2026-8-12',
        nudgedMonth: '2026-7',
        balances: [{ slug: 'u9', user_id: 9, name: '@alice', balance: 200 }],
        ledgerRows: [{
          slug: 'u9', user_id: 9, name: '@alice', amount_cents: 200,
          booking_id: 5, reason: 'Court 4 · 15 Aug',
          created_at: Date.UTC(2026, 7, 15, 14, 0),
        }],
      }),
    }, cronNow);
    const sent = requests.filter((request) => request.url.endsWith('/sendMessage'));
    expect(sent.map((request) => request.body.chat_id)).toEqual([-123, -456]);
    expect(sent.every((request) => request.body.receiver_user_id === 9)).toBe(true);
  });

  it('holds the monthly notice back before 9am local time', async () => {
    const requests = captureTelegram();
    // 22:00 UTC the day before = 6:00 SGT on the 12th.
    await runMaintenance({
      BOT_TOKEN: 'test', ALLOWED_CHATS: '-123',
      DB: maintenanceDb({ boardDay: '2026-8-12', nudgedMonth: '2026-7' }),
    }, Date.UTC(2026, 7, 11, 22, 0));
    expect(requests.filter((request) => request.url.endsWith('/sendMessage')))
      .toHaveLength(0);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleBookingCallback } from '../src/wizard.js';
import { clearAdminCache } from '../src/players.js';

// A complete draft one tap away from saving. Pinned in 2027 so the "already
// passed" validation never starts failing as the wall clock moves.
function completePayload() {
  return {
    operation: 'add',
    bookingId: null,
    sourceText: 'Court 4 20 Aug 9pm',
    date: { y: 2027, mo: 8, d: 20 },
    court: '4',
    start: { h: 21, mi: 0 },
    end: null,
    dateChoices: [],
    courtChoices: [],
    timeChoices: [],
    issues: [],
    conflicts: [],
  };
}

// One draft row whose claim, payload, and lifetime are real state: the save
// path mutates it exactly as D1 would, which is what lets these tests watch
// the __saving__ claim admit one tap and turn the rest away.
function draftDb(state) {
  return {
    prepare(sql) {
      return { bind(...args) { return {
        async first() {
          if (sql.includes('SELECT tz')) return { tz: 'Asia/Singapore' };
          // The booking an edit draft is about, when the test supplies one.
          if (sql.includes('SELECT * FROM bookings WHERE id')) return state.booking || null;
          if (sql.includes('FROM booking_drafts')) {
            return state.deleted ? null : {
              id: 1, chat_id: -123, user_id: 7, user_name: 'Nick',
              payload: JSON.stringify(state.payload),
              wizard_message_id: 40, wizard_ephemeral: 1,
              pending_field: state.pending, booking_id: null,
              source_text: 'Court 4 20 Aug 9pm', created_at: Date.now(),
            };
          }
          return null;
        },
        async all() {
          if (sql.includes('booking_players')) return { results: [] };
          // findBookingConflicts, told apart from the board's active-bookings
          // read by its case-folded court comparison.
          if (sql.includes('LOWER(TRIM(court))')) {
            return { results: [{
              id: 5, court: '4',
              starts_at: Date.UTC(2027, 7, 20, 13, 0),
              ends_at: Date.UTC(2027, 7, 20, 14, 0),
            }] };
          }
          return { results: [] };
        },
        async run() {
          if (sql.includes("pending_field = '__saving__'")) {
            if (state.pending === '__saving__') return { meta: { changes: 0 } };
            state.pending = '__saving__';
            return { meta: { changes: 1 } };
          }
          if (sql.startsWith('UPDATE booking_drafts SET payload')) {
            state.payload = JSON.parse(args[0]);
            state.pending = null;
            return { meta: { changes: 1 } };
          }
          if (sql.startsWith('DELETE FROM booking_drafts')) {
            state.deleted = true;
            return { meta: { changes: 1 } };
          }
          if (sql.startsWith('UPDATE bookings SET')) {
            state.updated = true;
            return { meta: { changes: 1 } };
          }
          if (sql.startsWith('INSERT INTO bookings')) {
            // The conflict guard rides inside the insert; the allow flag is the
            // bound value the guard reads.
            if (state.conflict && args[13] !== 1) return { meta: { changes: 0 } };
            state.inserted = true;
            state.insertArgs = args;
            return { meta: { changes: 1, last_row_id: 9 } };
          }
          if (sql.startsWith('INSERT OR IGNORE INTO booking_players')) {
            (state.seated = state.seated || []).push(args[3]);
            (state.roster = state.roster || []).push({ slug: args[3], heads: args[6] });
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 1 } };
        },
      }; } };
    },
  };
}

function confirmTap(data) {
  return {
    id: 'cb-1', data,
    from: { id: 7, first_name: 'Nick' },
    message: { chat: { id: -123 }, message_id: 40, ephemeral_message_id: 40 },
  };
}

describe('booking wizard save', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    // The admin gate is cached per chat and user, and these tests share both.
    clearAdminCache();
  });

  function captureTelegram() {
    const requests = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(init.body) });
      return new Response(JSON.stringify({
        ok: true, result: { ephemeral_message_id: 60 },
      }), { headers: { 'Content-Type': 'application/json' } });
    }));
    return requests;
  }

  it('turns a second confirm away while the first is still saving', async () => {
    const requests = captureTelegram();
    const state = {
      payload: completePayload(), pending: '__saving__',
      conflict: false, inserted: false, deleted: false,
    };
    const handled = await handleBookingCallback(
      { BOT_TOKEN: 'test', DB: draftDb(state) }, confirmTap('bw:1:y')
    );
    expect(handled).toBe(true);
    const answer = requests.find((request) => request.url.endsWith('/answerCallbackQuery'));
    expect(answer.body.text).toBe('This booking was already handled.');
    // The claim is the whole defence: nothing may reach the bookings table.
    expect(state.inserted).toBe(false);
    expect(state.deleted).toBe(false);
  });

  it('lets an admin record somebody else as the booker', async () => {
    const requests = captureTelegram();
    const state = {
      payload: completePayload(), pending: null,
      conflict: false, inserted: false, deleted: false,
    };
    const env = {
      BOT_TOKEN: 'test', OWNER_USER_ID: '7', DEFAULT_PLAYERS: '@alice',
      DB: draftDb(state),
    };

    await handleBookingCallback(env, confirmTap('bw:1:x:b'));
    expect(state.payload.choosingBooker).toBe(true);
    const index = state.payload.bookerChoices
      .findIndex((choice) => choice.slug === '@alice');
    expect(index).toBeGreaterThanOrEqual(0);

    await handleBookingCallback(env, confirmTap(`bw:1:b:${index}`));
    expect(state.payload.booker).toMatchObject({ slug: '@alice' });

    await handleBookingCallback(env, confirmTap('bw:1:y'));
    // The named booker owns the record and takes the booker's seat, id or not.
    expect(state.insertArgs[9]).toBe(null);
    expect(state.insertArgs[10]).toBe('@alice');
    expect(state.seated[0]).toBe('@alice');
    // Record-keeping, not a notification: no receipt goes anywhere.
    expect(requests.some((request) => request.url.endsWith('/sendMessage'))).toBe(false);
  });

  it.each([
    [{ players: [{ slug: '@alice', name: '@alice', userId: null }] },
      [{ slug: 'u7', heads: 1 }, { slug: '@alice', heads: 1 }]],
    [{ plusOne: true }, [{ slug: 'u7', heads: 2 }]],
  ])('saves companions from the confirmation draft', async (companions, expected) => {
    captureTelegram();
    const state = { payload: { ...completePayload(), companions }, pending: null };
    await handleBookingCallback({ BOT_TOKEN: 'test', DB: draftDb(state) }, confirmTap('bw:1:y'));
    expect(state.roster).toEqual(expected);
    expect(state.deleted).toBe(true);
  });

  it('refuses the booker picker to a non-admin', async () => {
    const requests = captureTelegram();
    const state = {
      payload: completePayload(), pending: null,
      conflict: false, inserted: false, deleted: false,
    };
    await handleBookingCallback(
      { BOT_TOKEN: 'test', DB: draftDb(state) }, confirmTap('bw:1:x:b')
    );
    const answer = requests.find((request) => request.url.endsWith('/answerCallbackQuery'));
    expect(answer.body.text).toBe('Only group admins can book for someone else.');
    expect(state.payload.choosingBooker).not.toBe(true);
  });

  it('refuses to save an edit to a court that started while the form was open', async () => {
    const requests = captureTelegram();
    const payload = {
      ...completePayload(), operation: 'edit', bookingId: 3, editSourceText: 'date: tomorrow',
    };
    const state = {
      payload, pending: null, conflict: false, updated: false, deleted: false,
      // Started half an hour ago, still running: the hour everybody on it is
      // billed for, and the charge is not written until it expires.
      booking: {
        id: 3, chat_id: -123, court: '4', created_by_user_id: 7,
        starts_at: Date.now() - 30 * 60 * 1000,
        ends_at: Date.now() + 30 * 60 * 1000,
      },
    };
    await handleBookingCallback(
      { BOT_TOKEN: 'test', DB: draftDb(state) }, confirmTap('bw:1:y')
    );
    const answer = requests.find((request) => request.url.endsWith('/answerCallbackQuery'));
    expect(answer.body.text)
      .toBe('That court has already started, so only a group admin can change it.');
    // Moving it to another day and cancelling it there is how the bill was lost.
    expect(state.updated).toBe(false);
  });

  it('surfaces a conflict for review, then saves on Add anyway', async () => {
    const requests = captureTelegram();
    const state = {
      payload: completePayload(), pending: null,
      conflict: true, inserted: false, deleted: false,
    };
    const env = { BOT_TOKEN: 'test', DB: draftDb(state) };

    await handleBookingCallback(env, confirmTap('bw:1:y'));
    const firstAnswer = requests.find((request) => request.url.endsWith('/answerCallbackQuery'));
    expect(firstAnswer.body.text)
      .toBe('This overlaps another booking. Confirm again to continue.');
    // The conflict is stored on the draft and the claim is handed back, so the
    // re-rendered form's Add anyway button has a live path through.
    expect(state.payload.conflicts).toHaveLength(1);
    expect(state.pending).toBe(null);
    expect(state.inserted).toBe(false);
    const redraw = requests.find((request) => request.url.endsWith('/editEphemeralMessageText'));
    expect(redraw.body.text).toContain('This overlaps an existing booking');
    expect(JSON.stringify(redraw.body.reply_markup)).toContain('bw:1:o');

    requests.length = 0;
    await handleBookingCallback(env, confirmTap('bw:1:o'));
    expect(state.inserted).toBe(true);
    expect(state.deleted).toBe(true);
    // The finished form takes itself down; the toast is the confirmation.
    expect(requests.some((request) => request.url.endsWith('/deleteEphemeralMessage'))).toBe(true);
    const secondAnswer = requests.find((request) => request.url.endsWith('/answerCallbackQuery'));
    expect(secondAnswer.body.text).toBe('✅ Booking added');
  });
});

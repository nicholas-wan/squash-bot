import { afterEach, describe, expect, it, vi } from 'vitest';
import { addBooking, cancelBooking } from '../src/bookings.js';

const startsAt = Date.UTC(2026, 7, 19, 13, 0);
const endsAt = Date.UTC(2026, 7, 19, 14, 0);
const storedBooking = {
  id: 3, chat_id: -123, court: '4', starts_at: startsAt, ends_at: endsAt,
};

function bookingDb(activeBookings) {
  return {
    prepare(sql) {
      return {
        bind() {
          return {
            async first() {
              if (sql.includes('SELECT tz')) return { tz: 'Asia/Singapore' };
              if (sql.includes('SELECT board_message_id')) return { board_message_id: 55 };
              if (sql.includes('SELECT * FROM bookings WHERE id')) return storedBooking;
              return null;
            },
            async all() {
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

  it('announces a successful addition to the whole group', async () => {
    const requests = captureTelegram();
    await addBooking({ BOT_TOKEN: 'test', DB: bookingDb([storedBooking]) }, -123, {
      court: '4', startsAt, endsAt, reminderAt: startsAt - 3600000,
    }, { id: 7, first_name: 'Nick' });
    const announcement = requests.find((request) => request.url.endsWith('/sendMessage'));
    expect(announcement.body.text).toContain('Court 4 booked');
    expect(announcement.body).not.toHaveProperty('receiver_user_id');
  });

  it('announces a successful removal to the whole group', async () => {
    const requests = captureTelegram();
    await cancelBooking({ BOT_TOKEN: 'test', DB: bookingDb([]) }, -123, 3);
    const announcement = requests.find((request) => request.url.endsWith('/sendMessage'));
    expect(announcement.body.text).toContain('Court 4 removed');
    expect(announcement.body).not.toHaveProperty('receiver_user_id');
  });
});

import { describe, expect, it, vi, afterEach } from 'vitest';
import { addBooking } from '../src/bookings.js';
import { boardChats, dataChatId, reachableChat } from '../src/scope.js';

const GROUP_A = -1004418632524;
const GROUP_B = -984202118;
const shared = { ALLOWED_CHATS: `${GROUP_A},${GROUP_B}`, DATA_CHAT_ID: String(GROUP_A) };
const separate = { ALLOWED_CHATS: `${GROUP_A},${GROUP_B}` };

describe('shared data across groups', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('stores every row under one chat id when sharing is on', () => {
    expect(dataChatId(shared, GROUP_B)).toBe(GROUP_A);
    expect(dataChatId(shared, GROUP_A)).toBe(GROUP_A);
  });

  it('keeps each chat on its own data when sharing is off', () => {
    expect(dataChatId(separate, GROUP_B)).toBe(GROUP_B);
    expect(boardChats(separate, GROUP_B)).toEqual([GROUP_B]);
  });

  it('shows the board, tab, and announcements in every sharing group', () => {
    expect(boardChats(shared, GROUP_B)).toEqual([GROUP_A, GROUP_B]);
  });

  it('reminds a player in the group they joined from', () => {
    expect(reachableChat(shared, { chat_id: GROUP_B }, GROUP_A)).toBe(GROUP_B);
    // A chat that is no longer allowed falls back to the shared one.
    expect(reachableChat(shared, { chat_id: -55 }, GROUP_A)).toBe(GROUP_A);
  });

  it('writes a booking made in one group under the shared id and updates both boards', async () => {
    const requests = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 5 } }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }));
    const inserted = [];
    const db = {
      prepare(sql) {
        return {
          bind(...args) {
            return {
              async first() {
                if (sql.includes('SELECT tz')) return { tz: 'Asia/Singapore' };
                if (sql.includes('board_message_id')) return { board_message_id: 55 };
                return null;
              },
              async all() {
                if (sql.includes('FROM booking_players')) return { results: [] };
                return { results: sql.includes('ends_at >') ? [{
                  id: 3, chat_id: GROUP_A, court: '4', capacity: 3,
                  starts_at: Date.UTC(2026, 7, 19, 13, 0),
                  ends_at: Date.UTC(2026, 7, 19, 14, 0),
                }] : [] };
              },
              async run() {
                if (sql.startsWith('INSERT INTO bookings')) {
                  inserted.push(args);
                  return { meta: { changes: 1, last_row_id: 3 } };
                }
                return { meta: { changes: 1 } };
              },
            };
          },
        };
      },
    };
    const startsAt = Date.UTC(2026, 7, 19, 13, 0);
    await addBooking({ ...shared, BOT_TOKEN: 'test', DB: db }, GROUP_B, {
      court: '4', startsAt, endsAt: startsAt + 3600000, reminderAt: startsAt - 3600000,
    }, { id: 9, username: 'alice' });

    // Booked from group B, but stored under group A's id so both groups see it.
    expect(inserted[0][0]).toBe(GROUP_A);
    // Both pinned boards are rewritten; the receipt goes only to the booker,
    // only in the group they booked from.
    const boards = requests.filter((request) => request.url.endsWith('/editMessageText'));
    expect(boards.map((request) => request.body.chat_id)).toEqual([GROUP_A, GROUP_B]);
    const receipts = requests.filter(
      (request) => request.url.endsWith('/sendMessage')
        && String(request.body.text).includes('booked')
    );
    expect(receipts).toHaveLength(1);
    expect(receipts[0].body.chat_id).toBe(GROUP_B);
    expect(receipts[0].body.receiver_user_id).toBe(9);
  });
});

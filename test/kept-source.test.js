import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleUpdate } from '../src/index.js';
import { clearAdminCache } from '../src/players.js';
import { d1, schemaDb } from './d1.js';

// The message a booking is typed in stays until its form is confirmed, the
// same as a /chore in nag-bot: the typer can check the form against it.
describe('The typed booking message', () => {
  const CHAT = -123456789;
  const nick = { id: 7, first_name: 'Nick' };
  let sql, env, requests;

  beforeEach(() => {
    sql = schemaDb();
    env = { BOT_TOKEN: 'test-token', ALLOWED_CHATS: String(CHAT), DB: d1(sql) };
    requests = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(init.body) });
      const result = String(url).endsWith('/getChatMember')
        ? { status: 'creator' }
        : { message_id: 100, ephemeral_message_id: 12 };
      return new Response(JSON.stringify({ ok: true, result }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }));
  });
  afterEach(() => {
    sql.close();
    vi.unstubAllGlobals();
    clearAdminCache();
  });

  const deleted = () => requests
    .filter((request) => request.url.endsWith('/deleteMessage'))
    .map((request) => request.body.message_id);
  const post = (text) => handleUpdate(env, {
    message: { message_id: 5, chat: { id: CHAT }, from: nick, text },
  });
  const tap = (data, from = nick) => handleUpdate(env, {
    callback_query: {
      id: `cb-${data}`, data, from,
      message: { message_id: 0, ephemeral_message_id: 12, chat: { id: CHAT } },
    },
  });
  const draftId = () => sql.prepare('SELECT id FROM booking_drafts').get().id;

  for (const text of ['20 Aug 2027 Court 4 9pm', '/book 20 Aug 2027 c4 9pm']) {
    it(`stays while the form is open and goes on Confirm: ${text}`, async () => {
      await post(text);
      expect(deleted()).toEqual([]);
      // On the sweep from the start, so an abandoned form still takes it.
      expect(sql.prepare(
        'SELECT receiver_user_id FROM sent_messages WHERE message_id = 5 AND is_ephemeral = 0'
      ).get()).toEqual({ receiver_user_id: 7 });

      await tap(`bw:${draftId()}:y`);
      expect(sql.prepare('SELECT COUNT(*) AS n FROM bookings').get().n).toBe(1);
      expect(deleted()).toEqual([5]);
      expect(sql.prepare('SELECT COUNT(*) AS n FROM sent_messages WHERE message_id = 5').get().n)
        .toBe(0);
    });
  }

  it('stays after Cancel until the notice’s OK, which only its typer can use', async () => {
    await post('20 Aug 2027 Court 4 9pm');
    await tap(`bw:${draftId()}:n`);
    expect(deleted()).toEqual([]);
    const notice = requests.find((request) => String(request.body.text).includes('Booking cancelled'));
    expect(notice.body.text).toContain('Booking cancelled');
    expect(notice.body.reply_markup.inline_keyboard[0][0].callback_data).toBe('sb:ok:5');

    // Somebody else naming it in hand-sent callback data gets nothing deleted.
    await tap('sb:ok:5', { id: 8, first_name: 'Other' });
    expect(deleted()).toEqual([]);

    await tap('sb:ok:5');
    expect(deleted()).toEqual([5]);
  });

  it('goes when the booking is typed again', async () => {
    await post('20 Aug 2027 Court 4 9pm');
    await handleUpdate(env, {
      message: { message_id: 6, chat: { id: CHAT }, from: nick, text: '20 Aug 2027 Court 5 9pm' },
    });
    expect(deleted()).toEqual([5]);
  });
});

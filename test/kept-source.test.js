import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleUpdate } from '../src/index.js';
import { clearAdminCache } from '../src/players.js';
import { d1, schemaDb } from './d1.js';

// The message a booking is typed in goes as soon as its private form opens.
// The form quotes it, so the typer can still check the form against it, and
// the group is not left holding it. Until 26 Nov 2026 it stayed until Confirm.
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
  const post = (text, messageId = 5) => handleUpdate(env, {
    message: { message_id: messageId, chat: { id: CHAT }, from: nick, text },
  });
  const tap = (data, from = nick) => handleUpdate(env, {
    callback_query: {
      id: `cb-${data}`, data, from,
      message: { message_id: 0, ephemeral_message_id: 12, chat: { id: CHAT } },
    },
  });
  const draftId = () => sql.prepare('SELECT id FROM booking_drafts').get().id;

  for (const text of ['20 Aug 2027 Court 4 9pm', '/book 20 Aug 2027 c4 9pm']) {
    it(`goes as the form opens, which quotes it: ${text}`, async () => {
      await post(text);
      expect(deleted()).toEqual([5]);
      const form = requests.find((request) => request.url.endsWith('/sendMessage'));
      expect(form.body.text).toContain('From: <code>');
      expect(form.body.text).toContain('20 Aug 2027');
      expect(sql.prepare('SELECT source_message_id FROM booking_drafts').get())
        .toEqual({ source_message_id: null });
      expect(sql.prepare(
        'SELECT COUNT(*) AS n FROM sent_messages WHERE message_id = 5'
      ).get().n).toBe(0);

      await tap(`bw:${draftId()}:y`);
      expect(sql.prepare('SELECT COUNT(*) AS n FROM bookings').get().n).toBe(1);
      expect(deleted()).toEqual([5]);
    });
  }

  it('is already gone after Cancel, so the notice’s OK only clears the notice', async () => {
    await post('20 Aug 2027 Court 4 9pm');
    await tap(`bw:${draftId()}:n`);
    const notice = requests.find((request) => String(request.body.text).includes('Booking cancelled'));
    expect(notice.body.reply_markup.inline_keyboard[0][0].callback_data).toBe('sb:ok');
    await tap('sb:ok');
    expect(deleted()).toEqual([5]);
  });

  it('goes each time the booking is typed again', async () => {
    await post('20 Aug 2027 Court 4 9pm');
    await post('20 Aug 2027 Court 5 9pm', 6);
    expect(deleted()).toEqual([5, 6]);
  });

  it('is left alone from a member, with no form', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(init.body) });
      const result = String(url).endsWith('/getChatMember')
        ? { status: 'member' }
        : { message_id: 100, ephemeral_message_id: 12 };
      return new Response(JSON.stringify({ ok: true, result }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }));
    await post('20 Aug 2027 Court 4 9pm');
    expect(deleted()).toEqual([]);
    expect(sql.prepare('SELECT COUNT(*) AS n FROM booking_drafts').get().n).toBe(0);
  });
});

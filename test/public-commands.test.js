import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleUpdate } from '../src/index.js';
import { clearAdminCache } from '../src/players.js';
import { clearBotUsernameCache } from '../src/telegram.js';
import { d1, schemaDb } from './d1.js';

// Commands are registered without is_ephemeral, so each one arrives as an
// ordinary group message with a real message_id. Every one the bot answers
// must be taken out of the group, and every answer must still go to the
// sender alone — never as a reply to the command, which is about to be gone.
describe('A command sent as a group message', () => {
  const CHAT = -123456789;
  const nick = { id: 7, first_name: 'Nick', username: 'nicholaswan' };
  let sql, env, requests, role, deleteWorks, nextEphemeral;

  beforeEach(() => {
    sql = schemaDb();
    env = { BOT_TOKEN: 'test-token', ALLOWED_CHATS: String(CHAT), DB: d1(sql) };
    requests = [];
    role = 'creator';
    deleteWorks = true;
    nextEphemeral = 500;
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      const method = String(url).split('/').pop();
      const body = JSON.parse(init.body);
      requests.push({ method, body });
      let reply = { ok: true, result: true };
      if (method === 'getMe') reply.result = { id: 1, username: 'squash_book_bot' };
      if (method === 'getChatMember') reply.result = { status: role, user: { id: body.user_id } };
      if (method === 'sendMessage') {
        reply.result = body.ephemeral_message_parameters
          ? { message_id: 0, ephemeral_message_id: nextEphemeral++ }
          : { message_id: 900 + requests.length };
      }
      if (method === 'deleteMessage' && !deleteWorks) {
        reply = { ok: false, error_code: 400, description: "Bad Request: message can't be deleted" };
      }
      return new Response(JSON.stringify(reply), { headers: { 'Content-Type': 'application/json' } });
    }));
  });
  afterEach(() => {
    sql.close();
    vi.unstubAllGlobals();
    clearAdminCache();
    clearBotUsernameCache();
  });

  const post = (text, messageId = 5) => handleUpdate(env, {
    message: { message_id: messageId, chat: { id: CHAT }, from: nick, text },
  });
  const tap = (data) => handleUpdate(env, {
    callback_query: {
      id: `cb-${data}`, data, from: nick,
      message: { message_id: 0, ephemeral_message_id: 12, chat: { id: CHAT } },
    },
  });
  const deletes = () => requests.filter((r) => r.method === 'deleteMessage')
    .map((r) => [r.body.chat_id, r.body.message_id]);
  const sends = () => requests.filter((r) => r.method === 'sendMessage');
  const draftId = () => sql.prepare('SELECT id FROM booking_drafts').get().id;

  // Nothing the bot says about a command may land in the group, and nothing
  // may be threaded onto the command: a reply to a deleted message fails.
  function expectAnsweredPrivately() {
    expect(sends().length).toBeGreaterThan(0);
    for (const send of sends()) {
      expect(send.body.chat_id).toBe(CHAT);
      expect(send.body.ephemeral_message_parameters).toEqual({ receiver_user_id: 7 });
      expect(send.body.reply_parameters).toBeUndefined();
    }
  }

  const cleared = [
    ['/help', 'SquashBot'],
    ['/start', 'SquashBot'],
    ['/help@squash_book_bot', 'SquashBot'],
    ['/HELP@Squash_Book_Bot', 'SquashBot'],
    ['/help, please', 'SquashBot'],
    ['/courts', 'Nothing is booked right now'],
    ['/courts@squash_book_bot', 'Nothing is booked right now'],
    ['/tab', 'Nothing outstanding'],
    ['/cancel', 'Use <code>/cancel ID</code>'],
    ['/cancel abc', 'Use <code>/cancel ID</code>'],
    ['/cancel 42', "couldn't find booking <b>#42</b>"],
    ['/debt', 'Use <code>/debt +AMOUNT'],
    ['/debt +2 nobody ice cream', "I don't know <b>nobody</b>"],
    ['/debt undo', 'no /debt entry from the last 7 days'],
  ];
  for (const [text, answer] of cleared) {
    it(`is deleted once and answered privately: ${text}`, async () => {
      await post(text);
      expect(deletes()).toEqual([[CHAT, 5]]);
      expectAnsweredPrivately();
      expect(sends().map((s) => s.body.text).join('\n')).toContain(answer);
      // Nothing about the command itself waits on the sweep: it is gone.
      expect(sql.prepare('SELECT COUNT(*) AS n FROM sent_messages WHERE message_id = 5').get().n)
        .toBe(0);
    });
  }

  it('is deleted for a member too, even when the command is refused', async () => {
    role = 'member';
    await post('/debt +2 jared ice cream');
    expect(deletes()).toEqual([[CHAT, 5]]);
    expectAnsweredPrivately();
    expect(sends()[0].body.text).toContain('Only group admins');
  });

  it('says so privately when it lacks the right to delete, and does not retry blindly', async () => {
    deleteWorks = false;
    await post('/courts');
    expect(deletes()).toEqual([[CHAT, 5]]);
    expectAnsweredPrivately();
    const texts = sends().map((s) => s.body.text).join('\n');
    expect(texts).toContain('Your command is still in the group');
    expect(texts).toContain('<b>Delete Messages</b>');
    // The refresh still did its job and said so.
    expect(texts).toContain('Nothing is booked right now');
  });

  it('leaves alone a command meant for another bot', async () => {
    await post('/cancel@other_bot 3');
    await post('/help@other_bot', 6);
    expect(deletes()).toEqual([]);
    expect(sends()).toEqual([]);
  });

  it('leaves an unknown command where it is, since it may be another bot’s', async () => {
    await post('/kick someone');
    expect(deletes()).toEqual([]);
    expectAnsweredPrivately();
    expect(sends()[0].body.text).toContain("I don't know <code>/kick</code>");
  });

  it('leaves ordinary chat alone', async () => {
    await post('see you all tonight');
    expect(deletes()).toEqual([]);
    expect(sends()).toEqual([]);
  });

  describe('/book', () => {
    it('stays while its form is open, on the sweep, and goes on Confirm', async () => {
      await post('/book 20 Aug 2027 c4 9pm');
      expect(deletes()).toEqual([]);
      expectAnsweredPrivately();
      expect(sql.prepare(
        'SELECT receiver_user_id, is_ephemeral FROM sent_messages WHERE message_id = 5'
      ).get()).toEqual({ receiver_user_id: 7, is_ephemeral: 0 });

      await tap(`bw:${draftId()}:y`);
      expect(sql.prepare('SELECT COUNT(*) AS n FROM bookings').get().n).toBe(1);
      expect(deletes()).toContainEqual([CHAT, 5]);
      expect(deletes().filter(([, id]) => id === 5)).toHaveLength(1);
      expect(sql.prepare('SELECT COUNT(*) AS n FROM sent_messages WHERE message_id = 5').get().n)
        .toBe(0);
    });

    it('with @handles and a court, like the one in the screenshot, goes on Confirm', async () => {
      await post('/book@squash_book_bot 20 Aug 2027 9pm @wsthang c3');
      expect(deletes()).toEqual([]);
      await tap(`bw:${draftId()}:y`);
      expect(deletes().filter(([, id]) => id === 5)).toHaveLength(1);
      const booked = sql.prepare('SELECT court FROM bookings').get();
      expect(String(booked.court)).toContain('3');
    });

    it('stays after Cancel until the notice’s OK clears it', async () => {
      await post('/book 20 Aug 2027 c4 9pm');
      await tap(`bw:${draftId()}:n`);
      expect(deletes()).toEqual([]);
      await tap('sb:ok:5');
      expect(deletes()).toEqual([[CHAT, 5]]);
    });

    it('takes the old one down when /book is sent again', async () => {
      await post('/book 20 Aug 2027 c4 9pm');
      await post('/book 20 Aug 2027 c5 9pm', 6);
      expect(deletes()).toEqual([[CHAT, 5]]);
    });

    it('is cleared at once, wording handed back, when the form cannot open', async () => {
      let failForm = true;
      const real = globalThis.fetch;
      vi.stubGlobal('fetch', vi.fn(async (url, init) => {
        const body = JSON.parse(init.body);
        if (failForm && String(url).endsWith('/sendMessage') && /Add booking/.test(JSON.stringify(body.reply_markup || ''))) {
          failForm = false;
          requests.push({ method: 'sendMessage', body });
          return new Response(JSON.stringify({ ok: false, description: 'Bad Request: boom' }),
            { headers: { 'Content-Type': 'application/json' } });
        }
        return real(url, init);
      }));
      vi.spyOn(console, 'log').mockImplementation(() => {});
      await post('/book 20 Aug 2027 c4 9pm');
      expect(deletes()).toEqual([[CHAT, 5]]);
      const handedBack = sends().at(-1);
      expect(handedBack.body.ephemeral_message_parameters).toEqual({ receiver_user_id: 7 });
      expect(handedBack.body.reply_parameters).toBeUndefined();
      expect(handedBack.body.text).toContain('/book 20 Aug 2027 c4 9pm');
      expect(sql.prepare('SELECT COUNT(*) AS n FROM booking_drafts').get().n).toBe(0);
    });
  });

  it('/cancel of a real booking deletes the command and keeps the receipt private', async () => {
    await post('/book 20 Aug 2027 c4 9pm');
    await tap(`bw:${draftId()}:y`);
    const id = sql.prepare('SELECT id FROM bookings').get().id;
    requests.length = 0;
    await post(`/cancel ${id}`, 6);
    expect(deletes()).toContainEqual([CHAT, 6]);
    expect(deletes().filter(([, m]) => m === 6)).toHaveLength(1);
    const receipt = sends().find((s) => String(s.body.text).includes(`Removed booking <b>#${id}</b>`));
    expect(receipt.body.ephemeral_message_parameters).toEqual({ receiver_user_id: 7 });
    expect(receipt.body.reply_parameters).toBeUndefined();
    expect(sql.prepare('SELECT COUNT(*) AS n FROM bookings WHERE id = ?').get(id).n).toBe(0);
  });

  it('still answers a command from a client holding the old ephemeral menu', async () => {
    await handleUpdate(env, {
      message: {
        message_id: 0, ephemeral_message_id: 88, chat: { id: CHAT }, from: nick, text: '/courts',
      },
    });
    expect(deletes()).toEqual([]);
    const reply = sends()[0];
    expect(reply.body.ephemeral_message_parameters).toEqual({ receiver_user_id: 7 });
    expect(reply.body.reply_parameters).toEqual({ ephemeral_message_id: 88 });
  });
});

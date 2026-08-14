import { afterEach, describe, expect, it, vi } from 'vitest';
import worker, { handleUpdate } from '../src/index.js';

function emptyDb() {
  return {
    prepare() {
      return {
        bind() {
          return {
            async first() { return null; },
            async all() { return { results: [] }; },
            async run() { return { meta: { changes: 0 } }; },
          };
        },
      };
    },
  };
}

describe('Telegram commands', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('responds to /help addressed to the bot username', async () => {
    const requests = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }));
    await handleUpdate({
      BOT_TOKEN: 'test-token', ALLOWED_CHATS: '-123456789', DB: emptyDb(),
    }, {
      message: {
        message_id: 5,
        chat: { id: -123456789 },
        from: { id: 7, first_name: 'Nick' },
        text: '/help@squash_book_bot',
      },
    });
    const send = requests.find((request) => request.url.endsWith('/sendMessage'));
    expect(send.body.text).toContain('<b>SquashBot</b>');
    expect(send.body.receiver_user_id).toBe(7);
    const removed = requests.find((request) => request.url.endsWith('/deleteMessage'));
    expect(removed.body.message_id).toBe(5);
  });

  it('leaves an ephemeral command alone, having nothing it can delete', async () => {
    const requests = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }));
    await handleUpdate({
      BOT_TOKEN: 'test-token', ALLOWED_CHATS: '-123456789', DB: emptyDb(),
    }, {
      message: {
        message_id: 5,
        ephemeral_message_id: 88,
        chat: { id: -123456789 },
        from: { id: 7, first_name: 'Nick' },
        text: '/courts@squash_book_bot',
      },
    });
    // Telegram leaves an ephemeral command in the chat until the app closes,
    // so it is cleared through the ephemeral API rather than deleteMessage.
    // Telegram answers MESSAGE_NOT_FOUND for a message the bot did not write,
    // so attempting either delete only costs a request and logs a failure.
    expect(requests.some((request) => request.url.endsWith('/deleteEphemeralMessage')))
      .toBe(false);
    expect(requests.some((request) => request.url.endsWith('/deleteMessage'))).toBe(false);
  });

  it('opens the booking manager privately, never on the pinned message', async () => {
    const requests = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(init.body) });
      return new Response(JSON.stringify({
        ok: true, result: { ephemeral_message_id: 12 },
      }), { headers: { 'Content-Type': 'application/json' } });
    }));
    await handleUpdate({
      BOT_TOKEN: 'test-token', ALLOWED_CHATS: '-123456789', DB: emptyDb(),
    }, {
      callback_query: {
        id: 'callback-1', data: 'sb:manage',
        from: { id: 7, first_name: 'Nick' },
        message: { message_id: 5, chat: { id: -123456789 } },
      },
    });
    // Editing the pinned message would show one person's panel to the group.
    expect(requests.some((request) => request.url.endsWith('/editMessageReplyMarkup')))
      .toBe(false);
    const send = requests.find((request) => request.url.endsWith('/sendMessage'));
    expect(send.body.receiver_user_id).toBe(7);
    expect(send.body.text).toContain('Manage bookings');
  });

  it('links help to the current pinned court board', async () => {
    const requests = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ ok: true, result: { ephemeral_message_id: 12 } }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }));
    const db = {
      prepare() {
        return { bind() { return { async first() { return { board_message_id: 20 }; } }; } };
      },
    };
    await handleUpdate({ BOT_TOKEN: 'test-token', ALLOWED_CHATS: '-1004418632524', DB: db }, {
      message: {
        ephemeral_message_id: 8,
        chat: { id: -1004418632524 },
        from: { id: 7, first_name: 'Nick' },
        text: '/help',
      },
    });
    const send = requests.find((request) => request.url.endsWith('/sendMessage'));
    expect(send.body.reply_markup.inline_keyboard[0][0].url)
      .toBe('https://t.me/c/4418632524/20');
  });

  it('always asks for confirmation before saving a complete message', async () => {
    const requests = [];
    const sqlSeen = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(init.body) });
      return new Response(JSON.stringify({
        ok: true, result: { ephemeral_message_id: 12 },
      }), { headers: { 'Content-Type': 'application/json' } });
    }));
    const db = {
      prepare(sql) {
        sqlSeen.push(sql);
        return { bind() { return {
          async first() {
            return sql.includes('SELECT tz') ? { tz: 'Asia/Singapore' } : null;
          },
          async run() {
            if (sql.includes('INSERT INTO booking_drafts')) {
              return { meta: { changes: 1, last_row_id: 41 } };
            }
            return { meta: { changes: 1 } };
          },
        }; } };
      },
    };
    await handleUpdate({
      BOT_TOKEN: 'test-token', ALLOWED_CHATS: '-123456789', DB: db,
    }, {
      message: {
        message_id: 5,
        chat: { id: -123456789 },
        from: { id: 7, first_name: 'Nick' },
        text: '20 Aug 2026 Court 4 9pm',
      },
    });
    const send = requests.find((request) => request.url.endsWith('/sendMessage'));
    expect(send.body.text).toContain('Confirm this squash booking');
    const labels = send.body.reply_markup.inline_keyboard.flat().map((button) => button.text);
    expect(labels).toContain('✅ Add booking');
    expect(sqlSeen.some((sql) => sql.includes('INSERT INTO bookings'))).toBe(false);
    // The booking text itself is cleared out of the group.
    const removed = requests.find((request) => request.url.endsWith('/deleteMessage'));
    expect(removed.body.message_id).toBe(5);
  });

  it('clears the booking message even when the form fails to open', async () => {
    const requests = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(init.body) });
      // Telegram refusing the form used to leave the booking text in the group.
      const failed = String(url).endsWith('/sendMessage')
        && JSON.parse(init.body).text.includes('Confirm this squash booking');
      return new Response(JSON.stringify(failed
        ? { ok: false, description: 'Bad Request' }
        : { ok: true, result: { ephemeral_message_id: 12 } }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }));
    const db = {
      prepare(sql) {
        return { bind() { return {
          async first() {
            return sql.includes('SELECT tz') ? { tz: 'Asia/Singapore' } : null;
          },
          async run() {
            if (sql.includes('INSERT INTO booking_drafts')) {
              return { meta: { changes: 1, last_row_id: 41 } };
            }
            return { meta: { changes: 1 } };
          },
        }; } };
      },
    };
    await handleUpdate({
      BOT_TOKEN: 'test-token', ALLOWED_CHATS: '-123456789', DB: db,
    }, {
      message: {
        message_id: 5,
        chat: { id: -123456789 },
        from: { id: 7, first_name: 'Nick' },
        text: '20 Aug 2026 Court 4 9pm',
      },
    });
    const removed = requests.find((request) => request.url.endsWith('/deleteMessage'));
    expect(removed.body.message_id).toBe(5);
  });

  it('says so when it lacks the right to delete the booking message', async () => {
    const requests = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(init.body) });
      return new Response(JSON.stringify(String(url).endsWith('/deleteMessage')
        ? { ok: false, description: 'not enough rights' }
        : { ok: true, result: { ephemeral_message_id: 12 } }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }));
    const db = {
      prepare(sql) {
        return { bind() { return {
          async first() {
            return sql.includes('SELECT tz') ? { tz: 'Asia/Singapore' } : null;
          },
          async run() {
            if (sql.includes('INSERT INTO booking_drafts')) {
              return { meta: { changes: 1, last_row_id: 41 } };
            }
            return { meta: { changes: 1 } };
          },
        }; } };
      },
    };
    await handleUpdate({
      BOT_TOKEN: 'test-token', ALLOWED_CHATS: '-123456789', DB: db,
    }, {
      message: {
        message_id: 5,
        chat: { id: -123456789 },
        from: { id: 7, first_name: 'Nick' },
        text: '20 Aug 2026 Court 4 9pm',
      },
    });
    const warning = requests.find((request) => request.url.endsWith('/sendMessage')
      && request.body.text.includes('Delete Messages'));
    expect(warning.body.receiver_user_id).toBe(7);
  });

  it('leaves nothing behind in the chat once a booking is saved', async () => {
    const requests = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }));
    const draft = {
      id: 41, chat_id: -123456789, user_id: 7, user_name: '@nick',
      wizard_message_id: 12, wizard_ephemeral: 1,
      payload: JSON.stringify({
        operation: 'add', bookingId: null, sourceText: '20 Aug 2026 Court 4 9pm',
        date: { y: 2026, mo: 8, d: 20 }, court: '4', start: { h: 21, mi: 0 }, end: null,
        dateChoices: [], courtChoices: [], timeChoices: [], issues: [], conflicts: [],
      }),
    };
    const db = {
      prepare(sql) {
        return { bind() { return {
          async first() {
            if (sql.includes('SELECT tz')) return { tz: 'Asia/Singapore' };
            if (sql.includes('FROM booking_drafts')) return draft;
            return null;
          },
          async all() { return { results: [] }; },
          async run() { return { meta: { changes: 1, last_row_id: 3 } }; },
        }; } };
      },
    };
    await handleUpdate({
      BOT_TOKEN: 'test-token', ALLOWED_CHATS: '-123456789', DB: db,
    }, {
      callback_query: {
        id: 'callback-1', data: 'bw:41:y',
        from: { id: 7, username: 'nick' },
        message: { message_id: 12, chat: { id: -123456789 } },
      },
    });
    // The form is removed rather than rewritten to a confirmation message.
    const removed = requests.find(
      (request) => request.url.endsWith('/deleteEphemeralMessage')
    );
    expect(removed.body.ephemeral_message_id).toBe(12);
    const texts = requests
      .filter((request) => request.url.endsWith('/editEphemeralMessageText'))
      .map((request) => request.body.text);
    expect(texts).toHaveLength(0);
    const answer = requests.find((request) => request.url.endsWith('/answerCallbackQuery'));
    expect(answer.body.text).toBe('✅ Booking added');
  });

  it('logs the id of any chat it ignores so a new group can be identified', async () => {
    const logged = [];
    vi.spyOn(console, 'log').mockImplementation((line) => logged.push(line));
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('an ignored chat must not reach Telegram');
    }));
    await handleUpdate({
      BOT_TOKEN: 'test-token', ALLOWED_CHATS: '-123456789', DB: emptyDb(),
    }, {
      message: {
        message_id: 5,
        chat: { id: -1009999999999, title: 'Squash crew' },
        from: { id: 7, first_name: 'Nick' },
        text: 'hello',
      },
    });
    expect(logged.join('\n')).toContain('Ignored update from chat -1009999999999 "Squash crew"');
    vi.restoreAllMocks();
  });

  it('lets a member join a booking from the pinned board', async () => {
    const requests = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 55 } }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }));
    const booking = {
      id: 3, chat_id: -123456789, court: '4', capacity: 3,
      starts_at: Date.UTC(2026, 7, 19, 13, 0), ends_at: Date.UTC(2026, 7, 19, 14, 0),
    };
    const db = {
      prepare(sql) {
        return { bind() { return {
          async first() {
            if (sql.includes('SELECT tz')) return { tz: 'Asia/Singapore' };
            if (sql.includes('board_message_id')) return { board_message_id: 55 };
            if (sql.includes('SELECT * FROM bookings WHERE id')) return booking;
            return null;
          },
          async all() {
            if (sql.includes('FROM booking_players')) return { results: [] };
            return { results: sql.includes('ends_at >') ? [booking] : [] };
          },
          async run() {
            return { meta: { changes: sql.startsWith('DELETE FROM booking_players') ? 0 : 1 } };
          },
        }; } };
      },
    };
    await handleUpdate({ BOT_TOKEN: 'test-token', ALLOWED_CHATS: '-123456789', DB: db }, {
      callback_query: {
        id: 'callback-1', data: 'sb:join:3',
        from: { id: 11, username: 'alice' },
        message: { message_id: 55, chat: { id: -123456789 } },
      },
    });
    const answer = requests.find((request) => request.url.endsWith('/answerCallbackQuery'));
    expect(answer.body.text).toContain('You are in');
    const board = requests.find((request) => request.url.endsWith('/editMessageText'));
    expect(board.body.message_id).toBe(55);
    // The board keeps one compact row; picking a court happens behind Join.
    // One row, whatever the board holds. Choosing a court happens behind Join.
    expect(board.body.reply_markup.inline_keyboard).toHaveLength(1);
    expect(board.body.reply_markup.inline_keyboard[0].map((button) => button.callback_data))
      .toEqual(['sb:join', 'sb:add', 'sb:manage']);
  });

  it('toggles one shared court button by who tapped it', async () => {
    const booking = {
      id: 3, chat_id: -123456789, court: '4', capacity: 3,
      starts_at: Date.UTC(2026, 7, 19, 13, 0), ends_at: Date.UTC(2026, 7, 19, 14, 0),
    };
    const run = async (roster) => {
      const requests = [];
      const ran = [];
      vi.stubGlobal('fetch', vi.fn(async (url, init) => {
        requests.push({ url: String(url), body: JSON.parse(init.body) });
        return new Response(JSON.stringify({ ok: true, result: { message_id: 55 } }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }));
      const db = {
        prepare(sql) {
          ran.push(sql);
          return { bind() { return {
            async first() {
              if (sql.includes('SELECT tz')) return { tz: 'Asia/Singapore' };
              if (sql.includes('SELECT * FROM bookings WHERE id')) return booking;
              return null;
            },
            async all() {
              if (sql.includes('FROM booking_players')) return { results: roster };
              return { results: sql.includes('ends_at >') ? [booking] : [] };
            },
            async run() { return { meta: { changes: 1 } }; },
          }; } };
        },
      };
      await handleUpdate({ BOT_TOKEN: 'test-token', ALLOWED_CHATS: '-123456789', DB: db }, {
        callback_query: {
          id: 'callback-1', data: 'sb:tap:3',
          from: { id: 11, username: 'alice' },
          message: { message_id: 55, chat: { id: -123456789 } },
        },
      });
      const answer = requests.find((request) => request.url.endsWith('/answerCallbackQuery'));
      return { text: answer.body.text, ran, requests };
    };

    // Same button, same callback_data — the tapper decides which way it goes.
    const joining = await run([]);
    expect(joining.text).toContain('You are in');
    expect(joining.ran.some((sql) => sql.startsWith('INSERT OR IGNORE INTO booking_players')))
      .toBe(true);

    const leaving = await run([
      { id: 1, booking_id: 3, slug: '@alice', name: '@alice', user_id: 11 },
    ]);
    expect(leaving.text).toContain('You are out');
    expect(leaving.ran.some((sql) => sql.startsWith('DELETE FROM booking_players'))).toBe(true);
  });

  it('refuses extra slots and tab settlement to members who are not admins', async () => {
    const requests = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(init.body) });
      const result = String(url).endsWith('/getChatMember')
        ? { status: 'member' } : { message_id: 1 };
      return new Response(JSON.stringify({ ok: true, result }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }));
    const env = {
      BOT_TOKEN: 'test-token', ALLOWED_CHATS: '-123456789',
      OWNER_USER_ID: '7', DB: emptyDb(),
    };
    for (const data of ['sb:cap:3', 'sb:kick:3', 'sb:kick:3:4', 'tb:pay']) {
      requests.length = 0;
      await handleUpdate(env, {
        callback_query: {
          id: 'callback-1', data,
          from: { id: 11, username: 'alice' },
          message: { message_id: 55, chat: { id: -123456789 } },
        },
      });
      const answer = requests.find((request) => request.url.endsWith('/answerCallbackQuery'));
      expect(answer.body.text).toContain('admins');
      expect(answer.body.show_alert).toBe(true);
      expect(requests.some((request) => request.url.endsWith('/editMessageReplyMarkup')))
        .toBe(false);
    }
  });

  // Booking ids are small sequential numbers, so an ungated /cancel would let
  // any member walk the whole group's history away one id at a time.
  function bookingDb(booking) {
    const ran = [];
    const db = {
      ran,
      prepare(sql) {
        return { bind() { return {
          async first() {
            if (sql.includes('SELECT tz')) return { tz: 'Asia/Singapore' };
            if (sql.includes('SELECT * FROM bookings WHERE id')) return booking;
            return null;
          },
          async all() { return { results: [] }; },
          async run() { ran.push(sql); return { meta: { changes: 1 } }; },
        }; } };
      },
    };
    return db;
  }

  function captureAsMember() {
    const requests = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(init.body) });
      const result = String(url).endsWith('/getChatMember')
        ? { status: 'member' } : { message_id: 1 };
      return new Response(JSON.stringify({ ok: true, result }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }));
    return requests;
  }

  const nicksBooking = {
    id: 3, chat_id: -123456789, court: '4', created_by_user_id: 7, created_by_name: '@nick',
    starts_at: Date.UTC(2026, 7, 19, 13, 0), ends_at: Date.UTC(2026, 7, 19, 14, 0),
  };

  it('refuses /cancel from a member who did not book the court', async () => {
    const requests = captureAsMember();
    const db = bookingDb(nicksBooking);
    await handleUpdate({
      BOT_TOKEN: 'test-token', ALLOWED_CHATS: '-123456789', DB: db,
    }, {
      message: {
        message_id: 5,
        chat: { id: -123456789 },
        from: { id: 11, username: 'alice' },
        text: '/cancel 3',
      },
    });
    const send = requests.find((request) => request.url.endsWith('/sendMessage'));
    expect(send.body.text).toBe('Only @nick or a group admin can cancel that booking.');
    expect(send.body.receiver_user_id).toBe(11);
    expect(db.ran.some((sql) => sql.startsWith('DELETE FROM bookings'))).toBe(false);
  });

  it('refuses the edit and delete buttons to a member who did not book the court', async () => {
    for (const data of ['sb:edit:3:d', 'sb:delete:3']) {
      const requests = captureAsMember();
      const db = bookingDb(nicksBooking);
      await handleUpdate({
        BOT_TOKEN: 'test-token', ALLOWED_CHATS: '-123456789', DB: db,
      }, {
        callback_query: {
          id: 'callback-1', data,
          from: { id: 11, username: 'alice' },
          message: { message_id: 55, chat: { id: -123456789 } },
        },
      });
      const answer = requests.find((request) => request.url.endsWith('/answerCallbackQuery'));
      expect(answer.body.text).toContain('Only @nick or a group admin');
      expect(answer.body.show_alert).toBe(true);
      expect(requests.some((request) => request.url.endsWith('/editMessageReplyMarkup')))
        .toBe(false);
      expect(db.ran.some((sql) => sql.includes('INSERT INTO booking_drafts'))).toBe(false);
      vi.unstubAllGlobals();
    }
  });

  it('never echoes an internal error into the chat', async () => {
    const logged = [];
    vi.spyOn(console, 'log').mockImplementation((line) => logged.push(line));
    const requests = captureAsMember();
    const db = {
      prepare() { throw new Error('D1_ERROR: no such column: bookings.secret'); },
    };
    await handleUpdate({
      BOT_TOKEN: 'test-token', ALLOWED_CHATS: '-123456789', DB: db,
    }, {
      message: {
        message_id: 5,
        chat: { id: -123456789 },
        from: { id: 7, first_name: 'Nick' },
        text: '/courts',
      },
    });
    const send = requests.find((request) => request.url.endsWith('/sendMessage'));
    expect(send.body.text).toBe('⚠️ Something went wrong. Please try again.');
    // The detail belongs in the log, not in the group.
    expect(logged.join('\n')).toContain('D1_ERROR');
    vi.restoreAllMocks();
  });

  it('registers every command as ephemeral', async () => {
    const requests = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ ok: true, result: true }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }));
    const response = await worker.fetch(new Request('https://worker.example/setup', {
      method: 'POST', headers: { Authorization: 'Bearer admin-secret' },
    }), {
      BOT_TOKEN: 'test-token', WEBHOOK_SECRET: 'webhook-secret',
      ADMIN_SECRET: 'admin-secret', ALLOWED_CHATS: '', DB: emptyDb(),
    });
    expect(response.status).toBe(200);
    const commandRequest = requests.find((request) => request.url.endsWith('/setMyCommands'));
    expect(commandRequest.body.commands.map((command) => command.command))
      .toEqual(['book', 'courts', 'tab', 'cancel', 'help']);
    // Never a group message, not even for the moment before a delete. The cost
    // is that it cannot be cleared from the sender's own chat afterwards.
    for (const command of commandRequest.body.commands) {
      expect(command.is_ephemeral).toBe(true);
    }
  });

  it('updates the bot profile photo through the protected admin route', async () => {
    const requests = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
      requests.push({ url: String(url), body: init.body });
      if (String(url).startsWith('https://raw.githubusercontent.com/')) {
        return new Response(new Uint8Array([255, 216, 255, 217]), {
          status: 200, headers: { 'Content-Type': 'image/jpeg' },
        });
      }
      return new Response(JSON.stringify({ ok: true, result: true }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }));
    const response = await worker.fetch(new Request('https://worker.example/profile-photo', {
      method: 'POST', headers: { Authorization: 'Bearer admin-secret' },
    }), { BOT_TOKEN: 'test-token', ADMIN_SECRET: 'admin-secret' });
    expect(response.status).toBe(200);
    const telegramRequest = requests.find(
      (request) => request.url.endsWith('/setMyProfilePhoto')
    );
    expect(telegramRequest.body).toBeInstanceOf(FormData);
    expect(JSON.parse(telegramRequest.body.get('photo'))).toEqual({
      type: 'static', photo: 'attach://profile_photo',
    });
  });
});

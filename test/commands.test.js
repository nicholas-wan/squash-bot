import { afterEach, describe, expect, it, vi } from 'vitest';
import worker, { handleUpdate } from '../src/index.js';
import { clearAdminCache } from '../src/players.js';

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
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    clearAdminCache();
  });

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

  it('answers an unknown command instead of staying silent', async () => {
    const requests = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ ok: true, result: { ephemeral_message_id: 12 } }), {
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
        text: '/froots',
      },
    });
    const send = requests.find((request) => request.url.endsWith('/sendMessage'));
    expect(send.body.text).toContain('/froots');
    expect(send.body.text).toContain('/courts');
    expect(send.body.receiver_user_id).toBe(7);
  });

  it('ignores an unknown command aimed at another bot', async () => {
    const requests = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ ok: true, result: {} }), {
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
        text: '/froots@some_other_bot',
      },
    });
    expect(requests.some((request) => request.url.endsWith('/sendMessage'))).toBe(false);
  });

  it('answers /tab with a private breakdown when nothing is outstanding', async () => {
    const requests = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ ok: true, result: { ephemeral_message_id: 12 } }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }));
    await handleUpdate({
      BOT_TOKEN: 'test-token', ALLOWED_CHATS: '-123456789',
      OWNER_USER_ID: '7', DB: emptyDb(),
    }, {
      message: {
        message_id: 5,
        chat: { id: -123456789 },
        from: { id: 7, first_name: 'Nick' },
        text: '/tab',
      },
    });
    // An empty ledger pins no tab and so offers no 🧾 button; the command is
    // the only door left to your own history.
    const send = requests.find((request) => request.url.endsWith('/sendMessage'));
    expect(send.body.text).toContain('Nothing outstanding on the group tab.');
    expect(send.body.text).toContain('Your squash tab');
    expect(send.body.receiver_user_id).toBe(7);
  });

  it('clears a public command while its response is being prepared', async () => {
    let releaseDelete;
    const deleteGate = new Promise((resolve) => { releaseDelete = resolve; });
    let helpLookupStarted = false;
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (String(url).endsWith('/deleteMessage')) await deleteGate;
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }));
    const db = {
      prepare() {
        return { bind() { return {
          async first() {
            helpLookupStarted = true;
            return null;
          },
        }; } };
      },
    };
    const handling = handleUpdate({
      BOT_TOKEN: 'test-token', ALLOWED_CHATS: '-123456789', DB: db,
    }, {
      message: {
        message_id: 5,
        chat: { id: -123456789 },
        // No username keeps this test about command deletion rather than the
        // independent player-identity batch.
        from: { id: 7, first_name: 'Nick' },
        text: '/help',
      },
    });
    try {
      // If deletion were still awaited first, the settings read could not
      // begin while deleteMessage is deliberately held open.
      await vi.waitFor(() => expect(helpLookupStarted).toBe(true), { timeout: 200 });
    } finally {
      releaseDelete();
    }
    await handling;
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

  it('answers /courts even when there is nothing to refresh', async () => {
    // Success that looks identical to silence cannot be told apart from a
    // broken bot, so every refresh command says what it did.
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
        text: '/courts',
      },
    });
    const send = requests
      .filter((request) => request.url.endsWith('/sendMessage'))
      .find((request) => request.body.receiver_user_id === 7);
    expect(send.body.text).toContain('Nothing is booked right now');
    expect(send.body.reply_markup.inline_keyboard[0][0].text).toBe('👍 OK');
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
      // The owner shortcut stands in for the admin gate Manage now sits behind.
      BOT_TOKEN: 'test-token', ALLOWED_CHATS: '-123456789',
      OWNER_USER_ID: '7', DB: emptyDb(),
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

  it('reads a command punctuated like a sentence', async () => {
    const requests = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(init.body) });
      return new Response(JSON.stringify({
        ok: true, result: { ephemeral_message_id: 12 },
      }), { headers: { 'Content-Type': 'application/json' } });
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
    // "/book, tmr c4 9pm" used to fail the command shape and get silence.
    await handleUpdate({
      BOT_TOKEN: 'test-token', ALLOWED_CHATS: '-123456789', DB: db,
    }, {
      message: {
        message_id: 5,
        chat: { id: -123456789 },
        from: { id: 7, first_name: 'Nick' },
        text: '/book, tmr c4 9pm',
      },
    });
    const send = requests.find((request) => request.url.endsWith('/sendMessage'));
    expect(send.body.text).toContain('Confirm this squash booking');
    // The details after the comma made it through: nothing left to ask, so
    // the form is at its confirm step.
    const labels = send.body.reply_markup.inline_keyboard.flat().map((button) => button.text);
    expect(labels).toContain('✅ Add booking');
    // The command itself is still cleared out of the group.
    const removed = requests.find((request) => request.url.endsWith('/deleteMessage'));
    expect(removed.body.message_id).toBe(5);
  });

  it('opens a blank form for a bare command with trailing punctuation', async () => {
    const requests = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(init.body) });
      return new Response(JSON.stringify({
        ok: true, result: { ephemeral_message_id: 12 },
      }), { headers: { 'Content-Type': 'application/json' } });
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
        text: '/book,',
      },
    });
    const send = requests.find((request) => request.url.endsWith('/sendMessage'));
    expect(send.body.text).toContain('Confirm this squash booking');
    expect(send.body.text).toContain('Which date?');
  });

  it('always asks for confirmation before saving a complete message', async () => {
    const requests = [];
    const sqlSeen = [];
    // Free text only books for a group admin now, so the sender is one.
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(init.body) });
      return new Response(JSON.stringify(String(url).endsWith('/getChatMember')
        ? { ok: true, result: { status: 'creator' } }
        : { ok: true, result: { ephemeral_message_id: 12 } }),
      { headers: { 'Content-Type': 'application/json' } });
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
        text: '20 Aug 2027 Court 4 9pm',
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
      if (String(url).endsWith('/getChatMember')) {
        return new Response(JSON.stringify({ ok: true, result: { status: 'creator' } }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
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
        text: '20 Aug 2027 Court 4 9pm',
      },
    });
    const removed = requests.find((request) => request.url.endsWith('/deleteMessage'));
    expect(removed.body.message_id).toBe(5);
  });

  it('says so when it lacks the right to delete the booking message', async () => {
    const requests = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(init.body) });
      if (String(url).endsWith('/getChatMember')) {
        return new Response(JSON.stringify({ ok: true, result: { status: 'creator' } }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
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
        text: '20 Aug 2027 Court 4 9pm',
      },
    });
    const warning = requests.find((request) => request.url.endsWith('/sendMessage')
      && request.body.text.includes('Delete Messages'));
    expect(warning.body.receiver_user_id).toBe(7);
  });

  // The intent gate is loose on purpose — "I booked 2 tickets" matches it — and
  // it is the delete that made that expensive, clearing a member's ordinary
  // chat out of the group. Free text books for group admins only now.
  it('books from free text for an admin and ignores it from a member', async () => {
    const run = async (status) => {
      const requests = [];
      vi.stubGlobal('fetch', vi.fn(async (url, init) => {
        requests.push({ url: String(url), body: JSON.parse(init.body) });
        return new Response(JSON.stringify(String(url).endsWith('/getChatMember')
          ? { ok: true, result: { status } }
          : { ok: true, result: { ephemeral_message_id: 12 } }),
        { headers: { 'Content-Type': 'application/json' } });
      }));
      const db = {
        prepare(sql) {
          return { bind() { return {
            async first() {
              return sql.includes('SELECT tz') ? { tz: 'Asia/Singapore' } : null;
            },
            async all() { return { results: [] }; },
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
          from: { id: 11, username: 'alice' },
          text: '20 Aug 2027 Court 4 9pm',
        },
      });
      vi.unstubAllGlobals();
      // Same chat and same person in both runs, so the admin answer must not
      // be carried over from the first.
      clearAdminCache();
      return requests;
    };

    // A member is left alone entirely: no form opened, and nothing deleted.
    const member = await run('member');
    expect(member.some((request) => request.url.endsWith('/deleteMessage'))).toBe(false);
    expect(member.some((request) => request.url.endsWith('/sendMessage'))).toBe(false);

    // An admin books exactly as before, and the group message the form repeats
    // back is still cleared.
    const admin = await run('administrator');
    const form = admin.find((request) => request.url.endsWith('/sendMessage'));
    expect(form.body.text).toContain('Confirm this squash booking');
    expect(admin.find((request) => request.url.endsWith('/deleteMessage')).body.message_id)
      .toBe(5);
  });

  // Telegram never checks callback data against the keyboard it drew, and the
  // pinned board and tab wear no dismiss button — so a hand-sent sb:ok would
  // otherwise let any member delete the group's own record.
  it('refuses a dismiss tap aimed at a pinned message', async () => {
    const run = async (messageId) => {
      const requests = [];
      vi.stubGlobal('fetch', vi.fn(async (url, init) => {
        requests.push({ url: String(url), body: JSON.parse(init.body) });
        return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }));
      const db = {
        prepare(sql) {
          return { bind() { return {
            async first() {
              return sql.includes('board_message_id')
                ? { board_message_id: 55, tab_message_id: 66 } : null;
            },
            async all() { return { results: [] }; },
            async run() { return { meta: { changes: 1 } }; },
          }; } };
        },
      };
      await handleUpdate({
        BOT_TOKEN: 'test-token', ALLOWED_CHATS: '-123456789', DB: db,
      }, {
        callback_query: {
          id: 'callback-1', data: 'sb:ok',
          from: { id: 11, username: 'alice' },
          message: { message_id: messageId, chat: { id: -123456789 } },
        },
      });
      vi.unstubAllGlobals();
      return requests;
    };

    for (const pinned of [55, 66]) {
      const refused = await run(pinned);
      expect(refused.some((request) => request.url.endsWith('/deleteMessage'))).toBe(false);
      // The tap is still answered, or the button spins as though the bot died.
      expect(refused.some((request) => request.url.endsWith('/answerCallbackQuery')))
        .toBe(true);
    }

    // The bot's own receipt is what the button exists to clear, and still goes.
    const receipt = await run(91);
    expect(receipt.find((request) => request.url.endsWith('/deleteMessage')).body.message_id)
      .toBe(91);
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
        operation: 'add', bookingId: null, sourceText: '20 Aug 2027 Court 4 9pm',
        date: { y: 2027, mo: 8, d: 20 }, court: '4', start: { h: 21, mi: 0 }, end: null,
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
      starts_at: Date.UTC(2027, 7, 19, 13, 0), ends_at: Date.UTC(2027, 7, 19, 14, 0),
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
    // One button. Adding, managing and the admin overview live behind it, in a
    // panel that is private and so can differ per person.
    expect(board.body.reply_markup.inline_keyboard).toEqual([
      [{ text: '🙋 Join', callback_data: 'sb:join' }],
    ]);
  });

  it('toggles one shared court button by who tapped it', async () => {
    const booking = {
      id: 3, chat_id: -123456789, court: '4', capacity: 3,
      starts_at: Date.UTC(2027, 7, 19, 13, 0), ends_at: Date.UTC(2027, 7, 19, 14, 0),
    };
    const run = async (roster) => {
      const requests = [];
      const ran = [];
      // A live copy, so the DELETE and INSERT below change what later reads
      // see — the notification path reads the roster again after the change,
      // and a frozen mock would hide an ordering regression there.
      let players = roster.map((player) => ({ ...player }));
      vi.stubGlobal('fetch', vi.fn(async (url, init) => {
        requests.push({ url: String(url), body: JSON.parse(init.body) });
        return new Response(JSON.stringify({ ok: true, result: { message_id: 55 } }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }));
      const db = {
        prepare(sql) {
          ran.push(sql);
          return { bind(...args) { return {
            async first() {
              if (sql.includes('SELECT tz')) return { tz: 'Asia/Singapore' };
              if (sql.includes('SELECT * FROM bookings WHERE id')) return booking;
              return null;
            },
            async all() {
              if (sql.includes('FROM booking_players')) return { results: players };
              return { results: sql.includes('ends_at >') ? [booking] : [] };
            },
            async run() {
              if (sql.startsWith('DELETE FROM booking_players')) {
                const before = players.length;
                // rememberPlayer merges duplicate spellings (slug != ?);
                // leaveBooking removes the tapper's own row (slug = ?).
                players = sql.includes('slug != ?')
                  ? players.filter((player) => !(player.user_id === args[0]
                      && player.slug !== args[1]))
                  : players.filter((player) => player.slug !== args[1]);
                return { meta: { changes: before - players.length } };
              }
              if (sql.startsWith('INSERT OR IGNORE INTO booking_players')) {
                players.push({
                  id: 99, booking_id: args[0], user_id: args[2],
                  slug: args[3], name: args[4],
                });
                return { meta: { changes: 1 } };
              }
              return { meta: { changes: 1 } };
            },
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
    // Leaving is told the same way joining is, and the leaver hears it too —
    // the mock really deletes her row, so this proves the confirmation does
    // not depend on finding her in the post-delete roster.
    const told = leaving.requests
      .filter((request) => request.url.endsWith('/sendMessage'))
      .filter((request) => request.body.receiver_user_id === 11);
    expect(told).toHaveLength(1);
    expect(told[0].body.text).toContain('You are off');
  });

  it('lets an admin seat a known player, telling the court', async () => {
    const requests = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      const body = JSON.parse(init.body);
      requests.push({ url: String(url), body });
      const result = String(url).endsWith('/getChatMember')
        ? { status: 'creator' }
        : (String(url).endsWith('/sendMessage') && body.receiver_user_id
          ? { ephemeral_message_id: 55 } : { message_id: 55 });
      return new Response(JSON.stringify({ ok: true, result }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }));
    const booking = {
      id: 3, chat_id: -123456789, court: '4', capacity: 3,
      starts_at: Date.UTC(2027, 7, 19, 13, 0), ends_at: Date.UTC(2027, 7, 19, 14, 0),
    };
    const ran = [];
    const db = { prepare(sql) { ran.push(sql); return { bind() { return {
      async first() {
        if (sql.includes('SELECT tz')) return { tz: 'Asia/Singapore' };
        if (sql.includes('SELECT * FROM bookings WHERE id')) return booking;
        if (sql.includes('board_message_id')) return { board_message_id: 55 };
        return null;
      },
      async all() {
        if (sql.includes('FROM ledger')) {
          return { results: [{ slug: '@bo', name: '@bo', user_id: 42 }] };
        }
        if (sql.includes('FROM booking_players')) {
          return { results: [
            { id: 1, booking_id: 3, user_id: 7, slug: 'u7', name: 'Nick' },
            // Seeded but never seen: the admin toast must not claim this person
            // was notified when there is no numeric id to address.
            { id: 2, booking_id: 3, user_id: null, slug: '@silent', name: '@silent' },
          ] };
        }
        return { results: sql.includes('ends_at >') ? [booking] : [] };
      },
      async run() { return { meta: { changes: 1 } }; },
    }; } }; } };
    db.batch = async (statements) => Promise.all(statements.map((statement) => statement.run()));
    await handleUpdate({ BOT_TOKEN: 'test-token', ALLOWED_CHATS: '-123456789', DB: db }, {
      callback_query: {
        id: 'callback-1', data: 'sb:addp:3:1:@bo',
        from: { id: 9, username: 'admin' },
        message: { message_id: 55, chat: { id: -123456789 } },
      },
    });
    expect(ran.some((sql) => sql.startsWith('INSERT OR IGNORE INTO booking_players')))
      .toBe(true);
    const sent = requests.filter((request) => request.url.endsWith('/sendMessage'));
    // The seated player is confirmed as if they joined; the court hears who
    // was put on, worded as an admin action.
    expect(sent.find((request) => request.body.receiver_user_id === 42).body.text)
      .toContain('You are on');
    expect(sent.find((request) => request.body.receiver_user_id === 7).body.text)
      .toContain('was seated on');
    const answer = requests.find((request) => request.url.endsWith('/answerCallbackQuery'));
    expect(answer.body.text).toContain('@bo is on this court');
    expect(answer.body.text).toContain('Some players could not be notified');
  });

  it('seats a player with a friend as two heads on one row', async () => {
    const requests = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      const body = JSON.parse(init.body);
      requests.push({ url: String(url), body });
      const result = String(url).endsWith('/getChatMember')
        ? { status: 'creator' }
        : (String(url).endsWith('/sendMessage') && body.receiver_user_id
          ? { ephemeral_message_id: 55 } : { message_id: 55 });
      return new Response(JSON.stringify({ ok: true, result }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }));
    const booking = {
      id: 3, chat_id: -123456789, court: '4', capacity: 3,
      starts_at: Date.UTC(2027, 7, 19, 13, 0), ends_at: Date.UTC(2027, 7, 19, 14, 0),
    };
    // A live roster, so the notices read the court as it stands after the seat.
    const players = [{ id: 1, booking_id: 3, user_id: 7, slug: 'u7', name: 'Nick', heads: 1 }];
    const inserts = [];
    const db = { prepare(sql) { return { bind(...args) { return {
      async first() {
        if (sql.includes('SELECT tz')) return { tz: 'Asia/Singapore' };
        if (sql.includes('SELECT * FROM bookings WHERE id')) return booking;
        if (sql.includes('board_message_id')) return { board_message_id: 55 };
        return null;
      },
      async all() {
        if (sql.includes('FROM ledger')) {
          return { results: [{ slug: '@bo', name: '@bo', user_id: 42 }] };
        }
        if (sql.includes('FROM booking_players')) return { results: players };
        return { results: sql.includes('ends_at >') ? [booking] : [] };
      },
      async run() {
        if (sql.startsWith('INSERT OR IGNORE INTO booking_players')) {
          inserts.push(args);
          players.push({
            id: 2, booking_id: 3, user_id: 42, slug: args[3], name: args[4], heads: args[6],
          });
        }
        return { meta: { changes: 1 } };
      },
    }; } }; } };
    db.batch = async (statements) => Promise.all(statements.map((statement) => statement.run()));
    await handleUpdate({ BOT_TOKEN: 'test-token', ALLOWED_CHATS: '-123456789', DB: db }, {
      callback_query: {
        id: 'callback-1', data: 'sb:addp:3:2:@bo',
        from: { id: 9, username: 'admin' },
        message: { message_id: 55, chat: { id: -123456789 } },
      },
    });
    expect(inserts[0][6]).toBe(2);
    const sent = requests.filter((request) => request.url.endsWith('/sendMessage'));
    // The rest of the court hears that a friend came with him, and reads the
    // court as full: one name short, but no slots left.
    const toNick = sent.find((request) => request.body.receiver_user_id === 7).body.text;
    expect(toNick).toContain('<b>@bo</b> (+1) were seated on');
    expect(toNick).toContain('@bo +1');
    expect(toNick).toContain('full');
    const answer = requests.find((request) => request.url.endsWith('/answerCallbackQuery'));
    expect(answer.body.text).toContain('@bo +1 are on this court');
    expect(answer.body.text).toContain('two shares');
  });

  it('redraws the seating picker when the friend toggle is flipped', async () => {
    const requests = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(init.body) });
      const result = String(url).endsWith('/getChatMember')
        ? { status: 'creator' } : { message_id: 55 };
      return new Response(JSON.stringify({ ok: true, result }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }));
    const booking = {
      id: 3, chat_id: -123456789, court: '4', capacity: 3,
      starts_at: Date.UTC(2027, 7, 19, 13, 0), ends_at: Date.UTC(2027, 7, 19, 14, 0),
    };
    const db = { prepare(sql) { return { bind() { return {
      async first() {
        if (sql.includes('SELECT tz')) return { tz: 'Asia/Singapore' };
        if (sql.includes('SELECT * FROM bookings WHERE id')) return booking;
        return null;
      },
      async all() {
        if (sql.includes('FROM ledger')) {
          return { results: [{ slug: '@bo', name: '@bo', user_id: 42 }] };
        }
        if (sql.includes('FROM booking_players')) return { results: [] };
        return { results: sql.includes('ends_at >') ? [booking] : [] };
      },
      async run() { return { meta: { changes: 1 } }; },
    }; } }; } };
    await handleUpdate({ BOT_TOKEN: 'test-token', ALLOWED_CHATS: '-123456789', DB: db }, {
      callback_query: {
        id: 'callback-1', data: 'sb:addp:3:h2',
        from: { id: 9, username: 'admin' },
        message: { message_id: 55, ephemeral_message_id: 88, chat: { id: -123456789 } },
      },
    });
    // The panel is private, so the toggle edits it in place rather than
    // posting a second copy of the same list.
    const edited = requests.find((request) => request.url.endsWith('/editEphemeralMessageText'));
    expect(edited.body.text).toContain('two slots and pay two shares');
    const buttons = edited.body.reply_markup.inline_keyboard.flat();
    expect(buttons[0].callback_data).toBe('sb:addp:3:h1');
    expect(buttons[1].callback_data).toBe('sb:addp:3:2:@bo');
    expect(requests.some((request) => request.url.endsWith('/sendMessage'))).toBe(false);
  });

  function plusOneRun(updateChanges) {
    const requests = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      const body = JSON.parse(init.body);
      requests.push({ url: String(url), body });
      const result = String(url).endsWith('/getChatMember')
        ? { status: 'creator' }
        : (String(url).endsWith('/sendMessage') && body.receiver_user_id
          ? { ephemeral_message_id: 55 } : { message_id: 55 });
      return new Response(JSON.stringify({ ok: true, result }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }));
    const booking = {
      id: 3, chat_id: -123456789, court: '4', capacity: 3,
      starts_at: Date.UTC(2027, 7, 19, 13, 0), ends_at: Date.UTC(2027, 7, 19, 14, 0),
    };
    const jarhead = {
      id: 8, booking_id: 3, user_id: 42, slug: '@jarhead', name: '@jarhead', heads: 1,
    };
    const ran = [];
    const db = { prepare(sql) { ran.push(sql); return { bind() { return {
      async first() {
        if (sql.includes('SELECT tz')) return { tz: 'Asia/Singapore' };
        if (sql.includes('FROM booking_players WHERE id')) return jarhead;
        if (sql.includes('SELECT * FROM bookings WHERE id')) return booking;
        if (sql.includes('board_message_id')) return { board_message_id: 55 };
        return null;
      },
      async all() {
        if (sql.includes('FROM booking_players')) {
          return { results: [jarhead, { id: 1, booking_id: 3, user_id: 7, slug: 'u7', name: 'Nick' }] };
        }
        return { results: sql.includes('ends_at >') ? [booking] : [] };
      },
      async run() {
        return { meta: { changes: sql.includes('SET heads = 2') ? updateChanges : 1 } };
      },
    }; } }; } };
    db.batch = async (statements) => Promise.all(statements.map((statement) => statement.run()));
    return { requests, ran, db };
  }

  it('lets an admin flip a +1 onto somebody already seated', async () => {
    const { requests, ran, db } = plusOneRun(1);
    await handleUpdate({ BOT_TOKEN: 'test-token', ALLOWED_CHATS: '-123456789', DB: db }, {
      callback_query: {
        id: 'callback-1', data: 'sb:plus:3:8',
        from: { id: 9, username: 'admin' },
        message: { message_id: 55, chat: { id: -123456789 } },
      },
    });
    expect(ran.some((sql) => sql.includes('SET heads = 2'))).toBe(true);
    const sent = requests.filter((request) => request.url.endsWith('/sendMessage'));
    expect(sent.find((request) => request.body.receiver_user_id === 42).body.text)
      .toContain('Your +1 is on');
    expect(sent.find((request) => request.body.receiver_user_id === 7).body.text)
      .toContain('bringing a friend');
    const answer = requests.find((request) => request.url.endsWith('/answerCallbackQuery'));
    expect(answer.body.text).toContain('now brings a +1');
    expect(answer.body.text).toContain('Everyone has been told');
  });

  it('refuses a +1 when the court has no free slot for it', async () => {
    const { requests, db } = plusOneRun(0);
    await handleUpdate({ BOT_TOKEN: 'test-token', ALLOWED_CHATS: '-123456789', DB: db }, {
      callback_query: {
        id: 'callback-1', data: 'sb:plus:3:8',
        from: { id: 9, username: 'admin' },
        message: { message_id: 55, chat: { id: -123456789 } },
      },
    });
    const answer = requests.find((request) => request.url.endsWith('/answerCallbackQuery'));
    expect(answer.body.text).toContain('No free slot');
    // Nothing changed, so nobody is told anything.
    expect(requests.some((request) => request.url.endsWith('/sendMessage'))).toBe(false);
  });

  it('receipts the debtor privately when an admin clears their balance', async () => {
    const requests = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(init.body) });
      const result = String(url).endsWith('/getChatMember')
        ? { status: 'creator' } : { message_id: 1 };
      return new Response(JSON.stringify({ ok: true, result }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }));
    const db = {
      prepare(sql) {
        return { bind() { return {
          async first() {
            if (sql.includes('SELECT tz')) return { tz: 'Asia/Singapore' };
            if (sql.includes('board_message_id')) {
              return { board_message_id: null, tab_message_id: 66 };
            }
            return null;
          },
          async all() {
            return { results: sql.includes('GROUP BY')
              ? [{ slug: 'u42', user_id: 42, name: '@bo', balance: 1400 }] : [] };
          },
          async run() { return { meta: { changes: 1 } }; },
        }; } };
      },
    };
    await handleUpdate({ BOT_TOKEN: 'test-token', ALLOWED_CHATS: '-123456789', DB: db }, {
      callback_query: {
        id: 'callback-1', data: 'tb:paid:u42',
        from: { id: 7, username: 'nicholaswan' },
        message: { message_id: 55, chat: { id: -123456789 } },
      },
    });
    const receipt = requests
      .filter((request) => request.url.endsWith('/sendMessage'))
      .find((request) => request.body.receiver_user_id === 42);
    expect(receipt.body.text).toContain('Payment received');
    expect(receipt.body.text).toContain('$14.00');
    expect(receipt.body.reply_markup.inline_keyboard[0][0].text).toBe('👍 OK');
    const answer = requests.find((request) => request.url.endsWith('/answerCallbackQuery'));
    expect(answer.body.text).toContain('cleared');
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
    for (const data of ['sb:cap:3', 'sb:kick:3', 'sb:kick:3:4', 'sb:addp:3',
      'sb:addp:3:h2', 'sb:addp:3:1:@bo', 'sb:addp:3:2:@bo', 'sb:plus:3',
      'sb:plus:3:8', 'tb:pay']) {
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
    starts_at: Date.UTC(2027, 7, 19, 13, 0), ends_at: Date.UTC(2027, 7, 19, 14, 0),
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
    const menus = requests.filter((request) => request.url.endsWith('/setMyCommands'));
    expect(menus).toHaveLength(3);
    // The default menu carries everything; the group menu drops /cancel —
    // parameterised and rarely a member's to run — and group admins get it back.
    const byScope = new Map(menus.map((request) => [
      request.body.scope ? request.body.scope.type : 'default',
      request.body.commands.map((command) => command.command),
    ]));
    expect(byScope.get('default')).toEqual(['book', 'courts', 'tab', 'help', 'cancel']);
    expect(byScope.get('all_group_chats')).toEqual(['book', 'courts', 'tab', 'help']);
    expect(byScope.get('all_chat_administrators'))
      .toEqual(['book', 'courts', 'tab', 'help', 'cancel']);
    // Never a group message, not even for the moment before a delete. The cost
    // is that it cannot be cleared from the sender's own chat afterwards.
    for (const menu of menus) {
      for (const command of menu.body.commands) {
        expect(command.is_ephemeral).toBe(true);
      }
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

  it('offers only the four other YCK courts when changing a court', async () => {
    const requests = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ ok: true, result: { ephemeral_message_id: 12 } }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }));
    const booking = {
      id: 3, chat_id: -123456789, court: '4', capacity: 3, created_by_user_id: 7,
      starts_at: Date.UTC(2027, 7, 19, 13, 0), ends_at: Date.UTC(2027, 7, 19, 14, 0),
    };
    const db = {
      prepare(sql) {
        return { bind() { return {
          async first() {
            if (sql.includes('SELECT tz')) return { tz: 'Asia/Singapore' };
            if (sql.includes('FROM bookings')) return booking;
            return null;
          },
          async all() { return { results: sql.includes('ends_at >') ? [booking] : [] }; },
          async run() { return { meta: { changes: 1, last_row_id: 41 } }; },
        }; } };
      },
    };
    await handleUpdate({ BOT_TOKEN: 'test-token', ALLOWED_CHATS: '-123456789', DB: db }, {
      callback_query: {
        id: 'callback-1', data: 'sb:edit:3:c',
        from: { id: 7, username: 'nick' },
        message: { message_id: 55, chat: { id: -123456789 } },
      },
    });
    const form = requests.find((request) => request.url.endsWith('/sendMessage'));
    expect(form.body.text).toContain('Which court?');
    const labels = form.body.reply_markup.inline_keyboard.flat().map((button) => button.text);
    const courts = labels.filter((label) => /^Court \d+$/.test(label));
    // YCK has five courts, and the one the booking already sits on is not
    // offered back — a button that changes nothing.
    expect(courts).toEqual(['Court 1', 'Court 2', 'Court 3', 'Court 5']);
  });

  describe('private panel delivery', () => {
    const panelTap = (data, env = {}) => handleUpdate({
      BOT_TOKEN: 'test-token', ALLOWED_CHATS: '-123456789', DB: emptyDb(), ...env,
    }, {
      callback_query: {
        id: 'callback-1', data,
        from: { id: 7, first_name: 'Nick' },
        message: { message_id: 55, chat: { id: -123456789 } },
      },
    });

    it('points at a freshly opened tab panel, but not at an in-place edit', async () => {
      const run = async (message) => {
        const requests = [];
        vi.stubGlobal('fetch', vi.fn(async (url, init) => {
          requests.push({ url: String(url), body: JSON.parse(init.body) });
          return new Response(JSON.stringify({
            ok: true, result: { ephemeral_message_id: 12 },
          }), { headers: { 'Content-Type': 'application/json' } });
        }));
        await handleUpdate({
          BOT_TOKEN: 'test-token', ALLOWED_CHATS: '-123456789',
          OWNER_USER_ID: '7', DB: emptyDb(),
        }, {
          callback_query: {
            id: 'callback-1', data: 'tb:mine',
            from: { id: 7, first_name: 'Nick' },
            message,
          },
        });
        return requests.find((request) => request.url.endsWith('/answerCallbackQuery'));
      };
      // Off the pinned tab a new message lands below, which nothing announces.
      const opened = await run({ message_id: 55, chat: { id: -123456789 } });
      expect(opened.body.text).toContain('below');
      // From inside a panel the same tap edits in place; no pointer to give.
      const edited = await run({
        message_id: 55, ephemeral_message_id: 88, chat: { id: -123456789 },
      });
      expect(edited.body.text).toBe('');
    });

    it('answers when an admin panel cannot be delivered', async () => {
      const requests = [];
      vi.stubGlobal('fetch', vi.fn(async (url, init) => {
        requests.push({ url: String(url), body: JSON.parse(init.body) });
        const refused = String(url).endsWith('/sendMessage');
        return new Response(JSON.stringify(refused
          ? { ok: false, description: 'USER_NOT_REACHABLE' }
          : { ok: true, result: {} }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }));
      await panelTap('sb:manage', { OWNER_USER_ID: '7' });
      const answer = requests.find((request) => request.url.endsWith('/answerCallbackQuery'));
      expect(answer.body.text).toContain('Something went wrong');
      expect(answer.body.show_alert).toBe(true);
    });

    it('treats an unchanged panel edit as a harmless repeat tap', async () => {
      const requests = [];
      vi.stubGlobal('fetch', vi.fn(async (url, init) => {
        requests.push({ url: String(url), body: JSON.parse(init.body) });
        if (String(url).endsWith('/editEphemeralMessageText')) {
          return new Response(JSON.stringify({
            ok: false, description: 'Bad Request: message is not modified',
          }), { headers: { 'Content-Type': 'application/json' } });
        }
        return new Response(JSON.stringify({ ok: true, result: true }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }));
      const booking = {
        id: 3, chat_id: -123456789, court: '4', capacity: 3,
        starts_at: Date.UTC(2027, 7, 19, 13, 0), ends_at: Date.UTC(2027, 7, 19, 14, 0),
      };
      const db = {
        prepare(sql) {
          return { bind() { return {
            async first() {
              if (sql.includes('SELECT tz')) return { tz: 'Asia/Singapore' };
              if (sql.includes('SELECT * FROM bookings WHERE id')) return booking;
              return null;
            },
            async all() {
              return { results: sql.includes('FROM booking_players') ? [] : [booking] };
            },
          }; } };
        },
      };
      await handleUpdate({
        BOT_TOKEN: 'test-token', ALLOWED_CHATS: '-123456789',
        OWNER_USER_ID: '7', DB: db,
      }, {
        callback_query: {
          id: 'callback-1', data: 'sb:pick:3',
          from: { id: 7, first_name: 'Nick' },
          message: {
            message_id: 55, ephemeral_message_id: 88, chat: { id: -123456789 },
          },
        },
      });
      const answers = requests.filter((request) => request.url.endsWith('/answerCallbackQuery'));
      expect(answers).toHaveLength(1);
      expect(answers[0].body.text).toBe('');
      expect(answers[0].body.show_alert).toBe(false);
    });

    it('removes a tab panel if Telegram falls back to a public message', async () => {
      const requests = [];
      vi.stubGlobal('fetch', vi.fn(async (url, init) => {
        requests.push({ url: String(url), body: JSON.parse(init.body) });
        return new Response(JSON.stringify({ ok: true, result: { message_id: 91 } }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }));
      // The owner shortcut avoids an unrelated getChatMember request while the
      // test follows the same tab-panel path an ordinary member uses.
      await panelTap('tb:mine', { OWNER_USER_ID: '7' });
      const panel = requests.find((request) => request.url.endsWith('/sendMessage'));
      expect(panel.body.text).toContain('Only you can see this');
      const removed = requests.find((request) => request.url.endsWith('/deleteMessage'));
      expect(removed.body.message_id).toBe(91);
      const answer = requests.find((request) => request.url.endsWith('/answerCallbackQuery'));
      expect(answer.body.text).toContain('Something went wrong');
      expect(answer.body.show_alert).toBe(true);
    });
  });

  // The join picker is the board's only door. Its delivery has to answer the
  // tap whatever Telegram does with the send, because the tap's toast is the
  // one channel that always reaches whoever pressed the button.
  describe('join picker delivery', () => {
    const booking = {
      id: 3, chat_id: -123456789, court: '4', capacity: 3,
      starts_at: Date.UTC(2027, 7, 19, 13, 0), ends_at: Date.UTC(2027, 7, 19, 14, 0),
    };
    const pickerDb = () => ({
      prepare(sql) {
        return { bind() { return {
          async first() {
            if (sql.includes('SELECT tz')) return { tz: 'Asia/Singapore' };
            return null;
          },
          async all() {
            if (sql.includes('FROM booking_players')) return { results: [] };
            return { results: sql.includes('ends_at >') ? [booking] : [] };
          },
          async run() { return { meta: { changes: 1 } }; },
        }; } };
      },
    });
    const tap = (env) => handleUpdate(env, {
      callback_query: {
        id: 'callback-1', data: 'sb:join',
        from: { id: 11, username: 'alice' },
        message: { message_id: 55, chat: { id: -123456789 } },
      },
    });

    it('tells the tapper when the court list cannot be sent at all', async () => {
      const requests = [];
      vi.stubGlobal('fetch', vi.fn(async (url, init) => {
        requests.push({ url: String(url), body: JSON.parse(init.body) });
        // A refused ephemeral send — the shape a brand-new member sees.
        const ok = !String(url).endsWith('/sendMessage');
        return new Response(JSON.stringify(ok
          ? { ok: true, result: { message_id: 55 } }
          : { ok: false, description: 'USER_NOT_REACHABLE' }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }));
      await tap({ BOT_TOKEN: 'test-token', ALLOWED_CHATS: '-123456789', DB: pickerDb() });
      const answer = requests.find((request) => request.url.endsWith('/answerCallbackQuery'));
      expect(answer.body.text).toContain('tap 🙋 Join again');
      expect(answer.body.show_alert).toBe(true);
    });

    it('removes the public copy when Telegram will not deliver the list privately', async () => {
      const requests = [];
      vi.stubGlobal('fetch', vi.fn(async (url, init) => {
        requests.push({ url: String(url), body: JSON.parse(init.body) });
        // ok, but as an ordinary group message: no ephemeral_message_id.
        return new Response(JSON.stringify({ ok: true, result: { message_id: 91 } }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }));
      await tap({ BOT_TOKEN: 'test-token', ALLOWED_CHATS: '-123456789', DB: pickerDb() });
      // "Only you can see this list" must not sit in the group.
      const removed = requests.find((request) => request.url.endsWith('/deleteMessage'));
      expect(removed.body.message_id).toBe(91);
      const answer = requests.find((request) => request.url.endsWith('/answerCallbackQuery'));
      expect(answer.body.text).toContain('tap 🙋 Join again');
      expect(answer.body.show_alert).toBe(true);
    });

    it('points the tapper below once the list is delivered', async () => {
      const requests = [];
      vi.stubGlobal('fetch', vi.fn(async (url, init) => {
        requests.push({ url: String(url), body: JSON.parse(init.body) });
        return new Response(JSON.stringify({
          ok: true, result: { ephemeral_message_id: 12 },
        }), { headers: { 'Content-Type': 'application/json' } });
      }));
      await tap({ BOT_TOKEN: 'test-token', ALLOWED_CHATS: '-123456789', DB: pickerDb() });
      // Ephemeral messages may arrive without scrolling the chat, so the
      // toast says where to look rather than saying nothing.
      const answer = requests.find((request) => request.url.endsWith('/answerCallbackQuery'));
      expect(answer.body.text).toContain('below');
    });

    it('answers the tap even when the handler throws', async () => {
      const requests = [];
      const logged = [];
      vi.spyOn(console, 'log').mockImplementation((line) => logged.push(line));
      vi.stubGlobal('fetch', vi.fn(async (url, init) => {
        requests.push({ url: String(url), body: JSON.parse(init.body) });
        return new Response(JSON.stringify({ ok: true, result: {} }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }));
      const db = { prepare() { throw new Error('D1 is down'); } };
      // No username, so rememberPlayer returns before it can touch the DB and
      // the throw lands inside the picker build itself.
      await handleUpdate({ BOT_TOKEN: 'test-token', ALLOWED_CHATS: '-123456789', DB: db }, {
        callback_query: {
          id: 'callback-1', data: 'sb:join',
          from: { id: 11, first_name: 'Alice' },
          message: { message_id: 55, chat: { id: -123456789 } },
        },
      });
      // The failure is logged for the operator and answered for the tapper: an
      // unanswered callback leaves the button spinning, which reads as a dead
      // bot rather than a passing error.
      expect(logged.join('\n')).toContain('Callback failed');
      const answer = requests.find((request) => request.url.endsWith('/answerCallbackQuery'));
      expect(answer.body.text).toContain('Something went wrong');
      expect(answer.body.show_alert).toBe(true);
      vi.restoreAllMocks();
    });

    it('confirms a join before the roster notices and board edit go out', async () => {
      const requests = [];
      vi.stubGlobal('fetch', vi.fn(async (url, init) => {
        requests.push({ url: String(url), body: JSON.parse(init.body) });
        return new Response(JSON.stringify({ ok: true, result: { message_id: 55 } }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }));
      const db = {
        prepare(sql) {
          return { bind() { return {
            async first() {
              if (sql.includes('SELECT tz')) return { tz: 'Asia/Singapore' };
              if (sql.includes('SELECT * FROM bookings WHERE id')) return booking;
              if (sql.includes('board_message_id')) return { board_message_id: 55 };
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
      // The toast is the only feedback that expires, so it must not queue
      // behind the notification burst and the pinned-board edit.
      const answerAt = requests.findIndex(
        (request) => request.url.endsWith('/answerCallbackQuery')
      );
      const boardEditAt = requests.findIndex(
        (request) => request.url.endsWith('/editMessageText')
      );
      expect(requests[answerAt].body.text).toContain('You are in');
      expect(answerAt).toBeGreaterThan(-1);
      expect(boardEditAt).toBeGreaterThan(answerAt);
      const actorNotice = requests
        .filter((request) => request.url.endsWith('/sendMessage'))
        .find((request) => request.body.receiver_user_id === 11
          && request.body.text.includes('You are on'));
      expect(actorNotice.body.callback_query_id).toBe('callback-1');
    });

    it('reports a failed in-place picker refresh without losing the join confirmation', async () => {
      const requests = [];
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.stubGlobal('fetch', vi.fn(async (url, init) => {
        const body = JSON.parse(init.body);
        requests.push({ url: String(url), body });
        if (String(url).endsWith('/editEphemeralMessageText')) {
          return new Response(JSON.stringify({
            ok: false, description: 'MESSAGE_CANNOT_BE_EDITED',
          }), { headers: { 'Content-Type': 'application/json' } });
        }
        const result = String(url).endsWith('/sendMessage') && body.receiver_user_id
          ? { ephemeral_message_id: 77 } : { message_id: 55 };
        return new Response(JSON.stringify({ ok: true, result }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }));
      const db = {
        prepare(sql) {
          return { bind() { return {
            async first() {
              if (sql.includes('SELECT tz')) return { tz: 'Asia/Singapore' };
              if (sql.includes('SELECT * FROM bookings WHERE id')) return booking;
              if (sql.includes('board_message_id')) return { board_message_id: 55 };
              return null;
            },
            async all() {
              if (sql.includes('FROM booking_players')) return { results: [] };
              return { results: sql.includes('ends_at >') ? [booking] : [] };
            },
            async run() { return { meta: { changes: 1 } }; },
          }; } };
        },
        async batch(statements) {
          return statements.map(() => ({ success: true }));
        },
      };
      await handleUpdate({
        BOT_TOKEN: 'test-token', ALLOWED_CHATS: '-123456789', OWNER_USER_ID: '11', DB: db,
      }, {
        callback_query: {
          id: 'callback-1', data: 'sb:join:3',
          from: { id: 11, username: 'alice' },
          message: {
            message_id: 55, ephemeral_message_id: 88, chat: { id: -123456789 },
          },
        },
      });
      const answers = requests.filter((request) => request.url.endsWith('/answerCallbackQuery'));
      expect(answers[0].body.text).toContain('You are in');
      expect(answers[1].body.text).toContain('Something went wrong');
      expect(requests.some((request) => request.url.endsWith('/editEphemeralMessageText')))
        .toBe(true);
    });
  });

  // The Bot API accepts one method call as the webhook's own HTTP response
  // ("Making requests when getting updates"). The API is served from Amsterdam,
  // a quarter second from this worker, so the toast riding the response is the
  // difference between an instant tap and a visibly laggy one.
  describe('webhook answers', () => {
    const webhookEnv = (db) => ({
      BOT_TOKEN: 'test-token', WEBHOOK_SECRET: 'hook-secret',
      ALLOWED_CHATS: '-123456789', DB: db,
    });
    const webhookRequest = (update) => new Request('https://worker.example/webhook', {
      method: 'POST',
      headers: { 'X-Telegram-Bot-Api-Secret-Token': 'hook-secret' },
      body: JSON.stringify(update),
    });

    it('sends the join toast back on the webhook response itself', async () => {
      const requests = [];
      vi.stubGlobal('fetch', vi.fn(async (url, init) => {
        requests.push({ url: String(url), body: JSON.parse(init.body) });
        return new Response(JSON.stringify({ ok: true, result: { message_id: 55 } }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }));
      const booking = {
        id: 3, chat_id: -123456789, court: '4', capacity: 3,
        starts_at: Date.UTC(2027, 7, 19, 13, 0), ends_at: Date.UTC(2027, 7, 19, 14, 0),
      };
      const db = {
        prepare(sql) {
          return { bind() { return {
            async first() {
              if (sql.includes('SELECT tz')) return { tz: 'Asia/Singapore' };
              if (sql.includes('SELECT * FROM bookings WHERE id')) return booking;
              if (sql.includes('board_message_id')) return { board_message_id: 55 };
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
      const tasks = [];
      const response = await worker.fetch(webhookRequest({
        callback_query: {
          id: 'callback-1', data: 'sb:join:3',
          from: { id: 11, username: 'alice' },
          message: { message_id: 55, chat: { id: -123456789 } },
        },
      }), webhookEnv(db), { waitUntil: (task) => tasks.push(task) });
      expect(response.headers.get('Content-Type')).toBe('application/json');
      const body = JSON.parse(await response.text());
      expect(body.method).toBe('answerCallbackQuery');
      expect(body.callback_query_id).toBe('callback-1');
      expect(body.text).toContain('You are in');
      await Promise.all(tasks);
      // The fan-out still travelled over HTTPS after the response went out...
      expect(requests.some((request) => request.url.endsWith('/editMessageText'))).toBe(true);
      // ...but the toast did not: it rode the webhook response instead.
      expect(requests.some((request) => request.url.endsWith('/answerCallbackQuery')))
        .toBe(false);
    });

    it('answers ok when a callback produces no toast at all', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(
        JSON.stringify({ ok: true, result: {} }),
        { headers: { 'Content-Type': 'application/json' } }
      )));
      const tasks = [];
      // Data no handler claims: the arm must be released by handling ending,
      // not by a toast, or this response would hang until the timeout.
      const response = await worker.fetch(webhookRequest({
        callback_query: {
          id: 'callback-2', data: 'xx:unknown',
          from: { id: 11, username: 'alice' },
          message: { message_id: 55, chat: { id: -123456789 } },
        },
      }), webhookEnv(emptyDb()), { waitUntil: (task) => tasks.push(task) });
      expect(await response.text()).toBe('ok');
      await Promise.all(tasks);
    });

    it('keeps answering message updates with a plain ok', async () => {
      const requests = [];
      vi.stubGlobal('fetch', vi.fn(async (url, init) => {
        requests.push({ url: String(url), body: JSON.parse(init.body) });
        return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }));
      const tasks = [];
      const response = await worker.fetch(webhookRequest({
        message: {
          message_id: 5,
          ephemeral_message_id: 88,
          chat: { id: -123456789 },
          from: { id: 7, first_name: 'Nick' },
          text: '/help',
        },
      }), webhookEnv(emptyDb()), { waitUntil: (task) => tasks.push(task) });
      expect(await response.text()).toBe('ok');
      await Promise.all(tasks);
      expect(requests.some((request) => request.url.endsWith('/sendMessage'))).toBe(true);
    });
  });

  describe('heartbeat', () => {
    // The heartbeat read takes no parameters, so first() is called without
    // bind() — the double supports both shapes, exactly as D1 does.
    function heartbeatDb(beatAt, { failMaintenance = false } = {}) {
      const ran = [];
      return {
        ran,
        prepare(sql) {
          const statement = {
            bind() { return statement; },
            async first() {
              if (sql.includes('FROM heartbeat')) {
                return beatAt == null ? null : { beat_at: beatAt };
              }
              return null;
            },
            async all() {
              if (failMaintenance && sql.includes('FROM booking_players AS p')) {
                throw new Error('reminder query failed');
              }
              return { results: [] };
            },
            async run() { ran.push(sql); return { meta: { changes: 1 } }; },
          };
          return statement;
        },
      };
    }

    it('stamps the beat only after a full maintenance pass', async () => {
      const db = heartbeatDb(null);
      const tasks = [];
      await worker.scheduled({}, { BOT_TOKEN: 'test', DB: db },
        { waitUntil: (task) => tasks.push(task) });
      await Promise.all(tasks);
      expect(db.ran.some((sql) => sql.includes('INSERT INTO heartbeat'))).toBe(true);
    });

    it('withholds the success heartbeat when a maintenance stage fails', async () => {
      const db = heartbeatDb(null, { failMaintenance: true });
      const tasks = [];
      await worker.scheduled({}, { BOT_TOKEN: 'test', ALLOWED_CHATS: '-123', DB: db },
        { waitUntil: (task) => tasks.push(task) });
      await Promise.all(tasks);
      expect(db.ran.some((sql) => sql.includes('INSERT INTO heartbeat'))).toBe(false);
    });

    it('answers 200 at the root while the beat is fresh', async () => {
      const response = await worker.fetch(new Request('https://worker.example/'),
        { BOT_TOKEN: 'test', DB: heartbeatDb(Date.now() - 30 * 1000) });
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('squashbot is running');
    });

    it('answers 500 once the beat goes stale, so a dumb pinger alarms', async () => {
      const response = await worker.fetch(new Request('https://worker.example/'),
        { BOT_TOKEN: 'test', DB: heartbeatDb(Date.now() - 10 * 60 * 1000) });
      expect(response.status).toBe(500);
      expect(await response.text()).toContain('stale');
    });

    it('answers 500 while no beat has ever been recorded', async () => {
      const response = await worker.fetch(new Request('https://worker.example/'),
        { BOT_TOKEN: 'test', DB: heartbeatDb(null) });
      expect(response.status).toBe(500);
    });
  });
});

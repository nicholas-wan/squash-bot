import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleUpdate } from '../src/index.js';

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
  });
});

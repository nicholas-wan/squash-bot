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

  it('opens the booking manager as an ephemeral callback response', async () => {
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
    const send = requests.find((request) => request.url.endsWith('/sendMessage'));
    expect(send.body.receiver_user_id).toBe(7);
    expect(send.body.callback_query_id).toBe('callback-1');
    expect(send.body.text).toContain('Manage squash bookings');
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
    expect(commandRequest.body.commands).toHaveLength(4);
    expect(commandRequest.body.commands.every((command) => command.is_ephemeral)).toBe(true);
  });
});

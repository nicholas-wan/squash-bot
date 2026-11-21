import { afterEach, expect, it, vi } from 'vitest';
import { sendMessage } from '../src/telegram.js';

afterEach(() => vi.unstubAllGlobals());

async function sentBody(options) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, result: {} })));
  vi.stubGlobal('fetch', fetchMock);
  await sendMessage({ BOT_TOKEN: 'test' }, -123, 'hello', options);
  return JSON.parse(fetchMock.mock.calls[0][1].body);
}

it('sends a private message in the Bot API 10.3 shape', async () => {
  const body = await sentBody({ receiverUserId: 7, callbackQueryId: 'tap-1' });
  expect(body.ephemeral_message_parameters).toEqual({
    receiver_user_id: 7, callback_query_id: 'tap-1',
  });
  expect(body).not.toHaveProperty('receiver_user_id');
  expect(body).not.toHaveProperty('callback_query_id');
  expect(body.chat_id).toBe(-123);
});

it('leaves a group message without ephemeral parameters', async () => {
  expect(await sentBody({})).not.toHaveProperty('ephemeral_message_parameters');
});

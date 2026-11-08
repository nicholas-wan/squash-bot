// Membership answers are cached for three minutes per isolate. These pin what
// makes that safe: a leave, a kick or a role change forgets the cached answer,
// a write re-asks one older than half a minute, the lookup gives up after four
// seconds, and /setup asks Telegram for the updates that say so.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker, { handleUpdate } from '../src/index.js';
import { signInitData } from '../src/miniapp-auth.js';
import { chatRole, clearAdminCache, forgetRole, ROLE_FRESH_MS } from '../src/players.js';
import { d1, schemaDb } from './d1.js';

const TOKEN = 'test-token';
const CHAT = -123456789;
const NOW = Date.UTC(2026, 10, 8, 4, 0);
const ex = { id: 8, first_name: 'Ex', username: 'ex' };

let sql, env, asked, status;
beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  sql = schemaDb();
  env = {
    BOT_TOKEN: TOKEN, ALLOWED_CHATS: String(CHAT), WEBHOOK_SECRET: 'hook', ADMIN_SECRET: 'admin',
    DB: d1(sql),
  };
  asked = [];
  status = 'member';
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    const method = String(url).split('/').pop();
    const body = JSON.parse(init.body);
    asked.push({ method, body });
    const result = method === 'getChatMember' ? { status }
      : method === 'getChat' ? { id: body.chat_id, title: 'Squash' }
        : method === 'sendMessage' ? { message_id: 1, ephemeral_message_id: 12 } : true;
    return new Response(JSON.stringify({ ok: true, result }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }));
});
afterEach(() => {
  clearAdminCache();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  sql.close();
});

const lookups = () => asked.filter((call) => call.method === 'getChatMember').length;

describe('the cached role', () => {
  it('is remembered, and forgotten on request', async () => {
    expect(await chatRole(env, CHAT, ex)).toBe('member');
    expect(await chatRole(env, CHAT, ex)).toBe('member');
    expect(lookups()).toBe(1);
    status = 'left';
    forgetRole(CHAT, ex.id);
    expect(await chatRole(env, CHAT, ex)).toBe('none');
    expect(lookups()).toBe(2);
  });

  it('is asked again when a caller wants it fresher than it is', async () => {
    await chatRole(env, CHAT, ex);
    Date.now.mockReturnValue(NOW + ROLE_FRESH_MS - 1);
    await chatRole(env, CHAT, ex, { maxAgeMs: ROLE_FRESH_MS });
    expect(lookups()).toBe(1);
    Date.now.mockReturnValue(NOW + ROLE_FRESH_MS + 1);
    await chatRole(env, CHAT, ex, { maxAgeMs: ROLE_FRESH_MS });
    expect(lookups()).toBe(2);
    // An ordinary read still takes the three-minute answer.
    Date.now.mockReturnValue(NOW + 2 * ROLE_FRESH_MS);
    await chatRole(env, CHAT, ex);
    expect(lookups()).toBe(2);
  });

  it('gives Telegram four seconds, not fifteen', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    await chatRole(env, CHAT, ex);
    expect(timeout).toHaveBeenCalledWith(4000);
    // Every other call keeps the long bound.
    await handleUpdate(env, { message: { message_id: 3, chat: { id: CHAT }, from: ex, text: '/hello' } });
    expect(timeout).toHaveBeenCalledWith(15000);
  });
});

describe('membership changes', () => {
  it('forgets the role on a chat_member update, whatever the change', async () => {
    for (const next of ['left', 'kicked', 'administrator', 'member']) {
      await chatRole(env, CHAT, ex);
      const before = lookups();
      await handleUpdate(env, { chat_member: {
        chat: { id: CHAT }, from: ex, date: 1,
        old_chat_member: { user: ex, status: 'member' },
        new_chat_member: { user: ex, status: next },
      } });
      await chatRole(env, CHAT, ex);
      expect(lookups()).toBe(before + 1);
    }
  });

  it('forgets the role when somebody leaves or joins, without handing a leaver their tab', async () => {
    await chatRole(env, CHAT, ex);
    // A tab notice waiting for them would otherwise go out on this "sighting".
    sql.exec(`INSERT INTO monthly_notice_deliveries (chat_id, month, slug, status, last_attempt_at)
      VALUES (${CHAT}, '2026-11', '@ex', 'pending', 0)`);
    status = 'left';
    await handleUpdate(env, { message: {
      message_id: 4, chat: { id: CHAT }, from: ex, left_chat_member: ex,
    } });
    expect(await chatRole(env, CHAT, ex)).toBe('none');
    expect(asked.some((call) => call.method === 'sendMessage')).toBe(false);
    expect(sql.prepare('SELECT status FROM monthly_notice_deliveries').get().status).toBe('pending');
    status = 'member';
    await handleUpdate(env, { message: {
      message_id: 5, chat: { id: CHAT }, from: ex, new_chat_members: [ex],
    } });
    expect(await chatRole(env, CHAT, ex)).toBe('member');
  });

  it('asks Telegram for chat_member updates when the webhook is set up', async () => {
    const response = await worker.fetch(new Request('https://squashbot.test/setup', {
      method: 'POST', headers: { Authorization: 'Bearer admin' },
    }), env);
    expect(response.status).toBe(200);
    const webhook = asked.find((call) => call.method === 'setWebhook');
    expect(webhook.body.allowed_updates).toEqual(['message', 'callback_query', 'chat_member']);
  });
});

describe('the Mini App', () => {
  async function initData(user) {
    const signed = {
      auth_date: String(Math.floor(NOW / 1000)), start_param: `g${CHAT}`, user: JSON.stringify(user),
    };
    signed.hash = await signInitData(TOKEN, signed);
    return new URLSearchParams(signed).toString();
  }
  const call = async (path, body) => worker.fetch(new Request(`https://squashbot.test/api/app/${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `tma ${await initData(ex)}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  }), env);

  it('re-asks a half-minute-old membership before a write, and refuses a leaver', async () => {
    const startsAt = NOW + 3 * 86400000;
    sql.prepare(`INSERT INTO bookings (id, chat_id, court, starts_at, ends_at, reminder_at,
      pre_reminder_at, created_at) VALUES (3, ?, '4', ?, ?, ?, ?, ?)`)
      .run(CHAT, startsAt, startsAt + 3600000, startsAt - 3600000, startsAt - 7200000, NOW);
    expect((await call('courts')).status).toBe(200);
    expect(lookups()).toBe(1);
    // They left, and the leave reached some other isolate.
    status = 'left';
    Date.now.mockReturnValue(NOW + ROLE_FRESH_MS - 1000);
    // A read within the cache's life still goes on the remembered answer…
    expect((await call('courts')).status).toBe(200);
    Date.now.mockReturnValue(NOW + ROLE_FRESH_MS + 1000);
    expect((await call('courts')).status).toBe(200);
    // …but a write asks again, and the leaver is turned away with nothing saved.
    const join = await call('court/3/join', {});
    expect(join.status).toBe(403);
    expect(lookups()).toBe(2);
    expect(sql.prepare('SELECT COUNT(*) AS n FROM booking_players').get().n).toBe(0);
  });
});

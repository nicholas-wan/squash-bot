import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { notifyRosterOfChange } from '../src/bookings.js';
import { seatPlayer } from '../src/actions.js';
import { rememberLedgerIdentity } from '../src/ledger-identity.js';
import { signInitData } from '../src/miniapp-auth.js';
import { joinBooking, leaveBooking } from '../src/players.js';
import { d1, schemaDb } from './d1.js';

let sql, env;
const player = (id) => ({ id, first_name: `Player ${id}` });
beforeEach(() => {
  sql = schemaDb();
  env = { BOT_TOKEN: 'test', ALLOWED_CHATS: '-123', DB: d1(sql) };
  const start = Date.now() + 86400000;
  sql.prepare(`INSERT INTO bookings
    (id, chat_id, court, capacity, starts_at, ends_at, reminder_at, pre_reminder_at, created_at)
    VALUES (3, -123, '4', 1, ?, ?, ?, ?, ?)`).run(start, start + 3600000, start, start, Date.now());
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
    ok: true, result: { ephemeral_message_id: 100 },
  }))));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); sql.close(); });

it('gives the last seat to one of two competing joins, and makes repeated joins and leaves harmless', async () => {
  const results = await Promise.all([joinBooking(env, -123, 3, player(1)), joinBooking(env, -123, 3, player(2))]);
  expect(results.map((result) => result.status).sort()).toEqual(['full', 'joined']);
  const winner = results[0].status === 'joined' ? player(1) : player(2);
  expect((await joinBooking(env, -123, 3, winner)).status).toBe('already');
  expect((await leaveBooking(env, -123, 3, winner)).status).toBe('left');
  expect((await leaveBooking(env, -123, 3, winner)).status).toBe('absent');
});

it('checks the live capacity and court inside the batch, including a delete immediately before it', async () => {
  const original = env.DB.batch;
  env.DB.batch = async (statements) => {
    sql.exec('DELETE FROM bookings WHERE id = 3');
    return original(statements);
  };
  expect((await joinBooking(env, -123, 3, player(1))).status).toBe('gone');
  expect(sql.prepare('SELECT COUNT(*) AS n FROM booking_players').get().n).toBe(0);
});

it('locks a started court and scopes both joins and leaves to the requested chat', async () => {
  expect((await joinBooking(env, -456, 3, player(1))).status).toBe('gone');
  expect((await joinBooking(env, -123, 3, player(1))).status).toBe('joined');
  expect((await leaveBooking(env, -456, 3, player(1))).status).toBe('gone');
  sql.prepare('UPDATE bookings SET starts_at = ? WHERE id = 3').run(Date.now() - 1000);
  expect((await leaveBooking(env, -123, 3, player(1))).status).toBe('started');
  expect((await joinBooking(env, -123, 3, player(2))).status).toBe('started');
  expect(sql.prepare('SELECT COUNT(*) AS n FROM booking_players').get().n).toBe(1);
});

it('does not seat the same numeric account twice under different handles', async () => {
  sql.exec('UPDATE bookings SET capacity = 3');
  expect((await joinBooking(env, -123, 3, { id: 1, username: 'old' })).status).toBe('joined');
  expect((await joinBooking(env, -123, 3, { id: 1, username: 'new' })).status).toBe('already');
  expect((await joinBooking(env, -123, 3, { id: 2, username: 'old' })).status).toBe('identity-conflict');
  expect(sql.prepare('SELECT COUNT(*) AS n FROM booking_players').get().n).toBe(1);
});

it('keeps a delivered roster notice successful when its optional cleanup record fails', async () => {
  await joinBooking(env, -123, 3, player(1));
  const batch = env.DB.batch;
  env.DB.batch = (statements) => {
    if (statements.some((item) => item.query.includes('INSERT INTO sent_messages'))) {
      return Promise.reject(new Error('cleanup unavailable'));
    }
    return batch(statements);
  };
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const booking = sql.prepare('SELECT * FROM bookings').get();
  expect(await notifyRosterOfChange(env, -123, booking, player(1), 'joined')).toEqual({ allTold: true });
  expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Message cleanup record failed'));
});

it('does not report a saved seating as failed when notification reads fail', async () => {
  env.DEFAULT_PLAYERS = '@sam';
  const prepare = env.DB.prepare;
  env.DB.prepare = (query) => {
    if (query.includes('FROM booking_players WHERE booking_id = ? ORDER BY')) {
      throw new Error('notice lookup unavailable');
    }
    return prepare(query);
  };
  vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await seatPlayer(env, -123, 3, '@sam', 1, 9)).toMatchObject({ changed: true, status: 'added' });
  expect(sql.prepare('SELECT slug FROM booking_players').get().slug).toBe('@sam');
  expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Roster notice failed'));
});

it('keeps a committed identity link when queuing its optional tab drawing fails', async () => {
  sql.prepare(`INSERT INTO ledger
    (chat_id, slug, name, amount_cents, reason, created_at) VALUES (-123, '@sam', 'Sam', 600, 'Court', ?)`)
    .run(Date.now());
  const prepare = env.DB.prepare;
  env.DB.prepare = (query) => {
    if (query.includes('INSERT INTO pending_refreshes')) throw new Error('queue unavailable');
    return prepare(query);
  };
  vi.spyOn(console, 'log').mockImplementation(() => {});
  await expect(rememberLedgerIdentity(env, -123, { id: 1, username: 'sam' })).resolves.toBeUndefined();
  expect(sql.prepare('SELECT user_id FROM ledger_identity_aliases').get().user_id).toBe(1);
  expect(sql.prepare('SELECT user_id FROM ledger').get().user_id).toBe(1);
});

it('matches independent Telegram HMAC signatures across repeated calls and token changes', async () => {
  const fields = { user: '{"id":9}', auth_date: '1794100000', start_param: 'g-123' };
  const check = Object.keys(fields).sort().map((key) => `${key}=${fields[key]}`).join('\n');
  for (const token of ['first-token', 'first-token', 'second-token', 'first-token']) {
    const secret = createHmac('sha256', 'WebAppData').update(token).digest();
    const expected = createHmac('sha256', secret).update(check).digest('hex');
    expect(await signInitData(token, fields)).toBe(expected);
  }
});

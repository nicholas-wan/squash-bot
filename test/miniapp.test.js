import { afterEach, describe, expect, it, vi } from 'vitest';
import worker, { handleUpdate } from '../src/index.js';
import { restoreBoardButtons } from '../src/bookings.js';
import { miniAppLink } from '../src/miniapp-link.js';
import { signInitData, verifyInitData } from '../src/miniapp-auth.js';
import { clearAdminCache } from '../src/players.js';

const TOKEN = 'test-token';
const CHAT = -123456789;

// Launch data the way Telegram hands it to the page: a query string whose hash
// is signed with the bot's token.
async function initData(fields, token = TOKEN) {
  const signed = {
    auth_date: String(Math.floor(Date.now() / 1000)),
    start_param: `g${CHAT}`,
    user: JSON.stringify({ id: 9, username: 'admin', first_name: 'Ad' }),
    ...fields,
  };
  signed.hash = await signInitData(token, signed);
  return new URLSearchParams(signed).toString();
}

function stubTelegram(requests, { member = 'member' } = {}) {
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    const body = JSON.parse(init.body);
    requests.push({ url: String(url), body });
    const result = String(url).endsWith('/getChatMember')
      ? { status: member } : { message_id: 1, ephemeral_message_id: 12 };
    return new Response(JSON.stringify({ ok: true, result }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }));
}

function apiRequest(path, auth, body) {
  return new Request(`https://squashbot.test/api/app/${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { ...(auth ? { Authorization: `tma ${auth}` } : {}), 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
}

// A date three days out in Singapore, as the page's date input sends it.
function futureDate(days = 3) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Singapore', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(Date.now() + days * 86400000));
  return parts;
}

function bookingDb(booking, { ran = [], conflict = null, bound = [] } = {}) {
  const db = { prepare(sql) { return { bind(...args) { bound.push({ sql: sql.trim(), args }); return {
    async first() {
      if (sql.includes('SELECT tz')) return { tz: 'Asia/Singapore' };
      if (sql.includes('SELECT * FROM bookings WHERE id')) return booking;
      if (sql.includes('SELECT ends_at FROM bookings')) return { ends_at: booking.ends_at };
      if (sql.includes('board_message_id')) return { board_message_id: 55 };
      return null;
    },
    async all() {
      if (sql.includes('FROM ledger')) return { results: [{ slug: '@bo', name: '@bo', user_id: 42 }] };
      if (sql.includes('FROM booking_players')) {
        return { results: [{ id: 1, booking_id: 3, user_id: 7, slug: 'u7', name: 'Nick' }] };
      }
      if (conflict && sql.includes('LOWER(TRIM(court))')) return { results: [conflict] };
      return { results: sql.includes('ends_at >') ? [booking] : [] };
    },
    async run() {
      ran.push(sql.trim());
      return { meta: { changes: conflict && sql.trim().startsWith('UPDATE bookings') ? 0 : 1 } };
    },
  }; } }; } };
  db.batch = async (statements) => Promise.all(statements.map((statement) => statement.run()));
  return db;
}

function futureBooking() {
  const startsAt = Date.now() + 3 * 86400000;
  return {
    id: 3, chat_id: CHAT, court: '4', capacity: 3, created_by_name: '@admin',
    starts_at: startsAt, ends_at: startsAt + 3600000, reminder_at: startsAt - 3600000,
  };
}

const env = (db, extra = {}) => ({
  BOT_TOKEN: TOKEN, ALLOWED_CHATS: String(CHAT), OWNER_USER_ID: '9', DB: db, ...extra,
});

describe('Mini App launch data', () => {
  it('accepts what Telegram signed and names the user and group', async () => {
    const session = await verifyInitData({ BOT_TOKEN: TOKEN }, await initData());
    expect(session.user.id).toBe(9);
    expect(session.startParam).toBe(`g${CHAT}`);
  });

  it('refuses tampered, stale, unsigned, and foreign launch data', async () => {
    const good = new URLSearchParams(await initData());
    const tampered = new URLSearchParams(good);
    tampered.set('user', JSON.stringify({ id: 1, username: 'mallory' }));
    const unsigned = new URLSearchParams(good);
    unsigned.delete('hash');
    const stale = await initData({ auth_date: String(Math.floor(Date.now() / 1000) - 2 * 86400) });
    const foreign = await initData({}, 'some-other-bot-token');
    for (const raw of [tampered.toString(), unsigned.toString(), stale, foreign, '']) {
      expect(await verifyInitData({ BOT_TOKEN: TOKEN }, raw)).toBeNull();
    }
  });
});

describe('Mini App API', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    clearAdminCache();
  });

  it('turns away a request Telegram did not sign', async () => {
    stubTelegram([]);
    const response = await worker.fetch(apiRequest('courts', null), env(bookingDb(futureBooking())));
    expect(response.status).toBe(401);
  });

  it('turns away a link to a group the bot does not serve', async () => {
    stubTelegram([]);
    const auth = await initData({ start_param: 'g-555' });
    const response = await worker.fetch(apiRequest('courts', auth), env(bookingDb(futureBooking())));
    expect(response.status).toBe(403);
  });

  it('shows a member the courts, with names only where they play', async () => {
    stubTelegram([], { member: 'member' });
    const listed = async (userId) => (await (await worker.fetch(
      apiRequest('courts', await initData({ user: JSON.stringify({ id: userId, first_name: 'X' }) })),
      env(bookingDb(futureBooking()))
    )).json());
    // Nick (7) is on the court and sees who with; Sam (8) is not and does not.
    const nick = await listed(7);
    expect(nick.admin).toBe(false);
    expect(nick.courts[0]).toMatchObject({ mine: true, heads: 1, capacity: 3 });
    expect(nick.courts[0].players.map((player) => player.name)).toEqual(['Nick']);
    expect(nick.players).toEqual([]);
    const sam = await listed(8);
    expect(sam.courts[0]).toMatchObject({ mine: false, players: [] });
  });

  it('refuses a member anything past their own slot, with the chat panel’s words', async () => {
    stubTelegram([], { member: 'member' });
    const auth = await initData({ user: JSON.stringify({ id: 7, first_name: 'Nick' }) });
    const ran = [];
    for (const [path, body] of [['court/3', null], ['court/3/seat', { slug: '@bo', heads: 1 }]]) {
      const response = await worker.fetch(
        apiRequest(path, auth, body), env(bookingDb(futureBooking(), { ran }))
      );
      expect(response.status).toBe(403);
      expect((await response.json()).message).toBe('Only group admins can manage bookings.');
    }
    // Refused before it touches anything.
    expect(ran).toHaveLength(0);
  });

  it('lets a member join, tells the court, and redraws the board', async () => {
    const requests = [];
    const ran = [];
    stubTelegram(requests, { member: 'member' });
    const response = await worker.fetch(
      apiRequest('court/3/join',
        await initData({ user: JSON.stringify({ id: 8, username: 'sam', first_name: 'Sam' }) }), {}),
      env(bookingDb(futureBooking(), { ran }))
    );
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.message).toBe('You are in.');
    expect(body.courts).toHaveLength(1);
    expect(ran.some((sql) => sql.startsWith('INSERT OR IGNORE INTO booking_players'))).toBe(true);
    const sent = requests.filter((r) => r.url.endsWith('/sendMessage'));
    // Nick, already on it, hears; Sam has the app's own toast instead of a
    // private message nothing was tapped to receive.
    expect(sent.find((r) => r.body.receiver_user_id === 7).body.text).toContain('joined');
    expect(sent.some((r) => r.body.receiver_user_id === 8)).toBe(false);
    expect(requests.some((r) => r.url.endsWith('/editMessageText') && r.body.message_id === 55))
      .toBe(true);
  });

  it('lists the courts for an admin', async () => {
    stubTelegram([]);
    const response = await worker.fetch(
      apiRequest('courts', await initData()), env(bookingDb(futureBooking()))
    );
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.courts).toHaveLength(1);
    expect(body.courts[0]).toMatchObject({ id: 3, court: 'Court 4', heads: 1, capacity: 3 });
    expect(body.players.map((player) => player.slug)).toContain('@bo');
  });

  it('seats a player with the chat panel’s notices and board refresh', async () => {
    const requests = [];
    const ran = [];
    stubTelegram(requests);
    const response = await worker.fetch(
      apiRequest('court/3/seat', await initData(), { slug: '@bo', heads: 1 }),
      env(bookingDb(futureBooking(), { ran }))
    );
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.message).toContain('@bo is on this court');
    expect(body.court.id).toBe(3);
    expect(ran.some((sql) => sql.startsWith('INSERT OR IGNORE INTO booking_players'))).toBe(true);
    // The seated player hears it, and the pinned board is redrawn.
    expect(requests.some((r) => r.url.endsWith('/sendMessage') && r.body.receiver_user_id === 42))
      .toBe(true);
    expect(requests.some((r) => r.url.endsWith('/editMessageText') && r.body.message_id === 55))
      .toBe(true);
  });

  it('answers an overlapping edit with the clash, then saves it when forced', async () => {
    stubTelegram([]);
    const booking = futureBooking();
    const clash = { id: 4, court: '2', starts_at: booking.starts_at, ends_at: booking.ends_at };
    const form = { date: futureDate(), start: '20:00', end: '21:00', court: '2' };
    const refused = await worker.fetch(
      apiRequest('court/3/edit', await initData(), form),
      env(bookingDb(booking, { conflict: clash }))
    );
    expect(refused.status).toBe(409);
    const body = await refused.json();
    expect(body.conflict).toBe(true);
    expect(body.conflicts[0]).toContain('Court 2');
    const forced = await worker.fetch(
      apiRequest('court/3/edit', await initData(), { ...form, force: true }),
      env(bookingDb(booking))
    );
    expect((await forced.json()).ok).toBe(true);
  });

  it('holds a form to the same hours as a typed booking', async () => {
    stubTelegram([]);
    const response = await worker.fetch(
      apiRequest('court/3/edit', await initData(),
        { date: futureDate(), start: '22:30', end: '', court: '4' }),
      env(bookingDb(futureBooking()))
    );
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.message).toContain('9pm');
  });
});

describe('The pinned board’s button', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('links to the Mini App for this group, compact, and to one court when asked', () => {
    expect(miniAppLink({}, CHAT)).toBeNull();
    const app = { MINI_APP_URL: 'https://t.me/squash_book_bot/manage' };
    const link = new URL(miniAppLink(app, CHAT));
    expect(link.searchParams.get('startapp')).toBe(`g${CHAT}`);
    expect(link.searchParams.get('mode')).toBe('compact');
    expect(new URL(miniAppLink(app, CHAT, 3)).searchParams.get('startapp')).toBe(`g${CHAT}_b3`);
  });

  it('opens the Mini App once one is registered, and the private list until then', async () => {
    for (const [extra, button] of [
      [{}, { text: '🙋 Join', callback_data: 'sb:join' }],
      [{ MINI_APP_URL: 'https://t.me/squash_book_bot/manage' }, {
        text: '🎾 Courts',
        url: `https://t.me/squash_book_bot/manage?startapp=g${CHAT}&mode=compact`,
      }],
    ]) {
      const requests = [];
      stubTelegram(requests);
      await restoreBoardButtons(env(bookingDb(futureBooking()), extra), CHAT, 55);
      const edit = requests.find((r) => r.url.endsWith('/editMessageReplyMarkup'));
      expect(edit.body.reply_markup.inline_keyboard).toEqual([[button]]);
    }
  });
});

describe('Booking changes from the Mini App', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    clearAdminCache();
  });

  const member = (id) => initData({ user: JSON.stringify({ id, first_name: 'M' }) });
  const form = () => ({ date: futureDate(), start: '20:00', end: '21:00', court: '4' });

  it('lets a member add a booking, but not name another booker or make it free', async () => {
    stubTelegram([], { member: 'member' });
    const bound = [];
    const response = await worker.fetch(
      apiRequest('courts', await member(8), { ...form(), booker: '@bo', free: true }),
      env(bookingDb(futureBooking(), { bound }))
    );
    const body = await response.json();
    expect(body.ok).toBe(true);
    // A member goes back to the list rather than to an admin's court screen.
    expect(body.courts).toBeDefined();
    expect(body.court).toBeUndefined();
    const insert = bound.find((call) => call.sql.startsWith('INSERT INTO bookings'));
    // created_by_user_id is the member, and free (the last column) is off.
    expect(insert.args).toContain(8);
    expect(insert.args).not.toContain(42);
    expect(insert.args[13]).toBe(0);
  });

  it('lets whoever booked a court change it, and nobody else short of an admin', async () => {
    stubTelegram([], { member: 'member' });
    const booking = { ...futureBooking(), created_by_user_id: 8 };
    const stranger = await worker.fetch(
      apiRequest('court/3/edit', await member(7), form()), env(bookingDb(booking))
    );
    expect((await stranger.json()).message).toContain('or a group admin can edit');
    const booker = await worker.fetch(
      apiRequest('court/3/edit', await member(8), { ...form(), start: '19:00', end: '20:00' }),
      env(bookingDb(booking))
    );
    expect((await booker.json()).ok).toBe(true);
  });

  it('refuses a save from a form opened before somebody else changed the court', async () => {
    stubTelegram([]);
    const booking = futureBooking();
    const ran = [];
    const response = await worker.fetch(
      apiRequest('court/3/edit', await initData(), {
        ...form(), start: '19:00', end: '20:00',
        expected: { startsAt: booking.starts_at, endsAt: booking.ends_at, court: '2' },
      }),
      env(bookingDb(booking, { ran }))
    );
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.message).toContain('changed this booking while you had it open');
    expect(ran.some((sql) => sql.startsWith('UPDATE bookings'))).toBe(false);
  });

  it('tags in the group whoever a cancellation could not reach privately', async () => {
    const requests = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      const body = JSON.parse(init.body);
      requests.push({ url: String(url), body });
      // Nick (7) is offline: his private copy is refused.
      const refused = String(url).endsWith('/sendMessage') && body.receiver_user_id === 7;
      return new Response(JSON.stringify(refused
        ? { ok: false, description: 'Bad Request: message could not be delivered' }
        : { ok: true, result: { message_id: 1, ephemeral_message_id: 12 } }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }));
    const response = await worker.fetch(
      apiRequest('court/3/delete', await initData(), {}), env(bookingDb(futureBooking()))
    );
    expect((await response.json()).ok).toBe(true);
    const group = requests.find((r) => r.url.endsWith('/sendMessage') && !r.body.receiver_user_id);
    expect(group.body.text).toContain('Cancelled');
    expect(group.body.text).toContain('tg://user?id=7');
    expect(group.body.disable_notification).toBe(true);
  });
});

describe('Settling the tab', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    clearAdminCache();
  });

  it('opens the settle list privately instead of taking over the pinned tab', async () => {
    const requests = [];
    stubTelegram(requests);
    await handleUpdate(env(bookingDb(futureBooking())), {
      callback_query: {
        id: 'callback-1', data: 'tb:pay',
        from: { id: 9, username: 'admin' },
        message: { message_id: 60, chat: { id: CHAT } },
      },
    });
    // The pinned tab's keyboard is everyone's; it is left alone.
    expect(requests.some((r) => r.url.endsWith('/editMessageReplyMarkup'))).toBe(false);
    const panel = requests.find((r) => r.url.endsWith('/sendMessage'));
    expect(panel.body.receiver_user_id).toBe(9);
    expect(panel.body.text).toContain('Settle the tab');
  });
});

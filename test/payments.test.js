import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index.js';
import { signInitData } from '../src/miniapp-auth.js';
import { clearAdminCache } from '../src/players.js';
import { recordPayment, tabMarkup, tabStory, undoEntry } from '../src/tab.js';

const CHAT = -123;
const DAY = 86400000;
let db, env, requests;

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  env = {
    BOT_TOKEN: 'test-token', ALLOWED_CHATS: String(CHAT), OWNER_USER_ID: '9', OWNER_NAME: 'Nicholas',
    DB: {
      prepare(sql) { return { bind(...args) {
        const statement = db.prepare(sql);
        return {
          async first() { return statement.get(...args) || null; },
          async all() { return { results: statement.all(...args) }; },
          async run() {
            const result = statement.run(...args);
            return { meta: { changes: result.changes, last_row_id: Number(result.lastInsertRowid) } };
          },
        };
      } }; },
    },
  };
  requests = [];
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    const body = JSON.parse(init.body);
    requests.push({ method: String(url).split('/').at(-1), ...body });
    const result = body.receiver_user_id ? { ephemeral_message_id: 7 } : { message_id: 100 };
    return new Response(JSON.stringify({ ok: true, result }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }));
});
afterEach(() => {
  db.close();
  vi.unstubAllGlobals();
  clearAdminCache();
});

function charge(slug, cents, reason, { userId = null, at = Date.now() - DAY, bookingId = null } = {}) {
  db.prepare(`INSERT INTO ledger (chat_id, slug, user_id, name, amount_cents, booking_id, reason, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(CHAT, slug, userId, slug, cents, bookingId, reason, at);
}
const balance = (slug) => db.prepare('SELECT COALESCE(SUM(amount_cents), 0) AS b FROM ledger WHERE slug = ?')
  .get(slug).b;
const admin = { id: 9, username: 'nicholaswan' };

describe('Recording payments', () => {
  it('records part of a balance, then the rest as a clear', async () => {
    charge('u5', 1735, 'Court 4 · 20 Oct', { userId: 5, bookingId: 1 });
    const part = await recordPayment(env, CHAT, 'u5', 1000, admin, 1735);
    expect(part).toMatchObject({ status: 'paid', paid: 1000, balance: 735, userId: 5 });
    const rest = await recordPayment(env, CHAT, 'u5', 735, admin, 735);
    expect(rest.balance).toBe(0);
    const reasons = db.prepare('SELECT reason FROM ledger WHERE amount_cents < 0 ORDER BY id').all()
      .map((row) => row.reason);
    expect(reasons).toEqual(['Paid · recorded by @nicholaswan', 'Cleared by @nicholaswan']);
  });

  it('leaves an overpayment as credit', async () => {
    charge('u5', 1735, 'Court 4 · 20 Oct', { userId: 5, bookingId: 1 });
    expect((await recordPayment(env, CHAT, 'u5', 2000, admin, 1735)).balance).toBe(-265);
  });

  it('writes nothing when the balance moved since the admin looked', async () => {
    charge('u5', 600, 'Court 4 · 20 Oct', { userId: 5, bookingId: 1 });
    charge('u5', 400, 'Court 2 · 22 Oct', { userId: 5, bookingId: 2 });
    expect(await recordPayment(env, CHAT, 'u5', 600, admin, 600))
      .toEqual({ status: 'stale', balance: 1000 });
    expect(balance('u5')).toBe(1000);
  });

  it('refuses a zero, negative or absurd amount', async () => {
    charge('u5', 600, 'Court 4', { userId: 5, bookingId: 1 });
    for (const cents of [0, -100, 150000, 12.5]) {
      expect((await recordPayment(env, CHAT, 'u5', cents, admin, 600)).status).toBe('amount');
    }
  });
});

describe('Undoing entries', () => {
  it('takes back a recorded payment or a /debt entry, never a court charge', async () => {
    charge('u5', 600, 'Court 4 · 20 Oct', { userId: 5, bookingId: 1 });
    charge('u5', 200, 'Ball · by @nicholaswan · 21 Oct', { userId: 5 });
    await recordPayment(env, CHAT, 'u5', 500, admin, 800);
    const [court, debt, payment] = db.prepare('SELECT id FROM ledger ORDER BY id').all().map((row) => row.id);
    expect(await undoEntry(env, CHAT, court)).toBeNull();
    expect(await undoEntry(env, CHAT, payment)).toMatchObject({ payment: true, cents: -500, balance: 800 });
    expect(await undoEntry(env, CHAT, debt)).toMatchObject({ payment: false, balance: 600 });
    // Twice is nothing the second time.
    expect(await undoEntry(env, CHAT, debt)).toBeNull();
  });

  it('marks only recent payments and /debt entries as undoable', () => {
    const now = Date.now();
    const story = tabStory([
      { id: 1, amount_cents: 600, booking_id: 1, reason: 'Court 4', created_at: now - DAY },
      { id: 2, amount_cents: -600, booking_id: null, reason: 'Cleared by @n', created_at: now - 10 * DAY },
      { id: 3, amount_cents: 200, booking_id: null, reason: 'Ball · by @n · 1 Oct', created_at: now - DAY },
      { id: 4, amount_cents: -100, booking_id: null, reason: 'Paid · recorded by @n', created_at: now },
    ], 'Asia/Singapore', now);
    expect(story.balance).toBe(100);
    expect(story.lines.map((line) => [line.id, line.undoable]))
      .toEqual([[1, false], [2, false], [3, true], [4, true]]);
  });
});

describe('The tab in the Mini App', () => {
  async function auth(user) {
    const fields = {
      auth_date: String(Math.floor(Date.now() / 1000)), start_param: `g${CHAT}_tab`,
      user: JSON.stringify(user),
    };
    fields.hash = await signInitData('test-token', fields);
    return new URLSearchParams(fields).toString();
  }
  const call = async (path, user, body) => (await worker.fetch(
    new Request(`https://squashbot.test/api/app/${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: `tma ${await auth(user)}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    }), env
  )).json();

  it('shows a member their own tab and nobody else’s', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ ok: true, result: { status: 'member' } }),
      { headers: { 'Content-Type': 'application/json' } }
    )));
    charge('u5', 433, 'Court 2 · 21 Oct · 7pm–9pm · $13.00 ÷ 3', { userId: 5, bookingId: 1 });
    charge('u6', 600, 'Court 4 · 20 Oct', { userId: 6, bookingId: 2 });
    const tab = await call('tab', { id: 5, first_name: 'Sam' });
    expect(tab.admin).toBe(false);
    expect(tab.me.balance).toBe(433);
    expect(tab.me.lines[0].label).toContain('$13.00 ÷ 3');
    expect(tab.people).toEqual([]);
    expect((await call('tab/person/u6', { id: 5, first_name: 'Sam' })).ok).toBe(false);
    expect((await call('tab/person/u6/pay', { id: 5, first_name: 'Sam' }, { cents: 600, expected: 600 })).ok)
      .toBe(false);
    expect(balance('u6')).toBe(600);
  });

  it('lets an admin record a part payment and sends the player a receipt', async () => {
    charge('u5', 1735, 'Court 4 · 20 Oct', { userId: 5, bookingId: 1 });
    const tab = await call('tab', admin);
    expect(tab.people).toEqual([{ slug: 'u5', name: 'u5', balance: 1735 }]);
    const paid = await call('tab/person/u5/pay', admin, { cents: 1000, expected: 1735 });
    expect(paid.ok).toBe(true);
    expect(paid.message).toContain('They have a receipt');
    expect(paid.person.balance).toBe(735);
    const receipt = requests.find((r) => r.method === 'sendMessage' && r.receiver_user_id === 5);
    expect(receipt.text).toContain('Payment received');
    expect(receipt.text).toContain('You now owe <b>$7.35</b>');
    // The undo comes back the same way, and they are told.
    const line = paid.person.lines.find((entry) => entry.cents === -1000);
    const undone = await call(`tab/entry/${line.id}/undo`, admin, {});
    expect(undone.person.balance).toBe(1735);
    expect(requests.filter((r) => r.receiver_user_id === 5).at(-1).text).toContain('was undone');
  });
});

describe('The pinned tab’s button', () => {
  it('opens the Mini App on the tab once one is registered', () => {
    const balances = [{ slug: 'u5', name: 'Sam', balance: 600 }];
    expect(tabMarkup(balances).inline_keyboard[0][0].callback_data).toBe('tb:mine');
    const markup = tabMarkup(balances, 'https://t.me/squash_book_bot/manage?startapp=g-123_tab');
    expect(markup).toEqual({ inline_keyboard: [[{
      text: '🧾 Tab', url: 'https://t.me/squash_book_bot/manage?startapp=g-123_tab',
    }]] });
  });
});

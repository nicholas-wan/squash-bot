import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  chargeBooking, myTabView, settleMarkup, settleUser, tabHtml, tabMarkup,
  theirTabView, updateTab,
} from '../src/tab.js';

const env = {
  OWNER: '@nicholaswan',
  OWNER_NAME: 'Nicholas',
  DEFAULT_PLAYERS: '@nicholaswan,@dodgerblueee',
};

// Wednesday 19 Aug 2026, 9–10pm Singapore time: the $6 evening rate.
const booking = {
  id: 3,
  chat_id: -123,
  court: '4',
  starts_at: Date.UTC(2026, 7, 19, 13, 0),
  ends_at: Date.UTC(2026, 7, 19, 14, 0),
  charged: 0,
};

const roster = [
  { slug: '@nicholaswan', user_id: 5, name: '@nicholaswan' },
  { slug: '@dodgerblueee', user_id: null, name: '@dodgerblueee' },
  { slug: 'u9', user_id: 9, name: 'Alice' },
];

function ledgerDb(inserts) {
  return {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async first() {
              return sql.includes('SELECT tz') ? { tz: 'Asia/Singapore' } : null;
            },
            async run() {
              if (sql.includes('INSERT OR IGNORE INTO ledger')) inserts.push(args);
              return { meta: { changes: 1 } };
            },
          };
        },
      };
    },
  };
}

describe('money tab', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('keeps a kicked sibling chat from breaking the tab update', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      const body = JSON.parse(init.body);
      const kicked = body.chat_id === -999;
      return new Response(JSON.stringify(kicked
        ? { ok: false, error_code: 403, description: 'Forbidden: bot was kicked from the supergroup chat' }
        : { ok: true, result: { message_id: 66 } }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }));
    const db = { prepare(sql) { return { bind() { return {
      async first() {
        if (sql.includes('SELECT tz')) return { tz: 'Asia/Singapore' };
        if (sql.includes('tab_message_id')) {
          return { board_message_id: null, tab_message_id: 66 };
        }
        return null;
      },
      async all() {
        return { results: sql.includes('GROUP BY')
          ? [{ slug: 'u9', user_id: 9, name: '@alice', balance: 200 }] : [] };
      },
      async run() { return { meta: { changes: 1 } }; },
    }; } }; } };
    const shared = {
      ...env, BOT_TOKEN: 'test', ALLOWED_CHATS: '-123,-999', DATA_CHAT_ID: '-999', DB: db,
    };
    // From the healthy chat, the sibling's failure is logged, not thrown, and
    // the healthy chat's own pin still comes back.
    await expect(updateTab(shared, -123)).resolves.toBe(66);
    // From the kicked chat itself, the failure still surfaces.
    await expect(updateTab(shared, -999)).rejects.toThrow('kicked');
  });

  it('charges everyone except the organiser household an equal share', async () => {
    const inserts = [];
    const charged = await chargeBooking({ ...env, DB: ledgerDb(inserts) }, booking, roster);
    expect(charged).toBe(1);
    expect(inserts).toHaveLength(1);
    const [chatId, slug, userId, name, amount, bookingId, reason] = inserts[0];
    expect({ chatId, slug, userId, name, amount, bookingId }).toEqual({
      chatId: -123, slug: 'u9', userId: 9, name: 'Alice', amount: 200, bookingId: 3,
    });
    expect(reason).toBe('Court 4 · 19 Aug');
  });

  it('never charges a booking twice', async () => {
    const inserts = [];
    const charged = await chargeBooking(
      { ...env, DB: ledgerDb(inserts) }, { ...booking, charged: 1 }, roster
    );
    expect(charged).toBe(0);
    expect(inserts).toHaveLength(0);
  });

  it('charges nothing when only the household played', async () => {
    const inserts = [];
    await chargeBooking({ ...env, DB: ledgerDb(inserts) }, booking, roster.slice(0, 2));
    expect(inserts).toHaveLength(0);
  });

  it('renders outstanding balances and a settle button', () => {
    const balances = [
      { slug: 'u9', user_id: 9, name: '@alice', balance: 800 },
      { slug: 'u11', user_id: 11, name: '@bob', balance: 400 },
    ];
    const html = tabHtml(env, balances);
    expect(html).toContain('Owed to Nicholas');
    expect(html).toContain('• @alice — <b>$8.00</b>');
    expect(html).toContain('• @bob — <b>$4.00</b>');
    expect(html).not.toContain('Total');
    const keyboard = tabMarkup(balances).inline_keyboard;
    expect(keyboard[0][0].callback_data).toBe('tb:mine');
    expect(keyboard[1][0].callback_data).toBe('tb:pay');
  });

  it('unpins itself once everyone has settled', () => {
    expect(tabHtml(env, [])).toBe(null);
  });

  it('offers the manage button for a debtor with no numeric id', async () => {
    // Someone named by username in an imported balance has no Telegram id until
    // they post. Keying the button on the id hid the whole menu.
    const balances = [{ slug: '@thadduu', user_id: null, name: '@thadduu', balance: 1400 }];
    expect(tabMarkup(balances).inline_keyboard[1][0].callback_data).toBe('tb:pay');
    const db = { prepare() { return { bind() { return {
      async all() { return { results: balances }; },
    }; } }; } };
    const markup = await settleMarkup({ ...env, DB: db }, -123);
    expect(markup.inline_keyboard[0][0]).toEqual({
      text: '✅ @thadduu · $14.00', callback_data: 'tb:pay:@thadduu',
    });
  });

  it('clears the settle button rather than leaving a stale one behind', () => {
    // editMessageText keeps the previous keyboard when reply_markup is omitted,
    // so the settle row has to be overwritten explicitly — My tab stays.
    expect(tabMarkup([{ slug: 'u9', user_id: 9, name: '@alice', balance: -150 }]))
      .toEqual({ inline_keyboard: [[{ text: '🧾 My tab', callback_data: 'tb:mine' }]] });
  });

  it('itemises one person’s charges and payments in their private breakdown', async () => {
    const rows = [
      {
        slug: '@thadduu', user_id: null, name: '@thadduu', amount_cents: 200,
        booking_id: null, reason: 'Squash · 30 Apr',
        created_at: Date.UTC(2026, 3, 30, 4, 0),
      },
      // An old spelling reconnected by numeric id, not slug.
      {
        slug: '@oldname', user_id: 42, name: '@oldname', amount_cents: 300,
        booking_id: 7, reason: 'Court 4 · 11 May',
        created_at: Date.UTC(2026, 4, 11, 4, 0),
      },
      {
        slug: '@thadduu', user_id: 42, name: '@thadduu', amount_cents: -200,
        booking_id: null, reason: 'Cleared by Nicholas',
        created_at: Date.UTC(2026, 4, 20, 4, 0),
      },
    ];
    const queries = [];
    const db = { prepare(sql) { return { bind(...args) {
      queries.push({ sql, args });
      return {
        async first() { return sql.includes('SELECT tz') ? { tz: 'Asia/Singapore' } : null; },
        async all() { return { results: rows }; },
      };
    } }; } };
    const view = await myTabView({ ...env, DB: db }, -123, { id: 42, username: 'thadduu' });
    // Slug or id, so history under an old username is still owned and shown.
    const ledgerQuery = queries.find((query) => query.sql.includes('FROM ledger'));
    expect(ledgerQuery.args).toEqual([-123, '@thadduu', 42]);
    expect(view.html).toContain('Owed to Nicholas: <b>$3.00</b>');
    expect(view.html).toContain('• Squash · 30 Apr — $2.00');
    expect(view.html).toContain('• Court 4 · 11 May — $3.00');
    expect(view.html).toContain('• Cleared by Nicholas · 20 May — −$2.00');
    expect(view.html).toContain('Only you can see this.');
  });

  it('tells someone with no history that nothing is owed', async () => {
    const db = { prepare() { return { bind() { return {
      async first() { return null; },
      async all() { return { results: [] }; },
    }; } }; } };
    const view = await myTabView({ ...env, DB: db }, -123, { id: 9, username: 'alice' });
    expect(view.html).toContain('Nothing here');
    // An ordinary member sees their own tab and nothing else.
    expect(view.replyMarkup.inline_keyboard.flat().map((button) => button.text))
      .toEqual(['👍 OK']);
  });

  it('offers an admin every open balance behind their own breakdown', async () => {
    const balances = [
      { slug: '@thadduu', user_id: null, name: '@thadduu', balance: 1400 },
      { slug: '@po1arb3ar', user_id: null, name: '@Po1arb3ar', balance: 1200 },
    ];
    const db = { prepare(sql) { return { bind() { return {
      async first() { return sql.includes('SELECT tz') ? { tz: 'Asia/Singapore' } : null; },
      async all() { return { results: sql.includes('GROUP BY') ? balances : [] }; },
    }; } }; } };
    const view = await myTabView(
      { ...env, DB: db }, -123, { id: 5, username: 'nicholaswan' }, true
    );
    const buttons = view.replyMarkup.inline_keyboard.flat();
    expect(buttons.map((button) => button.text)).toEqual([
      '🧾 @thadduu · $14.00', '🧾 @Po1arb3ar · $12.00', '👍 OK',
    ]);
    expect(buttons[0].callback_data).toBe('tb:mine:@thadduu');
  });

  it('renders one debtor’s tab for an admin, keyed by slug like the pinned tab', async () => {
    const rows = [
      {
        slug: '@thadduu', user_id: null, name: '@thadduu', amount_cents: 200,
        booking_id: null, reason: 'Squash · 30 Apr',
        created_at: Date.UTC(2026, 3, 30, 4, 0),
      },
      {
        slug: '@thadduu', user_id: null, name: '@thadduu', amount_cents: 300,
        booking_id: null, reason: 'Squash · 13 Aug',
        created_at: Date.UTC(2026, 7, 13, 4, 0),
      },
    ];
    const queries = [];
    const db = { prepare(sql) { return { bind(...args) {
      queries.push({ sql, args });
      return {
        async first() { return sql.includes('SELECT tz') ? { tz: 'Asia/Singapore' } : null; },
        async all() { return { results: sql.includes('FROM ledger') ? rows : [] }; },
      };
    } }; } };
    const view = await theirTabView({ ...env, DB: db }, -123, '@thadduu');
    expect(queries.find((query) => query.sql.includes('FROM ledger')).args)
      .toEqual([-123, '@thadduu']);
    expect(view.html).toContain('<b>@thadduu</b>');
    expect(view.html).toContain('Owed to Nicholas: <b>$5.00</b>');
    expect(view.html).toContain('• Squash · 30 Apr — $2.00');
    expect(view.replyMarkup.inline_keyboard[0][0])
      .toEqual({ text: '← Back to your tab', callback_data: 'tb:mine' });
  });

  it('has nothing to show for a slug with no ledger rows', async () => {
    const db = { prepare() { return { bind() { return {
      async first() { return null; },
      async all() { return { results: [] }; },
    }; } }; } };
    expect(await theirTabView({ ...env, DB: db }, -123, '@ghost')).toBe(null);
  });

  it('credits a settlement once even if two admins confirm it', async () => {
    // The confirm button sits on a shared pinned message, so both admins read
    // the same $8.00 balance. The second write must find the balance changed.
    const payments = [];
    let balance = 800;
    const db = {
      prepare(sql) {
        return {
          bind(...args) {
            return {
              async first() { return null; },
              async all() {
                return { results: balance === 0 ? [] : [{
                  slug: 'u9', balance, user_id: 9, name: 'Alice',
                }] };
              },
              async run() {
                if (!sql.includes('INSERT INTO ledger')) return { meta: { changes: 1 } };
                const expected = args[args.length - 1];
                if (expected !== balance) return { meta: { changes: 0 } };
                payments.push(args[4]);
                balance += args[4];
                return { meta: { changes: 1 } };
              },
            };
          },
        };
      },
    };
    const first = await settleUser({ ...env, DB: db }, -123, 'u9', { username: 'nicholaswan' });
    const second = await settleUser({ ...env, DB: db }, -123, 'u9', { username: 'nicholaswan' });
    expect(first.balance).toBe(800);
    expect(second).toBe(null);
    expect(payments).toEqual([-800]);
    expect(balance).toBe(0);
  });

  it('shows an overpayment as credit', () => {
    const html = tabHtml(env, [{ slug: 'u9', user_id: 9, name: '@alice', balance: -150 }]);
    expect(html).toContain('In credit');
    expect(html).toContain('• @alice — $1.50');
  });
});

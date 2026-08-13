import { describe, expect, it } from 'vitest';
import {
  chargeBooking, settleMarkup, settleUser, tabHtml, tabMarkup,
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
    expect(tabMarkup(balances).inline_keyboard[0][0].callback_data).toBe('tb:pay');
  });

  it('unpins itself once everyone has settled', () => {
    expect(tabHtml(env, [])).toBe(null);
  });

  it('offers the manage button for a debtor with no numeric id', async () => {
    // Someone named by username in an imported balance has no Telegram id until
    // they post. Keying the button on the id hid the whole menu.
    const balances = [{ slug: '@thadduu', user_id: null, name: '@thadduu', balance: 1400 }];
    expect(tabMarkup(balances).inline_keyboard[0][0].callback_data).toBe('tb:pay');
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
    // so an empty keyboard has to be sent explicitly.
    expect(tabMarkup([{ slug: 'u9', user_id: 9, name: '@alice', balance: -150 }]))
      .toEqual({ inline_keyboard: [] });
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

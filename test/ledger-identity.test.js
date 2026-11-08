import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { rememberLedgerIdentity } from '../src/ledger-identity.js';
import { adjustBalance, myTabView, tabBalances, settleUser, chargeBooking } from '../src/tab.js';

let db, env;
beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  env = { BOT_TOKEN: 'test', ALLOWED_CHATS: '-123', DB: {
    prepare(sql) { return { bind(...args) { return {
      async first() { return db.prepare(sql).get(...args) || null; },
      async all() { return { results: db.prepare(sql).all(...args) }; },
      async run() { return { meta: db.prepare(sql).run(...args) }; },
    }; } }; },
  } };
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, result: { message_id: 55 } }))));
});
afterEach(() => { db.close(); vi.unstubAllGlobals(); });
function charge(slug, userId, amount = 200, bookingId = null, chatId = -123) {
  db.prepare(`INSERT OR IGNORE INTO ledger
    (chat_id,slug,user_id,name,amount_cents,booking_id,reason,created_at)
    VALUES (?,?,?,?,?,?,'Court charge',?)`).run(chatId,slug,userId,slug,amount,bookingId,Date.now());
}

it('links provisional history and combines future charges under the verified id', async () => {
  charge('@alice', null, 600);
  await rememberLedgerIdentity(env, -123, { id: 42, username: 'Alice' });
  charge('u42', 42);
  expect(await tabBalances(env, -123)).toMatchObject([{ slug: 'u42', user_id: 42, balance: 800 }]);
  expect(db.prepare('SELECT COUNT(*) AS n FROM ledger').get().n).toBe(2);
  expect((await myTabView(env,-123,{id:42,username:'Alice'})).html).toContain('$8.00');
});

it('a renamed account keeps its full history and a reused username cannot claim it', async () => {
  charge('@alice', null, 600);
  await rememberLedgerIdentity(env,-123,{id:42,username:'alice'});
  await rememberLedgerIdentity(env,-123,{id:42,username:'newalice'});
  await rememberLedgerIdentity(env,-123,{id:99,username:'alice'});
  charge('@alice',99,300);
  const balances = await tabBalances(env,-123);
  expect(balances).toMatchObject([{slug:'u42',balance:600},{slug:'u99',balance:300}]);
  expect((await myTabView(env,-123,{id:99,username:'alice'})).html).not.toContain('$6.00');
  expect((await myTabView(env,-123,{id:42,username:'newalice'})).html).toContain('$6.00');
  expect(db.prepare("SELECT user_id FROM ledger_identity_aliases WHERE slug='@alice'").get().user_id).toBe(42);
});

it('does not merge display names or cross independent group ledgers', async () => {
  charge('nalice',null,200);
  charge('@alice',null,300,null,-456);
  await rememberLedgerIdentity(env,-123,{id:42,username:'alice',first_name:'Alice'});
  expect(db.prepare('SELECT COUNT(*) AS n FROM ledger WHERE user_id IS NULL').get().n).toBe(2);
});

it('settles the whole combined balance once, including historical payments', async () => {
  charge('@alice',null,600); charge('@alice',null,-200);
  await rememberLedgerIdentity(env,-123,{id:42,username:'alice'});
  charge('u42',42,200);
  expect((await settleUser(env,-123,'u42',{id:1,first_name:'Admin'})).balance).toBe(600);
  expect(await tabBalances(env,-123)).toEqual([]);
  expect(await settleUser(env,-123,'u42',{id:1})).toBeNull();
  expect(db.prepare('SELECT COUNT(*) AS n FROM ledger').get().n).toBe(4);
});

it('normalizes legacy writes and prevents a second charge for the same court under an alias', async () => {
  await rememberLedgerIdentity(env,-123,{id:42,username:'alice'});
  charge('u42',42,200,7);
  charge('@alice',null,200,7);
  charge('@alice',42,200,7);
  expect(db.prepare('SELECT COUNT(*) AS n FROM ledger').get().n).toBe(1);
  expect(await tabBalances(env,-123)).toMatchObject([{slug:'u42',balance:200}]);
});

it('resolves known aliases when billing a config-seeded player without a roster id', async () => {
  await rememberLedgerIdentity(env,-123,{id:42,username:'alice'});
  const start=Date.UTC(2026,8,10,13);
  const booked={id:7,chat_id:-123,starts_at:start,ends_at:start+3600000,court:'4',charged:0};
  expect(await chargeBooking(env,booked,[{slug:'@alice',name:'@alice',heads:1}])).toBe(1);
  expect(await chargeBooking(env,booked,[{slug:'u42',user_id:42,name:'@alice',heads:1}])).toBe(0);
  expect(await tabBalances(env,-123)).toMatchObject([{slug:'u42',user_id:42,balance:600}]);
});

it('migrates legacy account keys without changing amounts or dropping history', async () => {
  // Recreate the pre-migration ledger by removing only its identity triggers.
  db.exec('DROP TRIGGER ledger_identity_insert; DROP TRIGGER ledger_identity_update;');
  charge('@alice',42,200,7); charge('@alice',null,300); charge('u42',42,200,8);
  const before=db.prepare('SELECT id,amount_cents,booking_id,reason,created_at FROM ledger ORDER BY id').all();
  const migration=readFileSync(new URL('../migrations/013-ledger-identities.sql',import.meta.url),'utf8');
  db.exec(migration); db.exec(migration);
  expect(db.prepare('SELECT id,amount_cents,booking_id,reason,created_at FROM ledger ORDER BY id').all()).toEqual(before);
  expect(await tabBalances(env,-123)).toMatchObject([{slug:'u42',user_id:42,balance:700}]);
});

it('reserves ambiguous old aliases instead of assigning unlinked history to either account', async () => {
  db.exec('DROP TRIGGER ledger_identity_insert; DROP TRIGGER ledger_identity_update;');
  charge('@alice',42,200); charge('@alice',99,300); charge('@alice',null,400);
  db.exec(readFileSync(new URL('../migrations/013-ledger-identities.sql',import.meta.url),'utf8'));
  await rememberLedgerIdentity(env,-123,{id:99,username:'alice'});
  expect(db.prepare("SELECT user_id FROM ledger_identity_aliases WHERE slug='@alice'").get().user_id).toBe(0);
  expect(db.prepare('SELECT COUNT(*) AS n FROM ledger WHERE user_id IS NULL').get().n).toBe(1);
  expect((await myTabView(env,-123,{id:99,username:'alice'})).html).not.toContain('$4.00');
});

it('settles only the amount the admin confirmed, not a charge that landed since', async () => {
  charge('u42',42,1000);
  const confirmedCents = (await tabBalances(env,-123))[0].balance;
  charge('u42',42,600);
  const stale = await settleUser(env,-123,'u42',{id:1,first_name:'Admin'},confirmedCents);
  expect(stale).toMatchObject({ stale: true, balance: 1600 });
  expect((await tabBalances(env,-123))[0].balance).toBe(1600);
  expect((await settleUser(env,-123,'u42',{id:1,first_name:'Admin'},1600)).balance).toBe(1600);
  expect(await tabBalances(env,-123)).toEqual([]);
});

const ADMIN = { id: 1, first_name: 'Admin' };
const ledgerRows = () => db.prepare(
  "SELECT slug, user_id, amount_cents, booking_id FROM ledger WHERE slug IN ('@x','u123') ORDER BY id"
).all().map((row) => ({ ...row }));

it('keeps both charges when a claimed handle already shared a booking with the id', async () => {
  // A legacy @x seat and the same person joining by id were both billed for
  // booking 9. The claim used to skip the @x row, leaving a stray balance.
  charge('@x', null, 300, 9);
  charge('u123', 123, 300, 9);
  charge('@x', null, 50, 10);
  await rememberLedgerIdentity(env, -123, { id: 123, username: 'x' });
  expect(ledgerRows().filter((row) => row.slug === '@x')).toEqual([]);
  expect(await tabBalances(env, -123)).toMatchObject([{ slug: 'u123', balance: 650 }]);
  expect(await settleUser(env, -123, 'u123', ADMIN, 650)).toMatchObject({ balance: 650 });
  expect(await tabBalances(env, -123)).toEqual([]);
});

it('migration 018 replaces the claim trigger on a database that has the old one', async () => {
  const migration = readFileSync(new URL('../migrations/018-ledger-alias-conflicts.sql', import.meta.url), 'utf8');
  db.exec(migration); db.exec(migration);
  charge('@x', null, 300, 9);
  charge('u123', 123, 300, 9);
  await rememberLedgerIdentity(env, -123, { id: 123, username: 'x' });
  expect(await tabBalances(env, -123)).toMatchObject([{ slug: 'u123', balance: 600 }]);
  expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'idx_monthly_notice_slug'").get())
    .toBeTruthy();
});

it('migration 018 moves a stray handle balance the old trigger left onto the id', async () => {
  charge('u123', 123, 300, 9);
  charge('@x', null, 300, 9);
  // The old trigger's leftover, recreated with the claim trigger out of the way.
  db.exec('DROP TRIGGER ledger_alias_claim');
  db.prepare('INSERT INTO ledger_identity_aliases (chat_id, slug, user_id) VALUES (-123, ?, 123)').run('@x');
  expect(db.prepare("SELECT COUNT(*) AS n FROM ledger WHERE slug = '@x'").get().n).toBe(1);
  const migration = readFileSync(new URL('../migrations/018-ledger-alias-conflicts.sql', import.meta.url), 'utf8');
  db.exec(migration); db.exec(migration);
  expect(await tabBalances(env, -123)).toMatchObject([{ slug: 'u123', balance: 600 }]);
  expect(db.prepare("SELECT COUNT(*) AS n FROM ledger WHERE slug = '@x'").get().n).toBe(0);
});

it('does not call a clear stale when the trigger re-keyed the payment onto the id', async () => {
  // A stray @x balance the old trigger left behind, recreated by claiming the
  // alias with the claim trigger out of the way.
  charge('@x', null, 300, 9);
  db.exec('DROP TRIGGER ledger_alias_claim');
  db.prepare('INSERT INTO ledger_identity_aliases (chat_id, slug, user_id) VALUES (-123, ?, 123)').run('@x');
  const cleared = await settleUser(env, -123, '@x', ADMIN, 300);
  expect(cleared).toMatchObject({ balance: 300 });
  expect(cleared.stale).toBeUndefined();
  // One payment, not one per confirm.
  expect(db.prepare("SELECT COUNT(*) AS n FROM ledger WHERE reason LIKE 'Cleared by%'").get().n).toBe(1);
});

it('offers Undo for the row actually written when an alias is claimed mid-entry', async () => {
  charge('u9', 9, 100);
  const raced = { ...env, DB: { prepare(sql) {
    const real = env.DB.prepare(sql);
    if (!/^SELECT user_id FROM ledger_identity_aliases/.test(sql)) return real;
    // The account lookup finds no alias; the alias lands just after it.
    return { bind(...args) { return { async first() {
      const found = await real.bind(...args).first();
      db.prepare('INSERT INTO ledger_identity_aliases (chat_id, slug, user_id) VALUES (-123, ?, 123)').run('@x');
      return found;
    } }; } };
  } } };
  const entry = await adjustBalance(raced, -123, { slug: '@x', user_id: null, name: '@x' }, 500, 'Balls', ADMIN);
  const written = db.prepare("SELECT id, slug FROM ledger WHERE reason LIKE 'Balls%'").get();
  expect(written.slug).toBe('u123');
  expect(entry).toMatchObject({ id: written.id, balance: 500 });
});

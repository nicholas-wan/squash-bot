import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { rememberLedgerIdentity } from '../src/ledger-identity.js';
import { myTabView, tabBalances, settleUser, chargeBooking } from '../src/tab.js';

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

import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { nextMaintenanceDue, runScheduledMaintenance } from '../src/maintenance-schedule.js';

const now = Date.UTC(2026, 8, 10, 2); // 10am Singapore
let db, env, reads, mutateDuringCalculation;
beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  db.exec(readFileSync(new URL('../migrations/012-maintenance-schedule.sql', import.meta.url), 'utf8'));
  reads = []; mutateDuringCalculation = null;
  env = { ALLOWED_CHATS: '-123', DB: { prepare(sql) { return { bind(...args) {
    return {
      async first() {
        reads.push(sql);
        const result = db.prepare(sql).get(...args) || null;
        if (sql.startsWith('WITH scoped') && mutateDuringCalculation) mutateDuringCalculation();
        return result;
      },
      async run() { return { meta: db.prepare(sql).run(...args) }; },
    };
  } }; } } };
});
afterEach(() => db.close());
function booking() {
  db.prepare(`INSERT INTO bookings
    (id,chat_id,court,starts_at,ends_at,reminder_at,pre_reminder_at,created_at)
    VALUES (1,-123,'4',?,?,?,?,?)`)
    .run(now + 4*3600000, now + 5*3600000, now + 3600000, now + 2*3600000, now);
}
const success = async () => ({ ok: true, failures: [] });
const prune = async () => {};

it('does one schedule read and no work when nothing is due', async () => {
  booking();
  const work = vi.fn(success), cleanup = vi.fn(prune);
  const first = await runScheduledMaintenance(env, work, cleanup, now);
  expect(first.nextDue).toBe(now + 3600000);
  reads.length = 0;
  const second = await runScheduledMaintenance(env, work, cleanup, now + 60000);
  expect(second.skipped).toBe(true);
  expect(work).toHaveBeenCalledTimes(1);
  expect(cleanup).toHaveBeenCalledTimes(1);
  expect(reads).toHaveLength(1);
});

it('advances through reminders, start cleanup and the court end', async () => {
  booking();
  expect(await nextMaintenanceDue(env, now)).toBe(now + 3600000);
  db.exec('UPDATE bookings SET reminder_sent=1');
  expect(await nextMaintenanceDue(env, now)).toBe(now + 2*3600000);
  db.exec('UPDATE bookings SET pre_reminder_sent=1');
  expect(await nextMaintenanceDue(env, now)).toBe(now + 4*3600000);
  expect(await nextMaintenanceDue(env, now + 4*3600000)).toBe(now + 5*3600000);
});

it('excludes reminders already delivered to the whole roster', async () => {
  booking();
  db.prepare(`INSERT INTO booking_players
    (booking_id,chat_id,slug,name,created_at,reminder_sent,pre_reminder_sent)
    VALUES (1,-123,'u1','Player',?,1,1)`).run(now);
  expect(await nextMaintenanceDue(env, now)).toBe(now + 4*3600000);
});

it('booking edits and roster changes invalidate the cached deadline', async () => {
  booking();
  await runScheduledMaintenance(env, success, prune, now);
  db.prepare('UPDATE bookings SET reminder_at=?').run(now + 120000);
  expect(db.prepare('SELECT next_due FROM maintenance_schedule').get().next_due).toBe(0);
  expect((await runScheduledMaintenance(env, success, prune, now)).nextDue).toBe(now + 120000);
  db.prepare(`INSERT INTO booking_players (booking_id,chat_id,slug,name,created_at)
    VALUES (1,-123,'u1','Player',?)`).run(now);
  expect(db.prepare('SELECT next_due FROM maintenance_schedule').get().next_due).toBe(0);
});

it('preserves an invalidation arriving during deadline calculation', async () => {
  booking();
  mutateDuringCalculation = () => db.exec('UPDATE bookings SET capacity=4');
  await runScheduledMaintenance(env, success, prune, now);
  expect(db.prepare('SELECT next_due FROM maintenance_schedule').get().next_due).toBe(0);
});

it('rechecks changes made while a sweep is running', async () => {
  booking();
  const result = await runScheduledMaintenance(env, async () => {
    db.exec('UPDATE bookings SET capacity=4');
    return { ok: true, failures: [] };
  }, prune, now);
  expect(result.nextDue).toBe(now + 60000);
});

it('retries failures next minute without marking them healthy', async () => {
  const result = await runScheduledMaintenance(env,
    async () => ({ ok: false, failures: ['Telegram unavailable'] }), prune, now);
  expect(result).toMatchObject({ ok: false, nextDue: now + 60000 });
});

it('includes message cleanup, and never a queued tab notice', async () => {
  db.prepare(`INSERT INTO sent_messages (chat_id,message_id,delete_after,created_at)
    VALUES (-123,10,?,?)`).run(now + 120000, now);
  expect(await nextMaintenanceDue(env, now)).toBe(now + 120000);
  db.exec('DELETE FROM sent_messages');
  // A queued notice is delivered by the debtor's next post, not by cron, so a
  // row waiting all month must not turn every idle minute into a sweep.
  db.prepare(`INSERT INTO monthly_notice_deliveries
    (chat_id,month,slug,status,last_attempt_at) VALUES (-123,'2026-9','u1','pending',?)`).run(now);
  expect(await nextMaintenanceDue(env, now)).toBe(Date.UTC(2026,8,10,16));
});

it('retains midnight date refresh and morning notices with no courts', async () => {
  expect(await nextMaintenanceDue(env, now)).toBe(Date.UTC(2026,8,10,16));
  expect(await nextMaintenanceDue(env, Date.UTC(2026,8,11,0))).toBe(Date.UTC(2026,8,11,1));
});

it('ignores courts from groups the bot does not serve', async () => {
  booking(); db.exec('UPDATE bookings SET chat_id=-999');
  expect(await nextMaintenanceDue(env, now)).toBe(Date.UTC(2026,8,10,16));
});

it('does not push a near deadline past its actual time', async () => {
  booking();
  db.prepare('UPDATE bookings SET reminder_at=?').run(now + 30000);
  expect(await nextMaintenanceDue(env, now)).toBe(now + 30000);
});

it('ignores unresolved monthly deliveries from an old month', async () => {
  db.prepare(`INSERT INTO monthly_notice_deliveries
    (chat_id,month,slug,status,last_attempt_at) VALUES (-123,'2026-8','u1','sending',?)`).run(now - 86400000);
  expect(await nextMaintenanceDue(env, now)).toBe(Date.UTC(2026,8,10,16));
});

it('waits until 9am to retry a current-month notice', async () => {
  const early = Date.UTC(2026,8,10,0); // 8am
  db.prepare(`INSERT INTO monthly_notice_deliveries
    (chat_id,month,slug,status,last_attempt_at) VALUES (-123,'2026-9','u1','pending',?)`).run(early - 3600000);
  expect(await nextMaintenanceDue(env, early)).toBe(early + 3600000);
});

it('wakes again when another worker owns an announcement lease', async () => {
  booking();
  db.prepare(`INSERT INTO availability_notices (chat_id,booking_id,lease_until)
    VALUES (-123,1,?)`).run(now + 45000);
  expect(await nextMaintenanceDue(env, now)).toBe(now + 45000);
});

it('retries on the next minute boundary despite a late cron start', async () => {
  const result = await runScheduledMaintenance(env,
    async () => ({ ok: false, failures: ['Telegram unavailable'] }), prune, now + 10000);
  expect(result.nextDue).toBe(now + 60000);
});

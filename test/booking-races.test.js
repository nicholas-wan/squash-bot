import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { updateBooking } from '../src/bookings.js';

const DAY = 86400000;
let db, env, interleave;

// The real schema behind a D1-shaped wrapper. `interleave` runs once, right
// after the edit's first read, to stand in for a second save landing between
// that read and the write.
beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  interleave = null;
  const statement = (sql, args) => ({
    async first() {
      const row = db.prepare(sql).get(...args) || null;
      if (interleave && sql.startsWith('SELECT * FROM bookings WHERE id = ? AND chat_id = ?')) {
        const run = interleave;
        interleave = null;
        run();
      }
      return row;
    },
    async all() { return { results: db.prepare(sql).all(...args) }; },
    async run() {
      const result = db.prepare(sql).run(...args);
      return { meta: { changes: result.changes, last_row_id: Number(result.lastInsertRowid) } };
    },
  });
  env = {
    BOT_TOKEN: 'test', ALLOWED_CHATS: '-123',
    DB: {
      prepare(sql) { return { bind(...args) { return statement(sql, args); } }; },
      async batch(statements) {
        db.exec('BEGIN');
        try {
          const results = [];
          for (const item of statements) results.push(await item.run());
          db.exec('COMMIT');
          return results;
        } catch (error) { db.exec('ROLLBACK'); throw error; }
      },
    },
  };
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
    ok: true, result: { message_id: 1 },
  }), { headers: { 'Content-Type': 'application/json' } })));
});
afterEach(() => {
  vi.unstubAllGlobals();
  db.close();
});

it('does not let a second save quietly undo one that landed between its read and write', async () => {
  const startsAt = Date.now() + 3 * DAY;
  db.prepare(`INSERT INTO bookings (id, chat_id, court, starts_at, ends_at, reminder_at,
    pre_reminder_at, created_at) VALUES (3, -123, '4', ?, ?, ?, ?, ?)`)
    .run(startsAt, startsAt + 3600000, startsAt - 3600000, startsAt - 7200000, Date.now());
  // Somebody else moves the court to 5 while this save is in flight.
  interleave = () => db.prepare("UPDATE bookings SET court = '5' WHERE id = 3").run();
  const saved = await updateBooking(env, -123, 3, {
    court: '6', startsAt, endsAt: startsAt + 3600000, reminderAt: startsAt - 3600000,
  }, { id: 9, first_name: 'Ad' }, 'test', {
    expected: { court: '4', startsAt, endsAt: startsAt + 3600000 },
  });
  expect(saved).toBe('changed');
  expect(db.prepare('SELECT court FROM bookings WHERE id = 3').get().court).toBe('5');
});

import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index.js';
import { signInitData } from '../src/miniapp-auth.js';
import { analyzeBooking, looksLikeBooking, parseBooking } from '../src/parser.js';
import { clearAdminCache } from '../src/players.js';
import { localParts } from '../src/time.js';
import { d1, schemaDb } from './d1.js';

const TZ = 'Asia/Singapore';
const NOW = Date.UTC(2026, 10, 8, 4, 0, 0); // Sun 8 Nov 2026, noon SGT
const JANUARY = Date.UTC(2027, 0, 10, 4, 0, 0); // Sun 10 Jan 2027, noon SGT
const read = (text, now = NOW) => {
  const draft = analyzeBooking(text, now, TZ);
  return {
    date: draft.date && `${draft.date.d}/${draft.date.mo}`,
    dateChoices: draft.dateChoices.length,
    start: draft.start && `${draft.start.h}:${String(draft.start.mi).padStart(2, '0')}`,
    end: draft.end && `${draft.end.h}:${String(draft.end.mi).padStart(2, '0')}`,
  };
};

describe('A time range with minutes is never a date', () => {
  it('reads the day from the weekday, not from the minutes', () => {
    expect(read('court 4 fri 7:30-8:30pm')).toEqual({ date: '13/11', dateChoices: 0, start: '19:30', end: '20:30' });
    expect(read('court 4 sat 6:15-7:15pm')).toEqual({ date: '14/11', dateChoices: 0, start: '18:15', end: '19:15' });
    expect(read('court 4 fri 7.30-8.30pm')).toEqual({ date: '13/11', dateChoices: 0, start: '19:30', end: '20:30' });
    // In January the old reading was a confirm form for 30 Aug.
    expect(read('court 4 fri 7:30-8:30pm', JANUARY).date).toBe('15/1');
  });

  it('does not ask which date when the message says tomorrow', () => {
    expect(read('court 4 tmr 7:30-8:30pm')).toEqual({ date: '9/11', dateChoices: 0, start: '19:30', end: '20:30' });
  });

  it('keeps an hour range whose finish has minutes', () => {
    expect(read('court 4 sat 8-9:30pm')).toEqual({ date: '14/11', dateChoices: 0, start: '20:00', end: '21:30' });
  });

  it('still reads a numeric date beside a clock', () => {
    expect(read('court 4 15-12 9pm')).toMatchObject({ date: '15/12', start: '21:00' });
    expect(read('court 4 15/12 8-9pm')).toMatchObject({ date: '15/12', start: '20:00', end: '21:00' });
    expect(read('court 4 28-11 8:30pm')).toMatchObject({ date: '28/11', start: '20:30' });
    expect(read('friday 8-9 court 4')).toMatchObject({ date: '13/11', start: null });
  });

  it('books the weekday it names', () => {
    const booking = parseBooking('court 4 fri 7:30-8:30pm', NOW, TZ);
    expect(localParts(booking.startsAt, TZ)).toMatchObject({ y: 2026, mo: 11, d: 13, h: 19, mi: 30 });
  });
});

describe('A clock written without its colon', () => {
  it('reads 830pm and a range of them', () => {
    expect(read('court 4 tmr 830pm')).toMatchObject({ date: '9/11', start: '20:30', end: null });
    expect(read('court 4 tmr 1230pm')).toMatchObject({ start: '12:30' });
    expect(read('court 4 tmr 730-830pm')).toMatchObject({ start: '19:30', end: '20:30' });
    expect(looksLikeBooking('tmr c4 830pm')).toBe(true);
  });

  it('refuses a 24-hour figure with pm rather than guessing', () => {
    expect(analyzeBooking('court 4 tmr 2030pm', NOW, TZ).issues).toContain('I could not read that time.');
  });

  it('leaves 24-hour clocks, years and court numbers as they were', () => {
    expect(read('tmr c4 2100')).toMatchObject({ start: '21:00' });
    expect(read('court 4 tmr 1930-2030')).toMatchObject({ start: '19:30', end: '20:30' });
    expect(read('13 Aug 2100 court 4')).toMatchObject({ date: '13/8', start: '21:00' });
    expect(analyzeBooking('court 12 13 nov 2026 9pm', NOW, TZ)).toMatchObject({
      court: '12', date: { y: 2026, mo: 11, d: 13 }, start: { h: 21, mi: 0 },
    });
    expect(looksLikeBooking('room c4 at 30pm')).toBe(false);
  });
});

describe('Mini App round three', () => {
  const CHAT = -123;
  let sql, env;
  const owner = { id: 9, username: 'nicholaswan' };

  beforeEach(() => {
    sql = schemaDb();
    env = {
      BOT_TOKEN: 'test-token', ALLOWED_CHATS: String(CHAT), OWNER_USER_ID: '9', OWNER_NAME: 'Nicholas',
      DB: d1(sql),
    };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ ok: true, result: { message_id: 100, ephemeral_message_id: 7 } }),
      { headers: { 'Content-Type': 'application/json' } }
    )));
  });
  afterEach(() => {
    sql.close();
    vi.unstubAllGlobals();
    clearAdminCache();
  });

  async function call(path, body) {
    const fields = {
      auth_date: String(Math.floor(Date.now() / 1000)), start_param: `g${CHAT}`,
      user: JSON.stringify(owner),
    };
    fields.hash = await signInitData('test-token', fields);
    const response = await worker.fetch(new Request(`https://squashbot.test/api/app/${path}`, {
      method: body ? 'POST' : 'GET',
      headers: {
        Authorization: `tma ${new URLSearchParams(fields).toString()}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    }), env);
    return response.json();
  }

  it('answers an undo of somebody’s only entry as done, with an empty tab', async () => {
    sql.prepare(`INSERT INTO ledger (chat_id, slug, user_id, name, amount_cents, booking_id, reason, created_at)
      VALUES (?, 'u5', 5, 'Jared', 200, NULL, 'ball · by @nicholaswan · 1 Nov', ?)`).run(CHAT, Date.now() - 1000);
    const { id } = sql.prepare('SELECT id FROM ledger').get();
    const undone = await call(`tab/entry/${id}/undo`, {});
    expect(undone).toMatchObject({
      ok: true,
      message: "Undone: the $2.00 entry on Jared's tab.",
      person: { slug: 'u5', name: 'Jared', balance: 0, earlier: null, lines: [] },
    });
    expect(sql.prepare('SELECT COUNT(*) AS n FROM ledger').get().n).toBe(0);
    // A second tap still finds nothing to take back.
    expect((await call(`tab/entry/${id}/undo`, {})).ok).toBe(false);
  });

  // Three days ahead in Singapore, whenever the suite runs.
  const ahead = (days) => {
    const { y, mo, d } = localParts(Date.now() + days * 86400000, TZ);
    return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  };

  it('adds and edits a court with a name, as the chat wizard stores one', async () => {
    const added = await call('courts', { date: ahead(3), start: '20:00', end: '21:00', court: 'Glass' });
    expect(added.ok).toBe(true);
    const { id, court } = sql.prepare('SELECT id, court FROM bookings').get();
    expect(court).toBe('GLASS');
    const edited = await call(`court/${id}/edit`, {
      ...added.court.edit, date: ahead(4), expected: added.court.stamp,
    });
    expect(edited).toMatchObject({ ok: true, message: '✅ Booking updated' });
    expect(sql.prepare('SELECT court FROM bookings WHERE id = ?').get(id).court).toBe('GLASS');
  });

  it('still reads numbers and letters, and refuses two courts or a date in the court box', async () => {
    expect((await call('courts', { date: ahead(3), start: '20:00', court: '4' })).ok).toBe(true);
    expect((await call('courts', { date: ahead(3), start: '19:00', court: 'Court A' })).ok).toBe(true);
    expect(sql.prepare('SELECT court FROM bookings ORDER BY id').all().map((row) => row.court))
      .toEqual(['4', 'A']);
    for (const court of ['3 and 4', 'tomorrow', '']) {
      expect(await call('courts', { date: ahead(3), start: '18:00', court }))
        .toEqual({ ok: false, message: 'Type a court number or name, such as 4 or A.' });
    }
  });
});

describe('Ledger index for your own tab', () => {
  it('is in the schema and in its migration, which re-runs harmlessly', () => {
    const sql = schemaDb();
    const migration = readFileSync(new URL('../migrations/019-ledger-user-index.sql', import.meta.url), 'utf8');
    sql.exec(migration);
    sql.exec(migration);
    const plan = sql.prepare(`EXPLAIN QUERY PLAN SELECT * FROM ledger
      WHERE chat_id = ? AND user_id = ? ORDER BY created_at`).all(-1, 5);
    expect(plan.map((row) => row.detail).join(' ')).toContain('idx_ledger_user');
    sql.close();
  });
});

describe('The Mini App page', () => {
  it('has inline scripts that parse', () => {
    const html = readFileSync(new URL('../public/app/index.html', import.meta.url), 'utf8');
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
    expect(scripts.length).toBe(2);
    // Compiled, never run: the page needs a browser and Telegram's SDK.
    for (const script of scripts) expect(() => new Function(script)).not.toThrow();
  });
});

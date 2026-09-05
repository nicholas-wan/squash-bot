import { afterEach, describe, expect, it, vi } from 'vitest';
import { joinPickerView } from '../src/bookings.js';
import {
  adminAddPlayer, clearAdminCache, defaultCapacity, defaultPlayers, householdSlugs,
  identity, isChatAdmin, matchesPlayer, ownerIdentity, rememberPlayer, seedRoster,
} from '../src/players.js';

afterEach(() => {
  vi.unstubAllGlobals();
  clearAdminCache();
});

const env = {
  OWNER: '@nicholaswan',
  OWNER_NAME: 'Nicholas',
  DEFAULT_PLAYERS: '@nicholaswan,@dodgerblueee',
};

function capturingDb(inserts) {
  return {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async run() {
              if (sql.includes('INSERT OR IGNORE INTO booking_players')) inserts.push(args);
              return { meta: { changes: 1 } };
            },
          };
        },
      };
    },
  };
}

// A booking_players stand-in that enforces UNIQUE (booking_id, slug), so a
// re-key that collides fails here the way D1 would.
function rosterDb(rows) {
  function check() {
    const seen = new Set();
    for (const row of rows) {
      const key = `${row.booking_id}:${row.slug}`;
      if (seen.has(key)) throw new Error('UNIQUE constraint failed: booking_players.slug');
      seen.add(key);
    }
  }
  return {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async run() {
              if (sql.includes('SET user_id = ?')) {
                const [userId, slug] = args;
                for (const row of rows) {
                  if (row.slug === slug && row.user_id == null) row.user_id = userId;
                }
              } else if (sql.includes('DELETE FROM booking_players')) {
                const [userId, slug] = args;
                const taken = rows.filter((row) => row.slug === slug)
                  .map((row) => row.booking_id);
                for (const row of [...rows]) {
                  if (row.user_id === userId && row.slug !== slug
                      && taken.includes(row.booking_id)) {
                    rows.splice(rows.indexOf(row), 1);
                  }
                }
              } else if (sql.includes('SET slug = ?')) {
                const [slug, name, userId] = args;
                for (const row of rows) {
                  if (row.user_id === userId && row.slug !== slug) {
                    row.slug = slug;
                    row.name = name;
                  }
                }
              }
              check();
              return { meta: { changes: 1 } };
            },
          };
        },
      };
    },
  };
}

describe('player identity', () => {
  it('keys a player on their username so config and taps agree', () => {
    const fromConfig = defaultPlayers(env)[1];
    const fromTap = identity({ id: 42, username: 'dodgerblueee', first_name: 'D' });
    expect(fromConfig.slug).toBe('@dodgerblueee');
    expect(fromTap.slug).toBe('@dodgerblueee');
    expect(fromConfig.userId).toBe(null);
    expect(fromTap.userId).toBe(42);
  });

  it('matches a username in any case but shows the casing its owner chose', () => {
    const typed = identity({ id: 42, username: 'Dodgerblueee' });
    expect(typed.slug).toBe('@dodgerblueee');
    expect(typed.name).toBe('@Dodgerblueee');
    expect(identity({ id: 42, username: 'dodgerblueee' }).slug).toBe(typed.slug);
    expect(defaultPlayers({ DEFAULT_PLAYERS: '@Dodgerblueee' })[0].name)
      .toBe('@Dodgerblueee');
  });

  it('falls back to the numeric id for anyone without a username', () => {
    expect(identity({ id: 9, first_name: 'Alice' })).toEqual({
      userId: 9, username: null, name: 'Alice', slug: 'u9',
    });
  });

  it('does not hand a bound roster row to whoever claims its old username', () => {
    const alice = { slug: '@alice', user_id: 42, name: '@alice' };
    expect(matchesPlayer(alice, { id: 42, username: 'newalice' })).toBe(true);
    expect(matchesPlayer(alice, { id: 99, username: 'alice' })).toBe(false);
    // A config-seeded row has no stronger identity until that player appears.
    expect(matchesPlayer({ ...alice, user_id: null }, { id: 42, username: 'alice' }))
      .toBe(true);
  });

  it('still reads the older id:Name and bare-id config forms', () => {
    expect(defaultPlayers({ DEFAULT_PLAYERS: '7:Nicholas,99' })).toEqual([
      { userId: 7, username: null, name: 'Nicholas', slug: 'u7' },
      { userId: 99, username: null, name: 'Player', slug: 'u99' },
    ]);
    expect(ownerIdentity({ OWNER_USER_ID: '7' }).slug).toBe('u7');
  });

  it('reads id:@handle as one live Telegram identity', () => {
    expect(defaultPlayers({ DEFAULT_PLAYERS: '7:@Nicholas' })[0]).toEqual({
      userId: 7, username: 'nicholas', name: '@Nicholas', slug: '@nicholas',
    });
  });

  it('pins the organiser’s handle to their numeric id', () => {
    const owner = ownerIdentity({ ...env, OWNER_USER_ID: '246334575' });
    // Still the handle the group knows them by, now with the id that outlives it.
    expect(owner.slug).toBe('@nicholaswan');
    expect(owner.name).toBe('@nicholaswan');
    expect(owner.userId).toBe(246334575);
    // An OWNER that already carries an id keeps it.
    expect(ownerIdentity({ OWNER: '7:Nicholas', OWNER_USER_ID: '246334575' }))
      .toEqual({ userId: 7, username: null, name: 'Nicholas', slug: 'u7' });
  });

  it('keeps the organiser an admin after they change their username', async () => {
    // Nothing to ask Telegram: a fetch here would be the id check failing.
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('getChatMember should not be reached');
    }));
    const pinned = { ...env, OWNER_USER_ID: '246334575' };
    const renamed = { id: 246334575, username: 'nickw' };
    expect(await isChatAdmin(pinned, -123, renamed)).toBe(true);
  });

  it("does not hand admin to whoever claims the organiser's old handle", async () => {
    const requests = [];
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      requests.push(String(url));
      return new Response(JSON.stringify({ ok: true, result: { status: 'member' } }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }));
    const pinned = { ...env, OWNER_USER_ID: '246334575', BOT_TOKEN: 'test-token' };
    // Same handle as OWNER, different account: the id decides, Telegram is asked.
    expect(await isChatAdmin(pinned, -123, { id: 999, username: 'nicholaswan' })).toBe(false);
    expect(requests.some((url) => url.endsWith('/getChatMember'))).toBe(true);
  });

  it('never reads two missing ids as the same person', async () => {
    const requests = [];
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      requests.push(String(url));
      return new Response(JSON.stringify({ ok: true, result: { status: 'member' } }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }));
    // An OWNER named in plain text carries no id, so the id comparison has
    // nothing to match on and the answer has to come from Telegram.
    const named = { OWNER: 'Nicholas', BOT_TOKEN: 'test-token' };
    expect(await isChatAdmin(named, -123, { id: 42, username: 'alice' })).toBe(false);
    expect(requests.some((url) => url.endsWith('/getChatMember'))).toBe(true);
  });

  it('keeps the organiser and the default players off the tab', () => {
    const household = householdSlugs(env);
    expect(household.has('@nicholaswan')).toBe(true);
    expect(household.has('@dodgerblueee')).toBe(true);
    expect(household.has(identity({ id: 9, first_name: 'Alice' }).slug)).toBe(false);
  });

  it('lets someone play free without seating them on every booking', () => {
    const withGuest = { ...env, UNBILLED_PLAYERS: '@gabrielwann' };
    expect(householdSlugs(withGuest).has('@gabrielwann')).toBe(true);
    // Free to play, but not added to bookings the way DEFAULT_PLAYERS are.
    expect(defaultPlayers(withGuest).map((player) => player.slug))
      .toEqual(['@nicholaswan', '@dodgerblueee']);
  });

  it('treats the organiser as an admin without asking Telegram', async () => {
    const admin = await isChatAdmin(env, -123, { id: 5, username: 'NicholasWan' });
    expect(admin).toBe(true);
  });

  it('reuses a recent Telegram admin check', async () => {
    const requests = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(init.body) });
      return new Response(JSON.stringify({
        ok: true, result: { status: 'administrator' },
      }), { headers: { 'Content-Type': 'application/json' } });
    }));
    const checkedEnv = { BOT_TOKEN: 'test-token' };
    const who = { id: 42, username: 'alice' };
    expect(await isChatAdmin(checkedEnv, -123, who)).toBe(true);
    expect(await isChatAdmin(checkedEnv, -123, who)).toBe(true);
    expect(requests.filter((request) => request.url.endsWith('/getChatMember')))
      .toHaveLength(1);
  });
});

describe('remembering a player', () => {
  it('sends the three ordered identity statements in one D1 batch', async () => {
    const statements = [];
    const batches = [];
    const run = vi.fn();
    const db = {
      prepare(sql) {
        return { bind(...args) {
          const statement = { sql, args, run };
          statements.push(statement);
          return statement;
        } };
      },
      async batch(batch) {
        batches.push(batch);
        return batch.map(() => ({ success: true }));
      },
    };
    await rememberPlayer({ DB: db }, { id: 42, username: 'Alice' });
    expect(batches).toHaveLength(1);
    expect(batches[0]).toEqual(statements);
    expect(batches[0]).toHaveLength(3);
    expect(run).not.toHaveBeenCalled();
  });

  it('moves someone who picks up a username onto it, rather than splitting them', async () => {
    const rows = [
      { booking_id: 1, slug: 'u42', user_id: 42, name: 'Alice' },
      { booking_id: 2, slug: 'u42', user_id: 42, name: 'Alice' },
      { booking_id: 1, slug: '@bob', user_id: 11, name: '@bob' },
    ];
    await rememberPlayer({ DB: rosterDb(rows) }, { id: 42, username: 'Alice' });
    expect(rows.filter((row) => row.user_id === 42)).toEqual([
      { booking_id: 1, slug: '@alice', user_id: 42, name: '@Alice' },
      { booking_id: 2, slug: '@alice', user_id: 42, name: '@Alice' },
    ]);
    expect(rows.find((row) => row.user_id === 11).slug).toBe('@bob');
  });

  it('merges the two spellings when both are already on the same booking', async () => {
    const rows = [
      { booking_id: 1, slug: 'u42', user_id: 42, name: 'Alice' },
      { booking_id: 1, slug: '@alice', user_id: null, name: '@alice' },
      { booking_id: 2, slug: 'u42', user_id: 42, name: 'Alice' },
    ];
    await rememberPlayer({ DB: rosterDb(rows) }, { id: 42, username: 'alice' });
    // One human, one seat: two rows on booking 1 would be billed twice.
    expect(rows.map((row) => `${row.booking_id}:${row.slug}`))
      .toEqual(['1:@alice', '2:@alice']);
    expect(rows.every((row) => row.user_id === 42)).toBe(true);
  });
});

describe('rosters', () => {
  it('defaults to three players per court', () => {
    expect(defaultCapacity({})).toBe(3);
    expect(defaultCapacity({ DEFAULT_CAPACITY: '4' })).toBe(4);
    expect(defaultCapacity({ DEFAULT_CAPACITY: '999' })).toBe(12);
  });

  it('seeds a new booking with the household plus whoever booked it', async () => {
    const inserts = [];
    await seedRoster({ ...env, DB: capturingDb(inserts) }, -123, 3,
      { id: 9, username: 'alice' }, 3);
    expect(inserts.map((args) => args[4]))
      .toEqual(['@alice', '@nicholaswan', '@dodgerblueee']);
  });

  it('never seeds more players than the court holds', async () => {
    const inserts = [];
    await seedRoster({ ...env, DB: capturingDb(inserts) }, -123, 3,
      { id: 9, username: 'alice' }, 2);
    expect(inserts.map((args) => args[4])).toEqual(['@alice', '@nicholaswan']);
  });

  it('seats whoever booked, even on a court smaller than the household', async () => {
    const inserts = [];
    await seedRoster({
      ...env, DEFAULT_PLAYERS: '@alpha,@bravo,@charlie', DB: capturingDb(inserts),
    }, -123, 3, { id: 9, username: 'alice' }, 3);
    // The booker cannot be the one left off their own booking.
    expect(inserts.map((args) => args[4])).toContain('@alice');
    expect(inserts).toHaveLength(3);
  });

  it('does not seat the organiser twice when they book', async () => {
    const inserts = [];
    await seedRoster({ ...env, DB: capturingDb(inserts) }, -123, 3,
      { id: 5, username: 'nicholaswan' }, 3);
    expect(inserts.map((args) => args[4])).toEqual(['@nicholaswan', '@dodgerblueee']);
  });

  it('does not count an id:@handle default as a second organiser seat', async () => {
    const inserts = [];
    const configured = {
      OWNER: '@nicholaswan', OWNER_USER_ID: '246334575',
      DEFAULT_PLAYERS: '246334575:@nicholaswan,174640019:@Dodgerblueee',
      DB: capturingDb(inserts),
    };
    await seedRoster(configured, -123, 3,
      { id: 246334575, username: 'nicholaswan' }, 3);
    expect(inserts.map((args) => args[4])).toEqual(['@nicholaswan', '@Dodgerblueee']);
  });

  it('seats the organiser even when they are not in DEFAULT_PLAYERS', async () => {
    const inserts = [];
    await seedRoster(
      { OWNER: '@nicholaswan', DEFAULT_PLAYERS: '', DB: capturingDb(inserts) },
      -123, 3, { id: 9, username: 'alice' }, 3
    );
    expect(inserts.map((args) => args[4])).toEqual(['@alice', '@nicholaswan']);
  });

  it('records the chat a player joined from, so reminders reach them', async () => {
    const inserts = [];
    await seedRoster({ ...env, DB: capturingDb(inserts) }, -984202118, 3,
      { id: 9, username: 'alice' }, 3);
    expect(inserts.every((args) => args[1] === -984202118)).toBe(true);
  });
});

describe('an admin seating somebody', () => {
  const booking = {
    id: 3, chat_id: -123, court: '4', capacity: 3,
    starts_at: Date.now() + 3600000, ends_at: Date.now() + 7200000,
  };

  // The guard lives inside the insert, so the mock has to answer it the way D1
  // would: the last bound value is the room left for the heads being seated.
  function seatingDb(seatedHeads) {
    const inserts = [];
    return {
      inserts,
      prepare(sql) {
        return { bind(...args) { return {
          async first() {
            return sql.includes('SELECT * FROM bookings WHERE id') ? booking : null;
          },
          async run() {
            if (!sql.includes('INSERT OR IGNORE INTO booking_players')) {
              return { meta: { changes: 1 } };
            }
            if (seatedHeads > args[args.length - 1]) return { meta: { changes: 0 } };
            inserts.push(args);
            return { meta: { changes: 1 } };
          },
        }; } };
      },
    };
  }

  const bo = { slug: '@bo', name: '@bo', user_id: 42 };

  it('refuses a +1 with only one head free, and seats them alone', async () => {
    const refusing = seatingDb(2);
    // Opening a slot stays an explicit admin decision, so one short is a
    // refusal rather than a seat quietly shrunk to fit.
    expect((await adminAddPlayer({ DB: refusing }, -123, 3, bo, 9, 2)).status).toBe('full');
    expect(refusing.inserts).toHaveLength(0);

    const seating = seatingDb(2);
    const alone = await adminAddPlayer({ DB: seating }, -123, 3, bo, 9);
    expect(alone.status).toBe('added');
    expect(seating.inserts[0][6]).toBe(1);
  });

  it('writes two heads on the one row when there is room for both', async () => {
    const seating = seatingDb(1);
    expect((await adminAddPlayer({ DB: seating }, -123, 3, bo, 9, 2)).status).toBe('added');
    expect(seating.inserts[0][6]).toBe(2);
  });
});

describe('the private court list', () => {
  const startsAt = Date.UTC(2026, 7, 19, 13, 0);
  const booking = {
    id: 3, chat_id: -123, court: '4', capacity: 3,
    starts_at: startsAt, ends_at: startsAt + 3600000,
  };

  function db(roster) {
    return {
      prepare(sql) {
        return { bind() { return {
          async first() { return sql.includes('SELECT tz') ? { tz: 'Asia/Singapore' } : null; },
          async all() {
            if (sql.includes('FROM booking_players')) return { results: roster };
            return { results: sql.includes('ends_at >') ? [booking] : [] };
          },
        }; } };
      },
    };
  }

  const now = startsAt - 86400000;

  it('offers Leave, never Join, for a court you are already on', async () => {
    const view = await joinPickerView(
      { DB: db([{ booking_id: 3, slug: '@alice', name: '@alice', user_id: 9 }]) },
      -123, { id: 9, username: 'Alice' }, false, now
    );
    const button = view.replyMarkup.inline_keyboard[0][0];
    expect(button.text).toContain('🚪 Leave');
    expect(button.callback_data).toBe('sb:leave:3');
    // Numeric courts compress to fit a phone-width button.
    expect(button.text).toContain('C4');
  });

  it('offers Join to somebody who is not on it', async () => {
    const view = await joinPickerView(
      { DB: db([{ booking_id: 3, slug: '@alice', name: '@alice', user_id: 9 }]) },
      -123, { id: 11, username: 'bob' }, false, now
    );
    expect(view.replyMarkup.inline_keyboard[0][0].callback_data).toBe('sb:join:3');
  });

  it('shows you who you are playing with, on the courts you are on', async () => {
    const roster = [
      { booking_id: 3, slug: '@alice', name: '@alice', user_id: 9 },
      { booking_id: 3, slug: '@bo', name: '@Bo', user_id: null },
    ];
    const onIt = await joinPickerView(
      { DB: db(roster) }, -123, { id: 9, username: 'alice' }, false, now
    );
    // Tagged where the id is known, plain @handle where it is not yet.
    expect(onIt.html).toContain('👥 <a href="tg://user?id=9">@alice</a>, @Bo');
    expect(onIt.html).toContain('Court 4');
  });

  it('does not name a roster to somebody who is not on that court', async () => {
    const roster = [
      { booking_id: 3, slug: '@alice', name: '@alice', user_id: 9 },
      { booking_id: 3, slug: '@bo', name: '@Bo', user_id: null },
    ];
    const stranger = await joinPickerView(
      { DB: db(roster) }, -123, { id: 11, username: 'bob' }, false, now
    );
    expect(stranger.html).not.toContain('@Bo');
    // The court itself is still offered; only who is on it is withheld.
    expect(stranger.replyMarkup.inline_keyboard[0][0].callback_data).toBe('sb:join:3');
  });

  it('gives an admin every roster and the manage button', async () => {
    const roster = [
      { booking_id: 3, slug: '@alice', name: '@alice', user_id: 9 },
      { booking_id: 3, slug: '@bo', name: '@Bo', user_id: null },
    ];
    const who = { id: 11, username: 'bob' };
    const member = await joinPickerView({ DB: db(roster) }, -123, who, false, now);
    const admin = await joinPickerView({ DB: db(roster) }, -123, who, true, now);

    const actions = (view) => view.replyMarkup.inline_keyboard.flat().map((b) => b.callback_data);
    expect(actions(member)).not.toContain('sb:manage');
    expect(actions(admin)).toContain('sb:manage');
    // Not on that court, but keeping the household straight is their job.
    expect(admin.html).toContain('@Bo');
  });

  it('marks a full court rather than hiding it', async () => {
    const full = ['@a', '@b', '@c'].map((slug) => ({
      booking_id: 3, slug, name: slug, user_id: null,
    }));
    const view = await joinPickerView({ DB: db(full) }, -123, { id: 11, username: 'bob' }, false, now);
    // The board lists it, so a list that omitted it would read as a bug.
    const button = view.replyMarkup.inline_keyboard[0][0];
    expect(button.text).toContain('🔒 Full');
    expect(button.callback_data).toBe('sb:full:3');
  });

  it('counts a +1 as two of the court’s slots', async () => {
    const view = await joinPickerView(
      { DB: db([{ booking_id: 3, slug: '@a', name: '@a', user_id: null, heads: 2 }]) },
      -123, { id: 11, username: 'bob' }, false, now
    );
    const button = view.replyMarkup.inline_keyboard[0][0];
    expect(button.callback_data).toBe('sb:join:3');
    expect(button.text).toContain('1 left');
  });

  it('marks a court full when a +1 took the last slot', async () => {
    const roster = [
      { booking_id: 3, slug: '@a', name: '@a', user_id: null, heads: 2 },
      { booking_id: 3, slug: '@b', name: '@b', user_id: null, heads: 1 },
    ];
    const view = await joinPickerView({ DB: db(roster) }, -123, { id: 11, username: 'bob' }, false, now);
    // Two rows, three heads: whoever tapped Join here would be the fourth.
    const button = view.replyMarkup.inline_keyboard[0][0];
    expect(button.text).toContain('🔒 Full');
    expect(button.callback_data).toBe('sb:full:3');
  });

  it('still offers Leave on a full court to somebody on it', async () => {
    const full = ['@a', '@b', '@bob'].map((slug) => ({
      booking_id: 3, slug, name: slug, user_id: null,
    }));
    const view = await joinPickerView({ DB: db(full) }, -123, { id: 11, username: 'bob' }, false, now);
    const button = view.replyMarkup.inline_keyboard[0][0];
    expect(button.text).toContain('🚪 Leave');
    expect(button.callback_data).toBe('sb:leave:3');
  });

  it('hides a court that has already started', async () => {
    expect(await joinPickerView({ DB: db([]) }, -123, { id: 11 }, false, startsAt + 60000)).toBe(null);
  });
});

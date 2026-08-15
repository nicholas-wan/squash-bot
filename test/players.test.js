import { describe, expect, it } from 'vitest';
import { joinPickerView } from '../src/bookings.js';
import {
  defaultCapacity, defaultPlayers, householdSlugs, identity, isChatAdmin,
  ownerIdentity, rememberPlayer, seedRoster,
} from '../src/players.js';

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

  it('still reads the older id:Name and bare-id config forms', () => {
    expect(defaultPlayers({ DEFAULT_PLAYERS: '7:Nicholas,99' })).toEqual([
      { userId: 7, username: null, name: 'Nicholas', slug: 'u7' },
      { userId: 99, username: null, name: 'Player', slug: 'u99' },
    ]);
    expect(ownerIdentity({ OWNER_USER_ID: '7' }).slug).toBe('u7');
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
});

describe('remembering a player', () => {
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
      -123, { id: 9, username: 'Alice' }, now
    );
    const button = view.replyMarkup.inline_keyboard[0][0];
    expect(button.text).toContain('🚪 Leave');
    expect(button.callback_data).toBe('sb:leave:3');
    expect(button.text).toContain('2 slots');
  });

  it('offers Join to somebody who is not on it', async () => {
    const view = await joinPickerView(
      { DB: db([{ booking_id: 3, slug: '@alice', name: '@alice', user_id: 9 }]) },
      -123, { id: 11, username: 'bob' }, now
    );
    expect(view.replyMarkup.inline_keyboard[0][0].callback_data).toBe('sb:join:3');
  });

  it('marks a full court rather than hiding it', async () => {
    const full = ['@a', '@b', '@c'].map((slug) => ({
      booking_id: 3, slug, name: slug, user_id: null,
    }));
    const view = await joinPickerView({ DB: db(full) }, -123, { id: 11, username: 'bob' }, now);
    // The board lists it, so a list that omitted it would read as a bug.
    const button = view.replyMarkup.inline_keyboard[0][0];
    expect(button.text).toContain('🔒 Full');
    expect(button.callback_data).toBe('sb:full:3');
  });

  it('still offers Leave on a full court to somebody on it', async () => {
    const full = ['@a', '@b', '@bob'].map((slug) => ({
      booking_id: 3, slug, name: slug, user_id: null,
    }));
    const view = await joinPickerView({ DB: db(full) }, -123, { id: 11, username: 'bob' }, now);
    const button = view.replyMarkup.inline_keyboard[0][0];
    expect(button.text).toContain('🚪 Leave');
    expect(button.callback_data).toBe('sb:leave:3');
  });

  it('hides a court that has already started', async () => {
    expect(await joinPickerView({ DB: db([]) }, -123, { id: 11 }, startsAt + 60000)).toBe(null);
  });
});

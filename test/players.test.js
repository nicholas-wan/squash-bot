import { describe, expect, it } from 'vitest';
import { joinPickerView } from '../src/bookings.js';
import {
  defaultCapacity, defaultPlayers, householdSlugs, identity, isChatAdmin,
  ownerIdentity, seedRoster,
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
      .toEqual(['@nicholaswan', '@dodgerblueee', '@alice']);
  });

  it('never seeds more players than the court holds', async () => {
    const inserts = [];
    await seedRoster({ ...env, DB: capturingDb(inserts) }, -123, 3,
      { id: 9, username: 'alice' }, 2);
    expect(inserts.map((args) => args[4])).toEqual(['@nicholaswan', '@dodgerblueee']);
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
    expect(inserts.map((args) => args[4])).toEqual(['@nicholaswan', '@alice']);
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

  it('marks a full court instead of offering to join it', async () => {
    const full = ['@a', '@b', '@c'].map((slug) => ({
      booking_id: 3, slug, name: slug, user_id: null,
    }));
    const view = await joinPickerView({ DB: db(full) }, -123, { id: 11, username: 'bob' }, now);
    const button = view.replyMarkup.inline_keyboard[0][0];
    expect(button.text).toContain('🔒 Full');
    expect(button.text).toContain('full');
    expect(button.callback_data).toBe('sb:full:3');
  });

  it('hides a court that has already started', async () => {
    expect(await joinPickerView({ DB: db([]) }, -123, { id: 11 }, startsAt + 60000)).toBe(null);
  });
});

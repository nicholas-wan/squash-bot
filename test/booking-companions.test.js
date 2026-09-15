import { describe, expect, it } from 'vitest';
import { parseBookingCompanions } from '../src/booking-companions.js';
import { identity, seedRoster } from '../src/players.js';

describe('/book companions', () => {
  it('extracts a handle without letting its digits affect booking details', () => {
    const result = parseBookingCompanions('court 4 tomorrow 9pm @Alice123', {});
    expect(result.details).toBe('court 4 tomorrow 9pm');
    expect(result.companions.players[0]).toMatchObject({ slug: '@alice123' });
  });

  it('handles Telegram name mentions with UTF-16 offsets and a bot command suffix', () => {
    const text = '/book@SquashBot court 4 tomorrow 9pm 🎾 Alice';
    const result = parseBookingCompanions(text.slice(16), {
      text, entities: [{ type: 'text_mention', offset: text.indexOf('Alice'), length: 5,
        user: { id: 9, first_name: 'Alice' } }],
    });
    expect(result.companions.players[0]).toMatchObject({ userId: 9, slug: 'u9' });
    expect(result.details).not.toContain('Alice');
    expect(result.companions.players).toHaveLength(1);
  });

  it('accepts a guest with a blank form and keeps date/time numbers intact', () => {
    expect(parseBookingCompanions('+1', {}).companions.plusOne).toBe(true);
    expect(parseBookingCompanions('court 1 tomorrow 8-9pm +1', {}).details)
      .toBe('court 1 tomorrow 8-9pm');
  });

  async function roster(companions, capacity = 3, bookedFor = null) {
    const rows = [];
    const DB = { prepare: () => ({ bind: (...args) => ({ run: async () => {
      rows.push({ slug: args[3], heads: args[6] });
    } }) }) };
    await seedRoster({ DB, DEFAULT_PLAYERS: '@owner,@alice' }, -1, 1,
      { id: 7, username: 'nick' }, capacity, bookedFor, companions);
    return rows;
  }

  it('reserves the tagged player before defaults and deduplicates tags', async () => {
    expect(await roster({ players: [identity({ username: 'alice' }), identity({ username: 'Alice' })] }))
      .toEqual([{ slug: '@nick', heads: 1 }, { slug: '@alice', heads: 1 }, { slug: '@owner', heads: 1 }]);
  });

  it('counts the guest as two heads on the caller, including bookings on behalf', async () => {
    expect(await roster({ plusOne: true })).toEqual([
      { slug: '@nick', heads: 2 }, { slug: '@owner', heads: 1 },
    ]);
    expect(await roster({ plusOne: true }, 3, identity({ id: 9 }))).toEqual([
      { slug: 'u9', heads: 1 }, { slug: '@nick', heads: 2 },
    ]);
  });

  it('rejects requested players that cannot fit', async () => {
    await expect(roster({ plusOne: true }, 1)).rejects.toThrow('exceed the court capacity');
  });
});

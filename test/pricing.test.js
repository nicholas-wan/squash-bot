import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  courtCostCents, formatMoney, isPeakDay, publicHolidays, shareCents,
} from '../src/pricing.js';

const TZ = 'Asia/Singapore';
const holidays = publicHolidays({});

// 2026-08-19 is a Wednesday, 2026-08-22 a Saturday, 2026-08-10 the National Day
// holiday in lieu. Times below are written as UTC, which is SGT minus 8 hours.
function sgt(y, mo, d, h, mi = 0) {
  return Date.UTC(y, mo - 1, d, h - 8, mi);
}

// Warnings are logged once per misconfiguration, so every test below uses a year
// and entries no other test has already tripped.
function captureLogs() {
  const lines = [];
  vi.spyOn(console, 'log').mockImplementation((line) => lines.push(String(line)));
  return () => lines;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('court pricing', () => {
  it('charges $3 an hour before 6pm on an ordinary weekday', () => {
    expect(courtCostCents(sgt(2026, 8, 19, 15), sgt(2026, 8, 19, 16), TZ, holidays)).toBe(300);
  });

  it('charges $6 an hour from 6pm on an ordinary weekday', () => {
    expect(courtCostCents(sgt(2026, 8, 19, 21), sgt(2026, 8, 19, 22), TZ, holidays)).toBe(600);
    expect(courtCostCents(sgt(2026, 8, 19, 18), sgt(2026, 8, 19, 19, 30), TZ, holidays)).toBe(900);
  });

  it('splits a booking that straddles 6pm at both rates', () => {
    expect(courtCostCents(sgt(2026, 8, 19, 17), sgt(2026, 8, 19, 19), TZ, holidays)).toBe(900);
  });

  it('prices each side of midnight on its own day', () => {
    // Opening hours stop a booking ever crossing midnight, so this is a guard
    // rather than a live case: the rate must follow the day, not the start time.
    // Sun 11pm–Mon 1am would otherwise bill both hours at the weekend rate.
    expect(courtCostCents(sgt(2026, 8, 23, 23), sgt(2026, 8, 24, 1), TZ, holidays)).toBe(900);
  });

  it('charges the evening rate all day at weekends', () => {
    expect(isPeakDay(sgt(2026, 8, 22, 10), TZ, holidays)).toBe(true);
    expect(courtCostCents(sgt(2026, 8, 22, 10), sgt(2026, 8, 22, 11), TZ, holidays)).toBe(600);
  });

  it('charges the evening rate all day on a Singapore public holiday', () => {
    expect(isPeakDay(sgt(2026, 8, 10, 9), TZ, holidays)).toBe(true);
    expect(courtCostCents(sgt(2026, 8, 10, 9), sgt(2026, 8, 10, 10), TZ, holidays)).toBe(600);
  });

  it('lets the group override the holiday list without a deploy', () => {
    const custom = publicHolidays({ PUBLIC_HOLIDAYS: '2026-08-19' });
    expect(courtCostCents(sgt(2026, 8, 19, 15), sgt(2026, 8, 19, 16), TZ, custom)).toBe(600);
  });

  it('drops PUBLIC_HOLIDAYS entries that are not YYYY-MM-DD, with a warning', () => {
    // "2027-1-1" is compared verbatim against a zero-padded key, so accepting it
    // would charge that holiday off-peak and say nothing.
    const logged = captureLogs();
    const custom = publicHolidays({ PUBLIC_HOLIDAYS: '2031-1-1,2031-02-30,nonsense,2031-03-05' });
    expect(custom).toEqual(['2031-03-05']);
    expect(logged().join('\n')).toContain('"2031-1-1" is not a YYYY-MM-DD date');
    expect(logged().join('\n')).toContain('"2031-02-30" is not a YYYY-MM-DD date');
    expect(logged().join('\n')).toContain('"nonsense" is not a YYYY-MM-DD date');
  });

  it('falls back to the built-in list when every configured entry is malformed', () => {
    captureLogs();
    expect(publicHolidays({ PUBLIC_HOLIDAYS: '2032-1-1' })).toEqual(publicHolidays({}));
  });

  it('warns rather than pretending an unlisted year has no holidays', () => {
    // The built-in list stops at 2026, so Fri 1 Jan 2027 prices as an ordinary
    // weekday. That is unavoidable — gazetted dates cannot be guessed — but it
    // must not happen quietly.
    const logged = captureLogs();
    expect(isPeakDay(sgt(2027, 1, 1, 9), TZ, holidays)).toBe(false);
    expect(courtCostCents(sgt(2027, 1, 1, 9), sgt(2027, 1, 1, 10), TZ, holidays)).toBe(300);
    expect(logged().join('\n')).toContain('No public holidays listed for 2027');
  });

  it('warns when a configured list covers no dates in the year being priced', () => {
    // Replacing the list each December drops the year that is still being
    // played: PUBLIC_HOLIDAYS set to 2029 dates alone loses Christmas 2028.
    const logged = captureLogs();
    const custom = publicHolidays({ PUBLIC_HOLIDAYS: '2029-01-01' });
    expect(courtCostCents(sgt(2028, 12, 25, 9), sgt(2028, 12, 25, 10), TZ, custom)).toBe(300);
    expect(logged().join('\n')).toContain('No public holidays listed for 2028');
  });

  it('stays quiet for a year the list covers', () => {
    const logged = captureLogs();
    expect(courtCostCents(sgt(2026, 8, 19, 15), sgt(2026, 8, 19, 16), TZ, holidays)).toBe(300);
    expect(logged()).toEqual([]);
  });

  it('splits the court evenly and leaves the remainder with the organiser', () => {
    expect(shareCents(600, 3)).toBe(200);
    expect(shareCents(1000, 3)).toBe(333);
    expect(shareCents(600, 0)).toBe(0);
  });

  it('formats money in whole cents', () => {
    expect(formatMoney(600)).toBe('$6.00');
    expect(formatMoney(1234)).toBe('$12.34');
    expect(formatMoney(-250)).toBe('-$2.50');
  });
});

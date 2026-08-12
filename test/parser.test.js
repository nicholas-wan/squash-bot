import { describe, expect, it } from 'vitest';
import { analyzeBooking, BookingParseError, draftComplete, parseBooking } from '../src/parser.js';
import { localParts } from '../src/time.js';
import { formatCountdown } from '../src/bookings.js';

const TZ = 'Asia/Singapore';
const NOW = Date.UTC(2026, 7, 12, 12, 0, 0); // 12 Aug 2026, 8pm SGT
const local = (epoch) => localParts(epoch, TZ);

describe('parseBooking', () => {
  it('parses the requested simple format', () => {
    const booking = parseBooking('13 Aug Court 4 9pm', NOW, TZ);
    expect(booking.court).toBe('4');
    expect(local(booking.startsAt)).toMatchObject({ y: 2026, mo: 8, d: 13, h: 21, mi: 0 });
    expect(booking.endsAt - booking.startsAt).toBe(60 * 60 * 1000);
    expect(local(booking.reminderAt)).toMatchObject({ d: 13, h: 8, mi: 0 });
  });

  it('supports an explicit end time', () => {
    const booking = parseBooking('13 Aug Court 4 9pm-10:30pm', NOW, TZ);
    expect(local(booking.endsAt)).toMatchObject({ d: 13, h: 22, mi: 30 });
  });

  it('supports numeric dates and 24-hour time', () => {
    const booking = parseBooking('13/8 Court A 21:00', NOW, TZ);
    expect(booking.court).toBe('A');
    expect(local(booking.startsAt)).toMatchObject({ mo: 8, d: 13, h: 21 });
  });

  it('treats next Monday as the nearest upcoming Monday', () => {
    const booking = parseBooking('next Monday court 4 9pm', NOW, TZ);
    expect(local(booking.startsAt)).toMatchObject({ y: 2026, mo: 8, d: 17, h: 21 });
  });

  it('uses next year for an omitted date that has passed', () => {
    const booking = parseBooking('1 Aug Court 2 7pm', NOW, TZ);
    expect(local(booking.startsAt).y).toBe(2027);
  });

  it('rejects a time that already passed today', () => {
    expect(() => parseBooking('12 Aug Court 2 7pm', NOW, TZ)).toThrow(/already passed/);
  });

  it('never schedules the same-day reminder on the previous day', () => {
    const booking = parseBooking('13 Aug Court 2 12:30am', NOW, TZ);
    expect(local(booking.reminderAt)).toMatchObject({ d: 13, h: 0, mi: 0 });
  });

  it('ignores normal chat', () => {
    expect(parseBooking('shall we play next week?', NOW, TZ)).toBeNull();
  });

  it('gives format help for malformed booking-like text', () => {
    expect(() => parseBooking('13 Aug Court four', NOW, TZ)).toThrow(BookingParseError);
  });
});

describe('confidence-based natural language parsing', () => {
  it('accepts reordered natural language and number words', () => {
    const draft = analyzeBooking('court four tomorrow at 9pm', NOW, TZ);
    expect(draftComplete(draft)).toBe(true);
    expect(draft.court).toBe('4');
    expect(draft.start).toEqual({ h: 21, mi: 0 });
    expect(draft.date).toMatchObject({ y: 2026, mo: 8, d: 13 });
  });

  it('parses weekday, time range, and court in any order', () => {
    const draft = analyzeBooking('Friday 9pm-10:30pm, Court 2', NOW, TZ);
    expect(draftComplete(draft)).toBe(true);
    expect(draft.start).toEqual({ h: 21, mi: 0 });
    expect(draft.end).toEqual({ h: 22, mi: 30 });
    expect(draft.date).toMatchObject({ d: 14 });
  });

  it('does not guess an ambiguous numeric date', () => {
    const draft = analyzeBooking('8/9 Court 4 9pm', NOW, TZ);
    expect(draft.date).toBeNull();
    expect(draft.dateChoices).toHaveLength(2);
    expect(draftComplete(draft)).toBe(false);
  });

  it('does not guess am or pm for a bare hour', () => {
    const draft = analyzeBooking('tomorrow Court 4 at 9', NOW, TZ);
    expect(draft.start).toBeNull();
    expect(draft.timeChoices.map((choice) => choice.label)).toEqual(['9am', '9pm']);
  });

  it('leaves missing fields for the wizard', () => {
    const draft = analyzeBooking('13 Aug Court 4', NOW, TZ);
    expect(draft.date).toBeTruthy();
    expect(draft.court).toBe('4');
    expect(draft.start).toBeNull();
  });

  it('does not confuse an explicit year with a compact time', () => {
    const draft = analyzeBooking('13 Aug 2026 Court 4 9pm', NOW, TZ);
    expect(draftComplete(draft)).toBe(true);
    expect(draft.start).toEqual({ h: 21, mi: 0 });
  });

  it('ignores unrelated group conversation', () => {
    expect(analyzeBooking('Dinner tomorrow at 9pm', NOW, TZ)).toBeNull();
  });
});

describe('pinned-board countdown', () => {
  it('uses consistent month-and-day wording for later dates', () => {
    expect(formatCountdown(Date.UTC(2026, 7, 12, 13, 0), TZ, NOW)).toBe('today');
    expect(formatCountdown(Date.UTC(2026, 7, 13, 13, 0), TZ, NOW)).toBe('tomorrow');
    expect(formatCountdown(Date.UTC(2026, 7, 17, 13, 0), TZ, NOW)).toBe('in 5 days · Aug 17');
    expect(formatCountdown(Date.UTC(2026, 7, 19, 13, 0), TZ, NOW)).toBe('in 7 days · Aug 19');
  });
});

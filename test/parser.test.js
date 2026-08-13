import { describe, expect, it } from 'vitest';
import { analyzeBooking, BookingParseError, draftComplete, parseBooking } from '../src/parser.js';
import { localParts } from '../src/time.js';
import { formatCountdown } from '../src/bookings.js';

const TZ = 'Asia/Singapore';
const NOW = Date.UTC(2026, 7, 12, 12, 0, 0); // 12 Aug 2026, 8pm SGT
const PAST_MIDNIGHT = Date.UTC(2026, 7, 13, 16, 30); // 14 Aug 2026, 12:30am SGT, still 13 Aug in UTC
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
    const booking = parseBooking('13 Aug Court 4 8pm-9:30pm', NOW, TZ);
    expect(local(booking.endsAt)).toMatchObject({ d: 13, h: 21, mi: 30 });
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
    const booking = parseBooking('13 Aug Court 2 7am', NOW, TZ);
    expect(local(booking.reminderAt)).toMatchObject({ d: 13, h: 6, mi: 0 });
  });

  it('keeps bookings inside the 7am to 10pm opening hours', () => {
    expect(() => parseBooking('13 Aug Court 2 6am', NOW, TZ)).toThrow(/open at 7am/);
    expect(() => parseBooking('13 Aug Court 2 12:30am', NOW, TZ)).toThrow(/open at 7am/);
    expect(() => parseBooking('13 Aug Court 2 9:30pm', NOW, TZ)).toThrow(/last slot starts at 9pm/);
    expect(() => parseBooking('13 Aug Court 2 8pm-11pm', NOW, TZ)).toThrow(/close at 10pm/);
    // The last legal slot, and the first.
    expect(local(parseBooking('13 Aug Court 2 9pm', NOW, TZ).endsAt))
      .toMatchObject({ d: 13, h: 22, mi: 0 });
    expect(local(parseBooking('13 Aug Court 2 7am', NOW, TZ).startsAt))
      .toMatchObject({ d: 13, h: 7, mi: 0 });
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
    const draft = analyzeBooking('Friday 8pm-9:30pm, Court 2', NOW, TZ);
    expect(draftComplete(draft)).toBe(true);
    expect(draft.start).toEqual({ h: 20, mi: 0 });
    expect(draft.end).toEqual({ h: 21, mi: 30 });
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

  it('offers noon and midnight for a bare 12', () => {
    const draft = analyzeBooking('tomorrow Court 4 at 12', NOW, TZ);
    expect(draft.start).toBeNull();
    expect(draft.timeChoices.map((choice) => choice.label)).toEqual(['12am', '12pm']);
    expect(draft.timeChoices.map((choice) => choice.start.h)).toEqual([0, 12]);
    expect(draft.issues).toEqual(['Which time did you mean?']);
    expect(local(parseBooking('13 Aug Court 4 noon', NOW, TZ).startsAt))
      .toMatchObject({ d: 13, h: 12, mi: 0 });
  });

  it('reads a dashed time range as a time, not a numeric date', () => {
    const draft = analyzeBooking('friday 8-9, court 2', NOW, TZ);
    expect(draft.date).toMatchObject({ y: 2026, mo: 8, d: 14 });
    expect(draft.dateChoices).toEqual([]);
    expect(draft.timeChoices.map((choice) => choice.label)).toEqual(['8am–9am', '8pm–9pm']);
  });

  it('reads a dashed pair as a date when the message states the time elsewhere', () => {
    // "15-8" is also a valid 3pm–8pm range, so only the trailing 9pm settles it.
    const draft = analyzeBooking('court 4 15-8 9pm', NOW, TZ);
    expect(draft.date).toMatchObject({ y: 2026, mo: 8, d: 15 });
    expect(draft.dateChoices).toEqual([]);
    expect(draft.start).toEqual({ h: 21, mi: 0 });
    // 15-8 must not be claimed as the range either, or 9pm would be ignored.
    expect(draft.timeChoices).toEqual([]);
  });

  it('keeps reading a dashed pair as a date when it cannot be a time range', () => {
    const draft = analyzeBooking('court 4 20-9 8pm', NOW, TZ);
    expect(draft.date).toMatchObject({ y: 2026, mo: 9, d: 20 });
    expect(draft.start).toEqual({ h: 20, mi: 0 });
  });

  it('reads a slashed court list as courts, not a numeric date', () => {
    const draft = analyzeBooking('courts 3/4 friday 9pm', NOW, TZ);
    expect(draft.date).toMatchObject({ y: 2026, mo: 8, d: 14 });
    expect(draft.courtChoices).toEqual(['3', '4']);
    expect(draft.start).toEqual({ h: 21, mi: 0 });
  });

  it('still prefers an explicit numeric date over a weekday name', () => {
    const draft = analyzeBooking('sat 15/8 court 2 9pm', NOW, TZ);
    expect(draft.date).toMatchObject({ y: 2026, mo: 8, d: 15 });
  });

  it('reads relative dates in the club timezone, not UTC', () => {
    const draft = analyzeBooking('tmr c4 2100', PAST_MIDNIGHT, TZ);
    expect(draft.date).toMatchObject({ y: 2026, mo: 8, d: 15 });
    const booking = parseBooking('court 4 today 9pm', PAST_MIDNIGHT, TZ);
    expect(local(booking.startsAt)).toMatchObject({ y: 2026, mo: 8, d: 14, h: 21, mi: 0 });
  });
});

describe('booking intent', () => {
  it('recognises every README example as a plain group message', () => {
    const examples = [
      '13 Aug Court 4 9pm',
      'court four tomorrow at 9pm',
      'Friday 8pm-9:30pm, Court 2',
      'tmr c4 2100',
    ];
    const drafts = examples.map((text) => analyzeBooking(text, NOW, TZ));
    expect(drafts.map((draft) => draft !== null && draftComplete(draft)))
      .toEqual([true, true, true, true]);
    expect(drafts.map((draft) => draft.court)).toEqual(['4', '4', '2', '4']);
    expect(drafts.map((draft) => draft.start.h)).toEqual([21, 21, 20, 21]);
  });

  it('needs both a court and a time before an abbreviation counts', () => {
    expect(analyzeBooking('c4', NOW, TZ)).toBeNull();
    expect(analyzeBooking('anyone up for a game at 9pm?', NOW, TZ)).toBeNull();
    expect(analyzeBooking('he beat me 11-9, 11-7 last night', NOW, TZ)).toBeNull();
    expect(analyzeBooking('c4 tomorrow 9pm', NOW, TZ)).not.toBeNull();
  });
});

describe('pinned-board countdown', () => {
  it('names the weekday on every countdown', () => {
    expect(formatCountdown(Date.UTC(2026, 7, 12, 13, 0), TZ, NOW)).toBe('today · Wed');
    expect(formatCountdown(Date.UTC(2026, 7, 13, 13, 0), TZ, NOW)).toBe('tomorrow · Thu');
    expect(formatCountdown(Date.UTC(2026, 7, 17, 13, 0), TZ, NOW)).toBe('in 5 days · Mon 17 Aug');
    expect(formatCountdown(Date.UTC(2026, 7, 19, 13, 0), TZ, NOW)).toBe('in 7 days · Wed 19 Aug');
  });
});

import { localParts, monthNumber, validLocalDate, zonedEpoch } from './time.js';

export class BookingParseError extends Error {}

const MONTH_WORD = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const WEEKDAYS = new Map([
  ['sun', 0], ['sunday', 0], ['mon', 1], ['monday', 1],
  ['tue', 2], ['tues', 2], ['tuesday', 2], ['wed', 3], ['wednesday', 3],
  ['thu', 4], ['thur', 4], ['thurs', 4], ['thursday', 4],
  ['fri', 5], ['friday', 5], ['sat', 6], ['saturday', 6],
]);
const COURT_WORDS = new Map([
  ['one', '1'], ['two', '2'], ['three', '3'], ['four', '4'], ['five', '5'],
  ['six', '6'], ['seven', '7'], ['eight', '8'], ['nine', '9'], ['ten', '10'],
]);

function dateAdd(y, mo, d, days) {
  const value = new Date(Date.UTC(y, mo - 1, d + days));
  return { y: value.getUTCFullYear(), mo: value.getUTCMonth() + 1, d: value.getUTCDate() };
}

function monthAdd(y, mo, count) {
  const value = new Date(Date.UTC(y, mo - 1 + count, 1));
  return { y: value.getUTCFullYear(), mo: value.getUTCMonth() + 1 };
}

function dateExists(date) {
  const value = new Date(Date.UTC(date.y, date.mo - 1, date.d));
  return value.getUTCFullYear() === date.y
    && value.getUTCMonth() + 1 === date.mo
    && value.getUTCDate() === date.d;
}

function dateKey(value) {
  return `${value.y}-${String(value.mo).padStart(2, '0')}-${String(value.d).padStart(2, '0')}`;
}

function uniqueDates(values) {
  const seen = new Set();
  return values.filter((value) => {
    if (!value || !dateExists(value)) return false;
    const key = dateKey(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function inferredYear(month, day, current) {
  if (month < current.mo || (month === current.mo && day < current.d)) return current.y + 1;
  return current.y;
}

function normalizeYear(raw) {
  if (!raw) return null;
  const year = Number(raw);
  return year < 100 ? 2000 + year : year;
}

export function extractDate(text, nowMs = Date.now(), tz = 'Asia/Singapore') {
  const input = String(text).toLowerCase();
  const current = localParts(nowMs, tz);

  if (/\bday after tomorrow\b/.test(input)) return { value: dateAdd(current.y, current.mo, current.d, 2), choices: [] };
  if (/\btomorrow\b|\btmr\b|\btmrw\b/.test(input)) return { value: dateAdd(current.y, current.mo, current.d, 1), choices: [] };
  if (/\btoday\b|\btonight\b/.test(input)) return { value: { y: current.y, mo: current.mo, d: current.d }, choices: [] };

  let match = input.match(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/);
  if (match) {
    const value = { y: Number(match[1]), mo: Number(match[2]), d: Number(match[3]) };
    return dateExists(value) ? { value, choices: [] } : { value: null, choices: [], issue: 'That date does not exist.' };
  }

  match = input.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_WORD})(?:\\s+(\\d{2,4}))?\\b`, 'i'));
  if (!match) {
    match = input.match(new RegExp(`\\b(${MONTH_WORD})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{2,4}))?\\b`, 'i'));
    if (match) match = [match[0], match[2], match[1], match[3]];
  }
  if (match) {
    const d = Number(match[1]);
    const mo = monthNumber(match[2]);
    const y = normalizeYear(match[3]) || inferredYear(mo, d, current);
    const value = { y, mo, d };
    return dateExists(value) ? { value, choices: [] } : { value: null, choices: [], issue: 'That date does not exist.' };
  }

  // “courts 3/4” lists two courts and “8-9” is a time range, so a numeric pair
  // only counts as a date once those readings are ruled out. Anything left over
  // still beats a weekday name, because “sat 15/8” means the 15th.
  match = null;
  for (const numeric of input.matchAll(/\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b/g)) {
    if (/\b(?:courts?|crt|ct|c)\s*#?\s*$/.test(input.slice(0, numeric.index))) continue;
    if (numeric[0].includes('-') && !numeric[3]
      && readsAsTimeRange(numeric[1], numeric[2])
      && !statesClockElsewhere(input, numeric.index, numeric[0].length)) continue;
    match = numeric;
    break;
  }
  if (match) {
    const first = Number(match[1]);
    const second = Number(match[2]);
    const explicitYear = normalizeYear(match[3]);
    if (first > 31 || second > 12 || first < 1 || second < 1) {
      return { value: null, choices: [], issue: 'That numeric date is not valid.' };
    }
    const primary = {
      y: explicitYear || inferredYear(second, first, current), mo: second, d: first,
    };
    if (!explicitYear && first <= 12 && second <= 12 && first !== second) {
      const alternate = { y: inferredYear(first, second, current), mo: first, d: second };
      const choices = uniqueDates([primary, alternate]);
      return choices.length === 1
        ? { value: choices[0], choices: [] }
        : { value: null, choices, issue: 'Which numeric date did you mean?' };
    }
    return dateExists(primary)
      ? { value: primary, choices: [] }
      : { value: null, choices: [], issue: 'That date does not exist.' };
  }

  match = input.match(/\b(next\s+)?(sun(?:day)?|mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?)\b/i);
  if (match) {
    const weekday = WEEKDAYS.get(match[2].toLowerCase());
    const todayWeekday = new Date(Date.UTC(current.y, current.mo - 1, current.d)).getUTCDay();
    let ahead = (weekday - todayWeekday + 7) % 7;
    // In booking language, "next Monday" means the nearest upcoming Monday.
    // Only advance a full week when today is already that weekday.
    if (match[1] && ahead === 0) ahead = 7;
    return { value: dateAdd(current.y, current.mo, current.d, ahead), choices: [] };
  }

  // A day number without a month is genuinely ambiguous. Offer the next two
  // matching calendar dates instead of silently choosing a month.
  match = input.match(/\bon(?:\s+the)?\s+(\d{1,2})(?:st|nd|rd|th)?\b/);
  if (match) {
    const day = Number(match[1]);
    const candidates = [];
    for (let add = 0; add < 4 && candidates.length < 2; add++) {
      const m = monthAdd(current.y, current.mo, add);
      const candidate = { y: m.y, mo: m.mo, d: day };
      if (!dateExists(candidate)) continue;
      if (add === 0 && day < current.d) continue;
      candidates.push(candidate);
    }
    return { value: null, choices: candidates, issue: 'Which month did you mean?' };
  }

  return { value: null, choices: [] };
}

function courtValue(raw) {
  const clean = String(raw).trim().toLowerCase();
  return COURT_WORDS.get(clean) || clean.toUpperCase();
}

export function extractCourt(text) {
  const input = String(text);
  const matches = [];
  const pattern = /\b(?:courts?|crt|ct|c)\s*#?\s*(\d{1,2}|[a-z]|one|two|three|four|five|six|seven|eight|nine|ten)\b/gi;
  for (const match of input.matchAll(pattern)) matches.push(courtValue(match[1]));

  // “Courts 3 and 4” or “court 3/4” deliberately produces choices; the bot
  // never assumes which one of multiple court numbers was intended.
  const list = input.match(/\bcourts?\s*#?\s*(\d{1,2}|[a-z])\s*(?:and|&|\/|,)\s*#?\s*(\d{1,2}|[a-z])\b/i);
  if (list) matches.push(courtValue(list[1]), courtValue(list[2]));
  const unique = [...new Set(matches)];
  if (unique.length === 1) return { value: unique[0], choices: [] };
  if (unique.length > 1) return { value: null, choices: unique, issue: 'Which court did you mean?' };
  return { value: null, choices: [] };
}

function clockCandidates(raw, inheritedMeridiem = null) {
  const clean = String(raw).trim().toLowerCase().replace(/\s+/g, '');
  if (clean === 'noon') return [{ h: 12, mi: 0 }];
  if (clean === 'midnight') return [{ h: 0, mi: 0 }];
  if (/^\d{3,4}$/.test(clean)) {
    const padded = clean.padStart(4, '0');
    const h = Number(padded.slice(0, 2));
    const mi = Number(padded.slice(2));
    return h <= 23 && mi <= 59 ? [{ h, mi }] : [];
  }
  const match = clean.match(/^(\d{1,2})(?:(?::|\.)(\d{2}))?(am|pm)?$/);
  if (!match) return [];
  let h = Number(match[1]);
  const mi = Number(match[2] || 0);
  const meridiem = match[3] || inheritedMeridiem;
  if (mi > 59) return [];
  if (meridiem) {
    if (h < 1 || h > 12) return [];
    h = h % 12 + (meridiem === 'pm' ? 12 : 0);
    return [{ h, mi }];
  }
  if (h > 23) return [];
  if (h === 0 || h > 12) return [{ h, mi }];
  // 12 is midnight or noon; adding 12 to it would invent an hour 24.
  if (h === 12) return [{ h: 0, mi }, { h: 12, mi }];
  return [{ h, mi }, { h: h + 12, mi }];
}

function clockLabel(clock) {
  const suffix = clock.h >= 12 ? 'pm' : 'am';
  const hour = clock.h % 12 || 12;
  return `${hour}${clock.mi ? `:${String(clock.mi).padStart(2, '0')}` : ''}${suffix}`;
}

function timeChoice(start, end = null) {
  return {
    start,
    end,
    label: end ? `${clockLabel(start)}–${clockLabel(end)}` : clockLabel(start),
  };
}

function validRange(start, end) {
  const startMinutes = start.h * 60 + start.mi;
  let endMinutes = end.h * 60 + end.mi;
  if (endMinutes <= startMinutes) endMinutes += 1440;
  const duration = endMinutes - startMinutes;
  return duration > 0 && duration <= 360;
}

function readsAsTimeRange(first, second) {
  for (const start of clockCandidates(first)) {
    for (const end of clockCandidates(second)) if (validRange(start, end)) return true;
  }
  return false;
}

// A bare “15-8” is both a plausible date and a plausible 3pm–8pm range. What
// settles it is the rest of the message: “court 4 15-8 9pm” already says 9pm, so
// the pair is the date, while “friday 8-9” has no other clock and so is the
// range. Both readers ask this, which is what keeps them from disagreeing.
function statesClockElsewhere(input, index, length) {
  return CLOCK_TOKEN.test(`${input.slice(0, index)} ${input.slice(index + length)}`);
}

export function extractTime(text) {
  const input = String(text).toLowerCase();
  const atom = '(?:\\d{1,2}(?:(?::|\\.)\\d{2})?\\s*(?:am|pm)?|\\d{3,4}|noon|midnight)';
  const range = input.match(new RegExp(`\\b(${atom})\\s*(?:-|–|—|to|until)\\s*(${atom})\\b`, 'i'));
  if (range && !statesClockElsewhere(input, range.index, range[0].length)) {
    const firstMeridiem = (range[1].match(/(am|pm)/i) || [])[1] || null;
    const secondMeridiem = (range[2].match(/(am|pm)/i) || [])[1] || null;
    const starts = clockCandidates(range[1], secondMeridiem);
    const ends = clockCandidates(range[2], firstMeridiem);
    const choices = [];
    for (const start of starts) {
      for (const end of ends) if (validRange(start, end)) choices.push(timeChoice(start, end));
    }
    const unique = [...new Map(choices.map((choice) => [choice.label, choice])).values()];
    if (unique.length === 1) return { value: unique[0], choices: [] };
    if (unique.length > 1) return { value: null, choices: unique, issue: 'Which time range did you mean?' };
    return { value: null, choices: [], issue: 'That time range is invalid or longer than 6 hours.' };
  }

  const tokens = [];
  const explicit = /\b(?:\d{1,2}(?:(?::|\.)\d{2})?\s*(?:am|pm)|\d{1,2}(?::|\.)\d{2}|\d{3,4}|noon|midnight)\b/gi;
  for (const match of input.matchAll(explicit)) {
    const token = match[0];
    const before = input.slice(Math.max(0, match.index - 20), match.index);
    const after = input.slice(match.index + token.length, match.index + token.length + 10);
    // Do not mistake the year in “13 Aug 2026” or “2026-08-13” for 20:26.
    const looksLikeYear = /^20\d{2}$/.test(token)
      && (new RegExp(`${MONTH_WORD}\\s*$`, 'i').test(before) || /^\s*[-/]\d/.test(after));
    if (!looksLikeYear) tokens.push(token);
  }
  if (!tokens.length) {
    const at = input.match(/(?:\bat\b|@)\s*(\d{1,2})(?:[:.](\d{2}))?\s*$/i)
      || input.match(/\b(?:court|crt|ct|c)\s*#?\s*(?:\d{1,2}|[a-z]|one|two|three|four|five|six|seven|eight|nine|ten)\s+(\d{1,2})(?:[:.](\d{2}))?\s*$/i);
    if (at) tokens.push(`${at[1]}${at[2] ? `:${at[2]}` : ''}`);
  }
  if (!tokens.length) return { value: null, choices: [] };

  const choices = [];
  for (const token of tokens) {
    for (const clock of clockCandidates(token)) choices.push(timeChoice(clock));
  }
  const unique = [...new Map(choices.map((choice) => [choice.label, choice])).values()];
  if (unique.length === 1) return { value: unique[0], choices: [] };
  if (unique.length > 1) return { value: null, choices: unique, issue: 'Which time did you mean?' };
  return { value: null, choices: [], issue: 'I could not read that time.' };
}

const COURT_ABBREVIATION = /\b(?:ct|c)\s*#?\s*(?:\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)\b/i;
const CLOCK_TOKEN = /\b(?:\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm)|\d{1,2}[:.]\d{2}|(?:[01]?\d|2[0-3])[0-5]\d|noon|midnight)\b/i;

export function looksLikeBooking(text, forceIntent = false) {
  if (forceIntent) return true;
  const input = String(text);
  if (/\b(?:court|courts|crt|squash|book(?:ed|ing)?)\b/i.test(input)) {
    return /\d/.test(input) || /\b(?:today|tonight|tomorrow|tmr|noon|midnight)\b/i.test(input);
  }
  // “tmr c4 2100” never says court, so the c/ct abbreviation counts as well —
  // but only next to a real clock time. On its own a “c4” or a “2100” in
  // conversation must not hijack the message into a booking form.
  return COURT_ABBREVIATION.test(input) && CLOCK_TOKEN.test(input);
}

export function analyzeBooking(text, nowMs = Date.now(), tz = 'Asia/Singapore', { forceIntent = false } = {}) {
  if (!looksLikeBooking(text, forceIntent)) return null;
  const date = extractDate(text, nowMs, tz);
  const court = extractCourt(text);
  const time = extractTime(text);
  return {
    sourceText: String(text).trim(),
    date: date.value,
    court: court.value,
    start: time.value && time.value.start,
    end: time.value && time.value.end,
    dateChoices: date.choices,
    courtChoices: court.choices,
    timeChoices: time.choices,
    issues: [date.issue, court.issue, time.issue].filter(Boolean),
  };
}

export function draftComplete(draft) {
  return Boolean(draft.date && draft.court && draft.start);
}

// Courts run 7am to 10pm, so the last slot starts at 9pm. Everything outside
// those hours is rejected rather than silently booked.
export const OPEN_HOUR = 7;
export const LAST_START_HOUR = 21;
export const CLOSE_HOUR = 22;

export function bookingFromDraft(draft, nowMs = Date.now(), tz = 'Asia/Singapore') {
  if (!draftComplete(draft)) throw new BookingParseError('The booking still needs a date, court, and start time.');
  const { y, mo, d } = draft.date;
  const startsAt = zonedEpoch(y, mo, d, draft.start.h, draft.start.mi, tz);
  if (!validLocalDate(startsAt, { y, mo, d, h: draft.start.h, mi: draft.start.mi }, tz)) {
    throw new BookingParseError('That date or time does not exist.');
  }
  if (startsAt <= nowMs) throw new BookingParseError('That booking time has already passed. Change the date or time.');

  const startMinutes = draft.start.h * 60 + draft.start.mi;
  if (startMinutes < OPEN_HOUR * 60) {
    throw new BookingParseError('Courts open at 7am. Choose a later start time.');
  }
  if (startMinutes > LAST_START_HOUR * 60) {
    throw new BookingParseError('The last slot starts at 9pm. Choose an earlier start time.');
  }

  let endsAt = startsAt + 60 * 60 * 1000;
  if (draft.end) {
    const endMinutes = draft.end.h * 60 + draft.end.mi;
    if (endMinutes <= startMinutes) {
      throw new BookingParseError('The finish time has to be after the start time.');
    }
    if (endMinutes > CLOSE_HOUR * 60) {
      throw new BookingParseError('Courts close at 10pm. Choose an earlier finish time.');
    }
    endsAt = zonedEpoch(y, mo, d, draft.end.h, draft.end.mi, tz);
  } else if (startMinutes + 60 > CLOSE_HOUR * 60) {
    endsAt = zonedEpoch(y, mo, d, CLOSE_HOUR, 0, tz);
  }
  const midnight = zonedEpoch(y, mo, d, 0, 0, tz);
  const eightAm = zonedEpoch(y, mo, d, 8, 0, tz);
  const reminderAt = Math.max(midnight, Math.min(eightAm, startsAt - 60 * 60 * 1000));
  return { court: String(draft.court), startsAt, endsAt, reminderAt };
}

export function parseField(field, text, nowMs = Date.now(), tz = 'Asia/Singapore') {
  if (field === 'date') return extractDate(text, nowMs, tz);
  if (field === 'time') return extractTime(text);
  if (field === 'court') {
    const parsed = extractCourt(text);
    if (parsed.value || parsed.choices.length) return parsed;
    const raw = String(text).trim().replace(/^(?:court|crt|ct|c)\s*#?\s*/i, '');
    if (/^[a-z0-9][a-z0-9 -]{0,19}$/i.test(raw)) return { value: courtValue(raw), choices: [] };
    return { value: null, choices: [], issue: 'Reply with a court number or name, such as 4 or Court A.' };
  }
  throw new BookingParseError(`Unknown booking field: ${field}`);
}

// Backward-compatible convenience for callers that require a complete input.
export function parseBooking(text, nowMs = Date.now(), tz = 'Asia/Singapore') {
  const draft = analyzeBooking(text, nowMs, tz);
  if (!draft) return null;
  if (!draftComplete(draft)) throw new BookingParseError(draft.issues[0] || 'I need more booking details.');
  return bookingFromDraft(draft, nowMs, tz);
}

export function formatClock(clock) {
  return clockLabel(clock);
}

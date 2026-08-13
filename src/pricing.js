import { localParts, zonedEpoch } from './time.js';

// Court rates. Evenings, weekends, and Singapore public holidays cost more.
const PEAK_RATE_CENTS = 600;
const OFF_PEAK_RATE_CENTS = 300;
const PEAK_FROM_HOUR = 18;

// Singapore public holidays. Lunar and Islamic dates move every year, so verify
// this list against mom.gov.sg each December and override it without a deploy by
// setting PUBLIC_HOLIDAYS in wrangler.toml to a comma-separated YYYY-MM-DD list.
// Pricing a day in a year this list does not reach logs a warning rather than
// treating that year as holiday-free.
const DEFAULT_PUBLIC_HOLIDAYS = [
  '2026-01-01', // New Year's Day
  '2026-02-17', // Chinese New Year
  '2026-02-18', // Chinese New Year
  '2026-03-21', // Hari Raya Puasa
  '2026-04-03', // Good Friday
  '2026-05-01', // Labour Day
  '2026-05-27', // Hari Raya Haji
  '2026-05-31', // Vesak Day
  '2026-06-01', // Vesak Day observed
  '2026-08-09', // National Day
  '2026-08-10', // National Day observed
  '2026-11-08', // Deepavali
  '2026-11-09', // Deepavali observed
  '2026-12-25', // Christmas Day
];

// Pricing runs on every board and tab render, so a misconfigured holiday list
// would otherwise repeat the same line on every cron tick. Once per worker
// isolate is enough to see it in `npx wrangler tail`.
const warned = new Set();
function warnOnce(message) {
  if (warned.has(message)) return;
  warned.add(message);
  console.log(message);
}

const HOLIDAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

// Holidays are matched verbatim against a zero-padded key, so "2027-1-1" or
// "2027-02-30" would survive to runtime and then never match any day, charging
// that holiday off-peak without a word. Reject them where they are read.
function isHolidayKey(day) {
  if (!HOLIDAY_KEY.test(day)) return false;
  const [y, mo, d] = day.split('-').map(Number);
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

export function publicHolidays(env) {
  const configured = String((env && env.PUBLIC_HOLIDAYS) || '')
    .split(',').map((day) => day.trim()).filter(Boolean)
    .filter((day) => {
      if (isHolidayKey(day)) return true;
      warnOnce(`PUBLIC_HOLIDAYS entry "${day}" is not a YYYY-MM-DD date and was ignored.`);
      return false;
    });
  return configured.length ? configured : DEFAULT_PUBLIC_HOLIDAYS;
}

function dateKey(parts) {
  return `${parts.y}-${String(parts.mo).padStart(2, '0')}-${String(parts.d).padStart(2, '0')}`;
}

// Weekends and public holidays are charged at the evening rate all day.
export function isPeakDay(epochMs, tz, holidays = []) {
  const parts = localParts(epochMs, tz);
  const weekday = new Date(Date.UTC(parts.y, parts.mo - 1, parts.d)).getUTCDay();
  if (weekday === 0 || weekday === 6) return true;
  if (holidays.includes(dateKey(parts))) return true;
  // Gazetted dates cannot be predicted, so guessing them is not an option — but
  // a year the list has never heard of is not a year without holidays either.
  // Every one of them is being billed at half rate until someone updates it.
  if (!holidays.some((day) => day.startsWith(`${parts.y}-`))) {
    warnOnce(`No public holidays listed for ${parts.y}, so its weekday holidays`
      + ' are billed off-peak. Check mom.gov.sg, then set PUBLIC_HOLIDAYS or'
      + ' update DEFAULT_PUBLIC_HOLIDAYS in src/pricing.js.');
  }
  return false;
}

function nextLocalMidnight(epochMs, tz) {
  const parts = localParts(epochMs, tz);
  const tomorrow = new Date(Date.UTC(parts.y, parts.mo - 1, parts.d + 1));
  return zonedEpoch(
    tomorrow.getUTCFullYear(), tomorrow.getUTCMonth() + 1, tomorrow.getUTCDate(), 0, 0, tz
  );
}

// Charged one local day at a time, because a court booked 11pm–1am is an evening
// hour followed by an hour on a day that may be priced completely differently.
export function courtCostCents(startsAt, endsAt, tz, holidays = []) {
  if (endsAt <= startsAt) return 0;
  let cents = 0;
  let cursor = startsAt;
  // A booking is capped at six hours, so this runs at most twice.
  for (let guard = 0; cursor < endsAt && guard < 8; guard += 1) {
    const midnight = nextLocalMidnight(cursor, tz);
    const segmentEnd = Math.min(endsAt, midnight);
    const minutes = Math.round((segmentEnd - cursor) / 60000);
    if (minutes > 0) cents += dayCostCents(cursor, minutes, tz, holidays);
    cursor = segmentEnd;
  }
  return cents;
}

// One local day's slice, split at 6pm when that day is charged by the hour.
function dayCostCents(startsAt, minutes, tz, holidays) {
  if (isPeakDay(startsAt, tz, holidays)) {
    return Math.round((PEAK_RATE_CENTS * minutes) / 60);
  }
  const parts = localParts(startsAt, tz);
  const peakStart = zonedEpoch(parts.y, parts.mo, parts.d, PEAK_FROM_HOUR, 0, tz);
  const endsAt = startsAt + minutes * 60000;
  const offPeakMinutes = Math.min(
    minutes, Math.max(0, Math.round((Math.min(endsAt, peakStart) - startsAt) / 60000))
  );
  const peakMinutes = minutes - offPeakMinutes;
  return Math.round((OFF_PEAK_RATE_CENTS * offPeakMinutes) / 60)
    + Math.round((PEAK_RATE_CENTS * peakMinutes) / 60);
}

// The organiser pays the court and absorbs any rounding remainder.
export function shareCents(totalCents, playerCount) {
  if (playerCount <= 0) return 0;
  return Math.floor(totalCents / playerCount);
}

export function formatMoney(cents) {
  const amount = Math.abs(Math.round(cents));
  return `${cents < 0 ? '-' : ''}$${Math.floor(amount / 100)}.${String(amount % 100).padStart(2, '0')}`;
}

// Building an Intl.DateTimeFormat is far slower than using one: a board or a
// tab formats dozens of dates, and each call used to build its own. One
// formatter per locale and option set is kept for the isolate's life. A bad
// timezone throws in the constructor, before anything is cached.
const formatters = new Map();

export function dateFormatter(locale, options) {
  const key = `${locale}|${JSON.stringify(options)}`;
  let formatter = formatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, options);
    if (formatters.size > 256) formatters.clear();
    formatters.set(key, formatter);
  }
  return formatter;
}

const MONTHS = new Map([
  ['jan', 1], ['january', 1], ['feb', 2], ['february', 2],
  ['mar', 3], ['march', 3], ['apr', 4], ['april', 4],
  ['may', 5], ['jun', 6], ['june', 6], ['jul', 7], ['july', 7],
  ['aug', 8], ['august', 8], ['sep', 9], ['sept', 9], ['september', 9],
  ['oct', 10], ['october', 10], ['nov', 11], ['november', 11],
  ['dec', 12], ['december', 12],
]);

export function monthNumber(value) {
  const raw = String(value).toLowerCase();
  if (/^\d{1,2}$/.test(raw)) {
    const n = Number(raw);
    return n >= 1 && n <= 12 ? n : null;
  }
  return MONTHS.get(raw) || null;
}
export function localParts(epochMs, tz) {
  const formatter = dateFormatter('en-US', {
    timeZone: tz,
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric', hour12: false,
  });
  const parts = {};
  for (const part of formatter.formatToParts(new Date(epochMs))) parts[part.type] = part.value;
  return {
    y: Number(parts.year), mo: Number(parts.month), d: Number(parts.day),
    h: Number(parts.hour) % 24, mi: Number(parts.minute), s: Number(parts.second),
  };
}

// Converts a wall-clock time in an IANA timezone to a UTC epoch.
export function zonedEpoch(y, mo, d, h, mi, tz) {
  let guess = Date.UTC(y, mo - 1, d, h, mi, 0);
  for (let i = 0; i < 3; i++) {
    const p = localParts(guess, tz);
    const wanted = Date.UTC(y, mo - 1, d, h, mi, 0);
    const actual = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
    const difference = wanted - actual;
    if (!difference) break;
    guess += difference;
  }
  return guess;
}

export function validLocalDate(epochMs, expected, tz) {
  const p = localParts(epochMs, tz);
  return p.y === expected.y && p.mo === expected.mo && p.d === expected.d
    && p.h === expected.h && p.mi === expected.mi;
}

export function formatDate(epochMs, tz) {
  return dateFormatter('en-SG', {
    timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
  }).format(new Date(epochMs));
}

export function formatTime(epochMs, tz) {
  return dateFormatter('en-SG', {
    timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(new Date(epochMs));
}

import { escapeHtml, mentionHtml } from './telegram.js';
import { localParts } from './time.js';

// How a court is named everywhere a person reads it. These live apart from
// the modules that render with them so the tab never has to reach back into
// bookings — which imports the tab — just to spell a court's name.

export function courtName(booking) {
  return String(booking.court).startsWith('Court ')
    ? String(booking.court) : `Court ${booking.court}`;
}

// Inline keyboard buttons ellipsize well before fifty characters on a normal
// phone, and what got cut was the slot count — the one thing the tap decision
// depends on. A numeric court compresses to "C4"; a named court keeps its name.
export function shortCourtName(booking) {
  const court = String(booking.court).trim();
  return /^\d+$/.test(court) ? `C${court}` : courtName(booking);
}

export function shortClock(epochMs, tz) {
  const parts = localParts(epochMs, tz);
  const suffix = parts.h >= 12 ? 'pm' : 'am';
  const hour = parts.h % 12 || 12;
  return `${hour}${parts.mi ? `:${String(parts.mi).padStart(2, '0')}` : ''}${suffix}`;
}

export function formatCountdown(epochMs, tz, now = Date.now()) {
  const target = localParts(epochMs, tz);
  const current = localParts(now, tz);
  const days = Math.round((
    Date.UTC(target.y, target.mo - 1, target.d)
    - Date.UTC(current.y, current.mo - 1, current.d)
  ) / 86400000);
  const date = shortDate(epochMs, tz);
  if (days <= 0) return `today · ${date}`;
  if (days === 1) return `tomorrow · ${date}`;
  return `in ${days} days · ${date}`;
}

const ONE_HOUR_MS = 60 * 60 * 1000;

// An hour is the standard slot, so its end time says nothing worth the space.
export function compactTimeRange(startsAt, endsAt, tz) {
  const start = shortClock(startsAt, tz);
  if (endsAt - startsAt === ONE_HOUR_MS) return start;
  return `${start}–${shortClock(endsAt, tz)}`;
}

export function shortDate(epochMs, tz) {
  return new Intl.DateTimeFormat('en-SG', {
    timeZone: tz, weekday: 'short', day: 'numeric', month: 'short',
  }).format(new Date(epochMs)).replace(',', '');
}

// Slots one roster row holds: two when an admin seated that member with a
// friend. A row written before the column existed carries no heads at all, and
// stands for the one person it always did.
export function playerHeads(player) {
  return player.heads || 1;
}

// Capacity and the tab both count people, not rows, so every comparison against
// capacity goes through this rather than roster.length.
export function rosterHeads(roster) {
  return roster.reduce((total, player) => total + playerHeads(player), 0);
}

// A player whose numeric id is known gets a real tag. Anyone still seeded from
// config by username is written as plain @handle, which Telegram links and
// notifies by itself; their id is filled in the first time they post.
export function playerTags(roster) {
  if (!roster.length) return 'nobody yet';
  return roster.map((player) => {
    // A friend has no identity of their own, so they are named on the person
    // who brought them rather than as a row nobody could tap or bill.
    const name = playerHeads(player) > 1 ? `${player.name} +1` : player.name;
    return player.user_id ? mentionHtml(player.user_id, name) : escapeHtml(name);
  }).join(', ');
}

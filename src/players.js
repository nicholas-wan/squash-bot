import { dataChatId } from './scope.js';
import { telegram } from './telegram.js';

export const DEFAULT_CAPACITY = 3;
export const MAX_CAPACITY = 12;

// A player's stable key. Telegram usernames are how this group refers to each
// other and are the only identity a config file can name, so they win; a numeric
// id is the fallback for anyone without one. Keying on the id instead would
// split "@dodgerblueee seeded from config" and "@dodgerblueee who tapped join"
// into two people on the same court.
export function identity(from) {
  // Telegram usernames are case-insensitive, so the slug is lowercased to match
  // however someone types it. The display name keeps the casing they chose.
  const handle = from && from.username ? String(from.username).replace(/^@/, '') : null;
  const username = handle ? handle.toLowerCase() : null;
  const userId = (from && from.id) || null;
  const name = handle ? `@${handle}` : ((from && from.first_name) || 'Player');
  return {
    userId, username, name,
    slug: username ? `@${username}` : (userId ? `u${userId}` : `n${name.toLowerCase()}`),
  };
}

export function playerName(from) {
  return identity(from).name;
}

// Accepts "@username", a numeric id, "id:Name", or a bare name.
function parsePlayer(entry) {
  const raw = String(entry).trim();
  if (raw.startsWith('@')) return identity({ username: raw });
  if (/^\d+$/.test(raw)) return identity({ id: Number(raw) });
  const separator = raw.indexOf(':');
  if (separator !== -1 && /^\d+$/.test(raw.slice(0, separator).trim())) {
    return identity({
      id: Number(raw.slice(0, separator).trim()),
      first_name: raw.slice(separator + 1).trim() || 'Player',
    });
  }
  return identity({ first_name: raw });
}

export function ownerIdentity(env) {
  const raw = String((env && (env.OWNER || env.OWNER_USER_ID)) || '').trim();
  return raw ? parsePlayer(raw) : null;
}

export function ownerName(env) {
  const configured = String((env && env.OWNER_NAME) || '').trim();
  if (configured) return configured;
  const owner = ownerIdentity(env);
  return owner ? owner.name : 'the organiser';
}

// Players added to every new booking.
export function defaultPlayers(env) {
  return String((env && env.DEFAULT_PLAYERS) || '').split(',')
    .map((entry) => entry.trim()).filter(Boolean).map(parsePlayer);
}

// Players who are never charged but are not added to every booking either.
// DEFAULT_PLAYERS covers the household; this covers anyone else who plays free.
export function unbilledPlayers(env) {
  return String((env && env.UNBILLED_PLAYERS) || '').split(',')
    .map((entry) => entry.trim()).filter(Boolean).map(parsePlayer);
}

// Nobody in this set reaches the tab: the organiser pays the court, and the
// household and anyone listed as unbilled play on it for free.
export function householdSlugs(env) {
  const slugs = new Set(defaultPlayers(env).map((player) => player.slug));
  for (const player of unbilledPlayers(env)) slugs.add(player.slug);
  const owner = ownerIdentity(env);
  if (owner) slugs.add(owner.slug);
  return slugs;
}

export function defaultCapacity(env) {
  const configured = Number(String((env && env.DEFAULT_CAPACITY) || '').trim());
  return Number.isFinite(configured) && configured > 0
    ? Math.min(configured, MAX_CAPACITY) : DEFAULT_CAPACITY;
}

export async function isChatAdmin(env, chatId, from) {
  if (!from || !from.id) return false;
  const owner = ownerIdentity(env);
  const who = identity(from);
  if (owner && (owner.slug === who.slug || owner.userId === who.userId)) return true;
  const member = await telegram(env, 'getChatMember', { chat_id: chatId, user_id: from.id });
  if (!member.ok) return false;
  return member.result.status === 'creator' || member.result.status === 'administrator';
}

// Fills in the numeric id of a player who was seeded from config by username,
// and keeps that id pointing at one player. Without the id that player can never
// be sent a reminder.
export async function rememberPlayer(env, from) {
  const who = identity(from);
  if (!who.userId || !who.username) return;
  await env.DB.prepare(
    'UPDATE booking_players SET user_id = ? WHERE slug = ? AND user_id IS NULL'
  ).bind(who.userId, who.slug).run();
  // Someone can set or change their username long after they were first seated,
  // and config can name them by bare id, so the same human ends up spelled two
  // ways. The numeric id is what proves the two spellings are one person: their
  // old rows move onto the slug they key as now, because otherwise they are
  // offered Join for a court they are already on, take a second seat on it, and
  // are billed twice for the one game.
  await env.DB.prepare(
    `DELETE FROM booking_players
      WHERE user_id = ? AND slug != ?
        AND booking_id IN (SELECT booking_id FROM booking_players WHERE slug = ?)`
  ).bind(who.userId, who.slug, who.slug).run();
  // Both spellings can already sit on one booking, where UNIQUE
  // (booking_id, slug) leaves no room to move the old row in: the delete above
  // drops it first so the merge is one row, not a constraint failure.
  await env.DB.prepare(
    'UPDATE booking_players SET slug = ?, name = ? WHERE user_id = ? AND slug != ?'
  ).bind(who.slug, who.name, who.userId, who.slug).run();
}

async function addPlayer(env, chatId, bookingId, player, addedByUserId) {
  return env.DB.prepare(
    `INSERT OR IGNORE INTO booking_players
      (booking_id, chat_id, user_id, slug, name, added_by_user_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    bookingId, chatId, player.userId || null, player.slug, player.name,
    addedByUserId || null, Date.now()
  ).run();
}

// Every booking starts with whoever booked it plus the organiser's household.
// The booker is seated first because the slice below drops whoever does not fit,
// and the one person who must never lose their seat is the one who made the
// booking. chatId is the real chat the booking was made in, which is where those
// players are reachable for reminders.
export async function seedRoster(env, chatId, bookingId, from, capacity) {
  const seats = [];
  const seat = (player) => {
    if (player && !seats.some((seated) => seated.slug === player.slug)) seats.push(player);
  };
  if (from && from.id) seat(identity(from));
  seat(ownerIdentity(env));
  for (const player of defaultPlayers(env)) seat(player);
  for (const player of seats.slice(0, capacity)) {
    await addPlayer(env, chatId, bookingId, player, from && from.id);
  }
}

export async function rosterFor(env, bookingId) {
  return (await env.DB.prepare(
    'SELECT * FROM booking_players WHERE booking_id = ? ORDER BY id'
  ).bind(bookingId).all()).results;
}

// One query for the whole board. Players are matched through their booking
// rather than their own chat_id, because a shared booking can hold people who
// joined from different groups.
export async function rostersFor(env, chatId, bookingIds) {
  const rosters = new Map(bookingIds.map((id) => [id, []]));
  if (!bookingIds.length) return rosters;
  const { results } = await env.DB.prepare(
    `SELECT * FROM booking_players
     WHERE booking_id IN (SELECT id FROM bookings WHERE chat_id = ?)
     ORDER BY booking_id, id`
  ).bind(dataChatId(env, chatId)).all();
  for (const player of results) {
    const roster = rosters.get(player.booking_id);
    if (roster) roster.push(player);
  }
  return rosters;
}

// Joining and leaving both close when the court starts, so nobody can play a
// full hour and then drop off the roster to dodge their share.
async function openBooking(env, chatId, bookingId) {
  return env.DB.prepare(
    'SELECT * FROM bookings WHERE id = ? AND chat_id = ? AND ends_at > ?'
  ).bind(bookingId, dataChatId(env, chatId), Date.now()).first();
}

export async function joinBooking(env, chatId, bookingId, from) {
  const booking = await openBooking(env, chatId, bookingId);
  if (!booking) return { status: 'gone' };
  if (booking.starts_at <= Date.now()) return { status: 'started', booking };

  const who = identity(from);
  const capacity = booking.capacity || DEFAULT_CAPACITY;
  // The count check lives inside the insert, so two people racing for the last
  // slot cannot both win. OR IGNORE covers someone already on the roster.
  const joined = await env.DB.prepare(
    `INSERT OR IGNORE INTO booking_players
      (booking_id, chat_id, user_id, slug, name, added_by_user_id, created_at)
     SELECT ?, ?, ?, ?, ?, ?, ?
     WHERE (SELECT COUNT(*) FROM booking_players WHERE booking_id = ?) < ?`
  ).bind(
    bookingId, chatId, who.userId, who.slug, who.name, who.userId, Date.now(),
    bookingId, capacity
  ).run();
  if (joined.meta.changes) return { status: 'joined', booking };
  const existing = await env.DB.prepare(
    'SELECT id FROM booking_players WHERE booking_id = ? AND slug = ?'
  ).bind(bookingId, who.slug).first();
  return { status: existing ? 'already' : 'full', booking };
}

export async function leaveBooking(env, chatId, bookingId, from) {
  const booking = await openBooking(env, chatId, bookingId);
  if (!booking) return { status: 'gone' };
  if (booking.starts_at <= Date.now()) return { status: 'started', booking };
  const removed = await env.DB.prepare(
    'DELETE FROM booking_players WHERE booking_id = ? AND slug = ?'
  ).bind(bookingId, identity(from).slug).run();
  return { status: removed.meta.changes ? 'left' : 'absent', booking };
}

// Admins can take someone off a roster right up to the end of the slot, which is
// also how a no-show is kept off the tab: charging happens once the court
// expires, using whoever is still on the roster then.
export async function removeBookingPlayer(env, chatId, bookingId, playerRowId) {
  const booking = await env.DB.prepare(
    'SELECT * FROM bookings WHERE id = ? AND chat_id = ? AND ends_at > ?'
  ).bind(bookingId, dataChatId(env, chatId), Date.now()).first();
  if (!booking) return null;
  const player = await env.DB.prepare(
    'SELECT * FROM booking_players WHERE id = ? AND booking_id = ?'
  ).bind(playerRowId, bookingId).first();
  if (!player) return null;
  const removed = await env.DB.prepare(
    'DELETE FROM booking_players WHERE id = ? AND booking_id = ?'
  ).bind(playerRowId, bookingId).run();
  return removed.meta.changes ? { player, booking } : null;
}

export async function raiseCapacity(env, chatId, bookingId) {
  const result = await env.DB.prepare(
    `UPDATE bookings SET capacity = capacity + 1
     WHERE id = ? AND chat_id = ? AND ends_at > ? AND capacity < ?`
  ).bind(bookingId, dataChatId(env, chatId), Date.now(), MAX_CAPACITY).run();
  if (!result.meta.changes) return null;
  const booking = await env.DB.prepare('SELECT capacity FROM bookings WHERE id = ?')
    .bind(bookingId).first();
  return booking ? booking.capacity : null;
}

export async function clearRoster(env, bookingId) {
  await env.DB.prepare('DELETE FROM booking_players WHERE booking_id = ?').bind(bookingId).run();
}

import { dataChatId } from './scope.js';
import { telegram } from './telegram.js';

export const DEFAULT_CAPACITY = 3;
export const MAX_CAPACITY = 12;
export class RosterCapacityError extends Error {}

const ADMIN_CACHE_TTL_MS = 3 * 60 * 1000;
const MAX_ADMIN_CACHE_ENTRIES = 512;
const adminCache = new Map();

// Telegram is authoritative, but admin checks sit in front of nearly every
// management panel. A short cache removes a network round trip while keeping a
// role change bounded.
export function clearAdminCache() {
  adminCache.clear();
}

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

// Usernames are mutable and may be reassigned by Telegram. Once a stored row
// carries a numeric id, only that id proves ownership; matching the current
// username as well would let the next holder of an old handle inherit a roster.
// A slug is used only for legacy/config-seeded rows which have never been tied
// to an account.
export function matchesPlayer(player, from) {
  if (!player || !from) return false;
  const who = identity(from);
  if (player.user_id) {
    return Boolean(who.userId && Number(player.user_id) === Number(who.userId));
  }
  return player.slug === who.slug;
}

// Accepts "@username", a numeric id, "id:Name", or a bare name.
function parsePlayer(entry) {
  const raw = String(entry).trim();
  if (raw.startsWith('@')) return identity({ username: raw });
  if (/^\d+$/.test(raw)) return identity({ id: Number(raw) });
  const separator = raw.indexOf(':');
  if (separator !== -1 && /^\d+$/.test(raw.slice(0, separator).trim())) {
    const userId = Number(raw.slice(0, separator).trim());
    const label = raw.slice(separator + 1).trim();
    // `id:@handle` carries both halves of the same Telegram identity. Keep the
    // handle as the slug used by live Telegram updates and retain the numeric
    // id as the authoritative ownership check. A plain `id:Name` remains the
    // legacy no-username form below.
    if (label.startsWith('@')) return identity({ id: userId, username: label });
    return identity({
      id: userId,
      first_name: label || 'Player',
    });
  }
  return identity({ first_name: raw });
}

// OWNER names the organiser the way the group does, by handle. A handle is
// mutable and can be claimed by somebody else once it is given up, so
// OWNER_USER_ID pins that name to the one account: set both and the identity
// keeps its slug but carries the id too, which is what survives a rename.
// OWNER_USER_ID alone is still read as OWNER, the older spelling.
export function ownerIdentity(env) {
  const raw = String((env && (env.OWNER || env.OWNER_USER_ID)) || '').trim();
  if (!raw) return null;
  const owner = parsePlayer(raw);
  // A bare id or "id:Name" already carries its own id; nothing to pin.
  if (owner.userId) return owner;
  const pinned = Number(String((env && env.OWNER_USER_ID) || '').trim());
  return Number.isFinite(pinned) && pinned > 0 ? { ...owner, userId: pinned } : owner;
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

// The same set read by numeric id, for whoever in config carries one.
function householdUserIds(env) {
  const ids = new Set();
  for (const player of [ownerIdentity(env), ...defaultPlayers(env), ...unbilledPlayers(env)]) {
    if (player && player.userId) ids.add(Number(player.userId));
  }
  return ids;
}

// Whether a roster row is one of the free players. The slug is the usual
// answer, but a slug is a username and a username can change: rememberPlayer
// re-keys that person's rows onto the new handle, and matching on the slug
// alone would start billing the organiser for their own courts. The numeric id
// is the second answer, and the one that cannot be taken over.
export function isHouseholdPlayer(env, player) {
  if (!player) return false;
  if (householdSlugs(env).has(player.slug)) return true;
  // Roster rows spell it user_id, config identities spell it userId.
  const userId = Number(player.user_id || player.userId);
  return Number.isFinite(userId) && userId > 0 && householdUserIds(env).has(userId);
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
  // Once OWNER_USER_ID pins the organiser to an account, the handle stops
  // counting: a username can be given up and claimed by somebody else, and
  // matching on it would hand that person admin. Without the id, the handle
  // is all there is to go on. Two missing ids are never a match.
  if (owner && (owner.userId
    ? owner.userId === who.userId
    : owner.slug === who.slug)) return true;
  const key = `${chatId}:${from.id}`;
  const now = Date.now();
  const cached = adminCache.get(key);
  if (cached && cached.expiresAt > now) return cached.isAdmin;
  if (cached) adminCache.delete(key);
  const member = await telegram(env, 'getChatMember', { chat_id: chatId, user_id: from.id });
  if (!member.ok) return false;
  const isAdmin = member.result.status === 'creator' || member.result.status === 'administrator';
  adminCache.set(key, { isAdmin, expiresAt: now + ADMIN_CACHE_TTL_MS });
  // The bot serves a bounded set of groups, but pruning keeps a busy public
  // group from turning an optimisation into unbounded isolate memory.
  if (adminCache.size > MAX_ADMIN_CACHE_ENTRIES) {
    for (const [entryKey, entry] of adminCache) {
      if (entry.expiresAt <= now || adminCache.size > MAX_ADMIN_CACHE_ENTRIES) {
        adminCache.delete(entryKey);
      }
    }
  }
  return isAdmin;
}

// Fills in the numeric id of a player who was seeded from config by username,
// and keeps that id pointing at one player. Without the id that player can never
// be sent a reminder.
export async function rememberPlayer(env, from) {
  const who = identity(from);
  if (!who.userId || !who.username) return;
  const statements = [env.DB.prepare(
    'UPDATE booking_players SET user_id = ? WHERE slug = ? AND user_id IS NULL'
  ).bind(who.userId, who.slug),
  // Someone can set or change their username long after they were first seated,
  // and config can name them by bare id, so the same human ends up spelled two
  // ways. The numeric id is what proves the two spellings are one person: their
  // old rows move onto the slug they key as now, because otherwise they are
  // offered Join for a court they are already on, take a second seat on it, and
  // are billed twice for the one game.
  //
  // Both spellings can already sit on one booking, where UNIQUE
  // (booking_id, slug) leaves no room to move the old row in: the delete
  // drops the old one first so the merge is one row, not a constraint
  // failure. Only a row that is *theirs* under the new slug counts — the
  // first statement has just claimed any provisional one — because a handle
  // can change hands, and the previous holder's seat under it must neither
  // cost this person their own seat nor be merged into it. Where somebody
  // else holds the slug, their old-slug row is left exactly as it was:
  // matchesPlayer follows the numeric id, so it still finds them.
  env.DB.prepare(
    `DELETE FROM booking_players
      WHERE user_id = ? AND slug != ?
        AND booking_id IN (
          SELECT booking_id FROM booking_players WHERE slug = ? AND user_id = ?
        )`
  ).bind(who.userId, who.slug, who.slug, who.userId),
  env.DB.prepare(
    `UPDATE booking_players SET slug = ?, name = ?
      WHERE user_id = ? AND slug != ?
        AND booking_id NOT IN (SELECT booking_id FROM booking_players WHERE slug = ?)`
  ).bind(who.slug, who.name, who.userId, who.slug, who.slug)];
  // These statements depend on their order, but D1 can execute the batch in
  // one trip. The fallback keeps lightweight test doubles and local adapters
  // useful without weakening the production path.
  if (typeof env.DB.batch === 'function') {
    await env.DB.batch(statements);
    return;
  }
  for (const statement of statements) await statement.run();
}

async function addPlayer(env, chatId, bookingId, player, addedByUserId) {
  return env.DB.prepare(
    `INSERT OR IGNORE INTO booking_players
      (booking_id, chat_id, user_id, slug, name, added_by_user_id, heads, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    bookingId, chatId, player.userId || null, player.slug, player.name,
    addedByUserId || null, player.heads || 1, Date.now()
  ).run();
}

// Every booking starts with whoever booked it plus the organiser's household.
// The booker is seated first because the slice below drops whoever does not fit,
// and the one person who must never lose their seat is the one who made the
// booking. chatId is the real chat the booking was made in, which is where those
// players are reachable for reminders.
export async function seedRoster(env, chatId, bookingId, from, capacity, bookedFor = null, companions = {}) {
  const seats = [];
  const seat = (player) => {
    if (player && !seats.some((seated) =>
      seated.slug === player.slug ||
      (seated.userId && player.userId && Number(seated.userId) === Number(player.userId))
    )) seats.push(player);
  };
  // Booked on behalf, the named booker takes the booker's seat — they may
  // carry no numeric id yet, exactly like a config-seeded player.
  const booker = bookedFor || (from && from.id ? identity(from) : null);
  if (booker) seat(booker);
  if (companions.plusOne && from?.id) {
    const actor = identity(from);
    seat(actor);
    const seated = seats.find(p => p.slug === actor.slug || p.userId === actor.userId);
    seated.heads = 2;
  }
  for (const player of companions.players || []) seat(player);
  if (seats.reduce((sum, player) => sum + (player.heads || 1), 0) > capacity) {
    throw new RosterCapacityError('The requested players and guest exceed the court capacity. Start /book again with fewer players.');
  }
  seat(ownerIdentity(env));
  for (const player of defaultPlayers(env)) seat(player);
  let remaining = capacity;
  for (const player of seats) {
    const heads = player.heads || 1;
    if (heads > remaining) continue;
    await addPlayer(env, chatId, bookingId, player, from && from.id);
    remaining -= heads;
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

// A booking that is still live: not yet ended, scoped to this chat's data.
// Exported because every panel and admin action starts with this exact read.
// Joining and leaving both close when the court starts, so nobody can play a
// full hour and then drop off the roster to dodge their share.
export async function openBooking(env, chatId, bookingId) {
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
  // Heads rather than rows, because a row an admin seated with a friend on it
  // holds two of the court's slots. Joining yourself only ever takes one.
  const joined = await env.DB.prepare(
    `INSERT OR IGNORE INTO booking_players
      (booking_id, chat_id, user_id, slug, name, added_by_user_id, heads, created_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?
     WHERE (
       SELECT COALESCE(SUM(heads), 0) FROM booking_players WHERE booking_id = ?
     ) < ?`
  ).bind(
    bookingId, chatId, who.userId, who.slug, who.name, who.userId, 1, Date.now(),
    bookingId, capacity
  ).run();
  if (joined.meta.changes) return { status: 'joined', booking };
  const existing = await env.DB.prepare(
    'SELECT id, slug, user_id FROM booking_players WHERE booking_id = ? AND slug = ?'
  ).bind(bookingId, who.slug).first();
  return {
    status: existing
      ? (matchesPlayer(existing, from) ? 'already' : 'identity-conflict')
      : 'full',
    booking,
  };
}

// One shared button per court, doing opposite things to the two kinds of person
// who can tap it. Which one you are is read at the moment of the tap.
export async function toggleBooking(env, chatId, bookingId, from) {
  const booking = await openBooking(env, chatId, bookingId);
  if (!booking) return { status: 'gone', left: false };
  const roster = await rosterFor(env, bookingId);
  const onIt = roster.some((player) => matchesPlayer(player, from));
  return onIt
    ? leaveBooking(env, chatId, bookingId, from)
    : joinBooking(env, chatId, bookingId, from);
}

export async function leaveBooking(env, chatId, bookingId, from) {
  const booking = await openBooking(env, chatId, bookingId);
  if (!booking) return { status: 'gone' };
  if (booking.starts_at <= Date.now()) return { status: 'started', booking };
  const removed = await env.DB.prepare(
    `DELETE FROM booking_players
     WHERE booking_id = ? AND (
       (user_id IS NULL AND slug = ?) OR user_id = ?
     )`
  ).bind(bookingId, identity(from).slug, from && from.id || 0).run();
  return { status: removed.meta.changes ? 'left' : 'absent', booking };
}

// Admins can take someone off a roster right up to the end of the slot, which is
// also how a no-show is kept off the tab: charging happens once the court
// expires, using whoever is still on the roster then.
export async function removeBookingPlayer(env, chatId, bookingId, playerRowId) {
  const booking = await openBooking(env, chatId, bookingId);
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

// Everyone the bot can put a name to: the config household, everyone the
// ledger has ever charged, and whoever is seated on a current booking.
// Expired rosters are deleted with their bookings, so the ledger is the long
// memory here. Somebody the bot has never seen can always tap Join themselves.
export async function knownPlayers(env, chatId) {
  const players = new Map();
  const remember = (slug, name, userId) => {
    if (!slug) return;
    const existing = players.get(slug);
    if (!existing) {
      players.set(slug, { slug, name: name || slug, user_id: userId || null });
    } else if (!existing.user_id && userId) {
      existing.user_id = userId;
    }
  };
  for (const player of [ownerIdentity(env), ...defaultPlayers(env), ...unbilledPlayers(env)]) {
    if (player) remember(player.slug, player.name, player.userId);
  }
  const dataChat = dataChatId(env, chatId);
  // Grouped rather than scanned: the ledger is append-only and grows forever,
  // and this sits on the hot path of every admin panel. The name subquery
  // keeps the latest spelling, the same rule the pinned tab uses.
  const { results: charged } = await env.DB.prepare(
    `SELECT l.slug AS slug, MAX(l.user_id) AS user_id,
            (SELECT name FROM ledger
              WHERE chat_id = l.chat_id AND slug = l.slug
              ORDER BY created_at DESC, id DESC LIMIT 1) AS name
     FROM ledger AS l WHERE l.chat_id = ? GROUP BY l.slug ORDER BY l.slug`
  ).bind(dataChat).all();
  for (const row of charged) remember(row.slug, row.name, row.user_id);
  const { results: seated } = await env.DB.prepare(
    `SELECT slug, name, user_id FROM booking_players
     WHERE booking_id IN (SELECT id FROM bookings WHERE chat_id = ?) ORDER BY id`
  ).bind(dataChat).all();
  for (const row of seated) remember(row.slug, row.name, row.user_id);
  return [...players.values()];
}

// An admin seating somebody. The count check lives inside the insert exactly
// as joinBooking's does, so this cannot squeeze past capacity — opening a slot
// stays an explicit admin decision. Like the other admin actions it stays open
// until the court ends: seating somebody who actually played is how their
// share reaches the tab.
//
// heads is 2 when they are seated with a friend, which is the only way a roster
// row ever stands for two people: the friend has no Telegram identity to key a
// row on, so the member holds both slots and is billed for both. Two free heads
// are needed for that, and one short is refused rather than rounded down.
export async function adminAddPlayer(env, chatId, bookingId, player, addedByUserId, heads = 1) {
  const booking = await openBooking(env, chatId, bookingId);
  if (!booking) return { status: 'gone' };
  const capacity = booking.capacity || DEFAULT_CAPACITY;
  const added = await env.DB.prepare(
    `INSERT OR IGNORE INTO booking_players
      (booking_id, chat_id, user_id, slug, name, added_by_user_id, heads, created_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?
     -- The same person under another key (their @handle, or their numeric
     -- account) may already be on the court, and a second seat would split
     -- the court over a head that never played.
     WHERE NOT EXISTS (
       SELECT 1 FROM booking_players WHERE booking_id = ? AND user_id = ?
     )
     AND (
       SELECT COALESCE(SUM(heads), 0) FROM booking_players WHERE booking_id = ?
     ) <= ?`
  ).bind(
    bookingId, chatId, player.user_id || null, player.slug, player.name,
    addedByUserId || null, heads, Date.now(),
    bookingId, player.user_id || null, bookingId, capacity - heads
  ).run();
  if (added.meta.changes) return { status: 'added', booking };
  const existing = await env.DB.prepare(
    'SELECT id FROM booking_players WHERE booking_id = ? AND (slug = ? OR user_id = ?)'
  ).bind(bookingId, player.slug, player.user_id || null).first();
  return { status: existing ? 'already' : 'full', booking };
}

// Flips an existing member between one head and two. Granting the +1 checks
// capacity inside the update, the same race-proof shape as the inserts;
// taking it back always succeeds, since it only frees a slot. Charging reads
// heads when the court expires, so flipping any time before then is enough.
export async function togglePlusOne(env, chatId, bookingId, playerRowId) {
  const booking = await openBooking(env, chatId, bookingId);
  if (!booking) return { status: 'gone' };
  const player = await env.DB.prepare(
    'SELECT * FROM booking_players WHERE id = ? AND booking_id = ?'
  ).bind(playerRowId, bookingId).first();
  if (!player) return { status: 'gone' };
  if ((player.heads || 1) > 1) {
    await env.DB.prepare('UPDATE booking_players SET heads = 1 WHERE id = ?')
      .bind(playerRowId).run();
    return { status: 'minus', booking, player };
  }
  const capacity = booking.capacity || DEFAULT_CAPACITY;
  const bumped = await env.DB.prepare(
    `UPDATE booking_players SET heads = 2
     WHERE id = ? AND heads = 1
       AND (SELECT COALESCE(SUM(heads), 0) FROM booking_players WHERE booking_id = ?) < ?`
  ).bind(playerRowId, bookingId, capacity).run();
  return bumped.meta.changes
    ? { status: 'plus', booking, player }
    : { status: 'full', booking };
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

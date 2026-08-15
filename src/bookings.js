import {
  clearRoster, defaultCapacity, DEFAULT_CAPACITY, identity, isChatAdmin, MAX_CAPACITY,
  rosterFor, rostersFor, seedRoster,
} from './players.js';
import { allowedChats, boardChats, dataChatId, reachableChat, sharingData } from './scope.js';
import { getTimezone, updatePinnedMessage } from './settings.js';
import { chargeBooking, updateTab } from './tab.js';
import { formatDate, formatTime, localParts, zonedEpoch } from './time.js';
import {
  deleteEphemeralMessage, deleteMessage, editReplyMarkup, escapeHtml, mentionHtml,
  sendMessage,
} from './telegram.js';

export { getTimezone };

function actorName(from) {
  return from ? identity(from).name : null;
}

function bookingSnapshot(booking) {
  return {
    court: String(booking.court),
    startsAt: booking.startsAt ?? booking.starts_at,
    endsAt: booking.endsAt ?? booking.ends_at,
    reminderAt: booking.reminderAt ?? booking.reminder_at,
    // Without it the trail cannot answer what the person originally asked for.
    sourceText: booking.sourceText ?? booking.source_text ?? null,
  };
}

async function recordAudit(
  env, bookingId, chatId, action, from, sourceText, before = null, after = null
) {
  await env.DB.prepare(
    `INSERT INTO booking_audit
      (booking_id, chat_id, action, actor_user_id, actor_name, source_text,
       before_json, after_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    bookingId, dataChatId(env, chatId), action, from && from.id || null, actorName(from),
    sourceText || null, before ? JSON.stringify(bookingSnapshot(before)) : null,
    after ? JSON.stringify(bookingSnapshot(after)) : null, Date.now()
  ).run();
}

export class BookingConflictError extends Error {
  constructor(conflicts) {
    super('That court overlaps an existing booking.');
    this.conflicts = conflicts;
  }
}

export async function findBookingConflicts(
  env, chatId, booking, excludeBookingId = null
) {
  const query = excludeBookingId == null
    ? `SELECT id, court, starts_at, ends_at FROM bookings
       WHERE chat_id = ? AND LOWER(TRIM(court)) = LOWER(TRIM(?))
         AND starts_at < ? AND ends_at > ?
       ORDER BY starts_at`
    : `SELECT id, court, starts_at, ends_at FROM bookings
       WHERE chat_id = ? AND LOWER(TRIM(court)) = LOWER(TRIM(?))
         AND starts_at < ? AND ends_at > ? AND id != ?
       ORDER BY starts_at`;
  const args = [dataChatId(env, chatId), String(booking.court), booking.endsAt, booking.startsAt];
  if (excludeBookingId != null) args.push(excludeBookingId);
  return (await env.DB.prepare(query).bind(...args).all()).results;
}

// Nothing about a booking is posted to the group. The person who booked gets a
// private receipt they can dismiss, and the pinned board carries the news.
async function confirmToBooker(env, chatId, bookingId, booking, capacity, from, callbackQueryId) {
  if (!from || !from.id) return;
  const tz = await getTimezone(env, chatId);
  const startsAt = booking.startsAt ?? booking.starts_at;
  const endsAt = booking.endsAt ?? booking.ends_at;
  const court = booking.court.startsWith('Court ') ? booking.court : `Court ${booking.court}`;
  const roster = await rosterFor(env, bookingId);
  // If OK is never tapped it still clears itself at the end of the day, and a
  // receipt Telegram could not keep private is removed rather than left up.
  await sendPrivately(env, chatId,
    `🎾 <b>${escapeHtml(court)} booked</b>\n` +
    `${formatDate(startsAt, tz)} · ${compactTimeRange(startsAt, endsAt, tz)}\n` +
    `👥 ${playerTags(roster)} · ${slotsLabel(roster, capacity)}`,
    from.id, endOfLocalDay(startsAt, tz),
    {
      callbackQueryId,
      replyMarkup: { inline_keyboard: [[{ text: '👍 OK', callback_data: 'sb:ok' }]] },
    }
  );
}

export async function addBooking(
  env, chatId, parsed, from, sourceText = null,
  { allowConflict = false, callbackQueryId = null } = {}
) {
  const now = Date.now();
  const preReminderAt = parsed.startsAt - 2 * 60 * 60 * 1000;
  // A court booked inside its own reminder windows is not news to anyone, so
  // both flags start spent rather than firing on the next cron tick.
  const preReminderSent = preReminderAt <= now ? 1 : 0;
  const reminderSent = parsed.reminderAt <= now ? 1 : 0;
  const capacity = defaultCapacity(env);
  const result = await env.DB.prepare(
    `INSERT INTO bookings
      (chat_id, court, starts_at, ends_at, reminder_at, reminder_sent, pre_reminder_at,
       pre_reminder_sent, capacity, created_by_user_id, created_by_name, source_text, created_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
     WHERE ? = 1 OR NOT EXISTS (
       SELECT 1 FROM bookings
       WHERE chat_id = ? AND LOWER(TRIM(court)) = LOWER(TRIM(?))
         AND starts_at < ? AND ends_at > ?
     )`
  ).bind(
    dataChatId(env, chatId), parsed.court, parsed.startsAt, parsed.endsAt, parsed.reminderAt,
    reminderSent, preReminderAt, preReminderSent, capacity, from && from.id || null,
    actorName(from), sourceText, now, allowConflict ? 1 : 0,
    dataChatId(env, chatId), parsed.court, parsed.endsAt, parsed.startsAt
  ).run();
  if (!result.meta.changes) {
    throw new BookingConflictError(await findBookingConflicts(env, chatId, parsed));
  }
  const bookingId = result.meta.last_row_id;
  await recordAudit(env, bookingId, chatId, 'added', from, sourceText, null, parsed);
  await seedRoster(env, chatId, bookingId, from, capacity);
  await updateBoard(env, chatId);
  await confirmToBooker(env, chatId, bookingId, parsed, capacity, from, callbackQueryId);
  return bookingId;
}

export async function updateBooking(
  env, chatId, id, parsed, from, sourceText = null, { allowConflict = false } = {}
) {
  const before = await env.DB.prepare('SELECT * FROM bookings WHERE id = ? AND chat_id = ?')
    .bind(id, dataChatId(env, chatId)).first();
  if (!before) return false;
  const now = Date.now();
  const preReminderAt = parsed.startsAt - 2 * 60 * 60 * 1000;
  const result = await env.DB.prepare(
    `UPDATE bookings SET
       court = ?, starts_at = ?, ends_at = ?, reminder_at = ?,
       reminder_sent = ?, pre_reminder_at = ?, pre_reminder_sent = ?
     WHERE id = ? AND chat_id = ? AND (
       ? = 1 OR NOT EXISTS (
         SELECT 1 FROM bookings AS other
         WHERE other.chat_id = ?
           AND LOWER(TRIM(other.court)) = LOWER(TRIM(?))
           AND other.starts_at < ? AND other.ends_at > ? AND other.id != ?
       )
     )`
  ).bind(
    parsed.court, parsed.startsAt, parsed.endsAt, parsed.reminderAt,
    parsed.reminderAt <= now ? 1 : 0, preReminderAt,
    preReminderAt <= now ? 1 : 0, id, dataChatId(env, chatId), allowConflict ? 1 : 0,
    dataChatId(env, chatId), parsed.court, parsed.endsAt, parsed.startsAt, id
  ).run();
  if (!result.meta.changes) {
    const conflicts = await findBookingConflicts(env, chatId, parsed, id);
    if (conflicts.length) throw new BookingConflictError(conflicts);
    return false;
  }
  // The roster claims its own reminders, so a booking moved to another day has
  // to hand them back or everyone already told hears nothing about the new one.
  await env.DB.prepare(
    'UPDATE booking_players SET reminder_sent = ?, pre_reminder_sent = ? WHERE booking_id = ?'
  ).bind(parsed.reminderAt <= now ? 1 : 0, preReminderAt <= now ? 1 : 0, id).run();
  await recordAudit(env, id, chatId, 'edited', from, sourceText, before, parsed);
  await updateBoard(env, chatId);
  return true;
}

const BOOKING_GONE = 'That booking has already gone.';

// Booking ids are small sequential numbers, so without this any member could
// walk the whole group's history away. One rule for /cancel and for every button
// that edits or deletes: whoever booked the court, or a group admin. A refusal
// says nothing about the booking beyond who to ask. `from` is null only on the
// automatic expiry sweep, which answers to the clock rather than to a person.
export async function authorizeBookingChange(env, chatId, id, from, action = 'change') {
  const booking = await env.DB.prepare('SELECT * FROM bookings WHERE id = ? AND chat_id = ?')
    .bind(id, dataChatId(env, chatId)).first();
  if (!booking) return { allowed: false, status: 'gone', message: BOOKING_GONE, booking: null };
  if (!from) return { allowed: true, status: 'ok', message: '', booking };
  const booked = booking.created_by_user_id
    && Number(booking.created_by_user_id) === Number(from.id);
  if (booked || await isChatAdmin(env, chatId, from)) {
    return { allowed: true, status: 'ok', message: '', booking };
  }
  return {
    allowed: false,
    status: 'forbidden',
    message: `Only ${booking.created_by_name || 'whoever booked it'} or a group admin ` +
      `can ${action} that booking.`,
    booking: null,
  };
}

export async function cancelBooking(env, chatId, id, from = null, sourceText = null) {
  const permitted = await authorizeBookingChange(env, chatId, id, from, 'cancel');
  if (!permitted.allowed) return permitted;
  const booking = permitted.booking;
  // A court that has been played has to reach the tab, so only removeExpiredBookings
  // may take it away. Cancelling one by hand would erase the bill with it.
  if (from && booking.ends_at <= Date.now()) {
    return {
      allowed: false,
      status: 'played',
      message: 'That court has already been played, so it stays on the tab.',
      booking: null,
    };
  }
  const result = await env.DB.prepare('DELETE FROM bookings WHERE id = ? AND chat_id = ?')
    .bind(id, dataChatId(env, chatId)).run();
  if (!result.meta.changes) {
    return { allowed: false, status: 'gone', message: BOOKING_GONE, booking: null };
  }
  // A cancelled booking is never played, so it never reaches the tab.
  await clearRoster(env, id);
  await recordAudit(env, id, chatId, 'deleted', from, sourceText, booking, null);
  await updateBoard(env, chatId);
  return { allowed: true, status: 'cancelled', message: '', booking };
}

// "9pm", or "9:30pm" when there are minutes to show.
function shortClock(epochMs, tz) {
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
function compactTimeRange(startsAt, endsAt, tz) {
  const start = shortClock(startsAt, tz);
  if (endsAt - startsAt === ONE_HOUR_MS) return start;
  return `${start}–${shortClock(endsAt, tz)}`;
}

async function activeBookings(env, chatId, now = Date.now()) {
  return (await env.DB.prepare(
    'SELECT * FROM bookings WHERE chat_id = ? AND ends_at > ? ORDER BY starts_at, court, id'
  ).bind(dataChatId(env, chatId), now).all()).results;
}

// The private list is the fallback for everything the board's own buttons
// cannot reach, so it has to be the longer of the two. If it were the same
// length it would drop exactly the courts the board sends people here for.
const MAX_JOIN_BUTTONS = 12;

function courtName(booking) {
  return booking.court.startsWith('Court ') ? booking.court : `Court ${booking.court}`;
}

// The comma Intl puts after the weekday is dropped: these read alongside “·”
// separators, and on a phone every character counts against wrapping.
function shortDate(epochMs, tz) {
  return new Intl.DateTimeFormat('en-SG', {
    timeZone: tz, weekday: 'short', day: 'numeric', month: 'short',
  }).format(new Date(epochMs)).replace(',', '');
}

// A player whose numeric id is known gets a real tag. Anyone still seeded from
// config by username is written as plain @handle, which Telegram links and
// notifies by itself; their id is filled in the first time they post.
function playerTags(roster) {
  if (!roster.length) return 'nobody yet';
  return roster.map((player) => (player.user_id
    ? mentionHtml(player.user_id, player.name)
    : escapeHtml(player.name))).join(', ');
}

// The board stays about who is playing. Money lives on the tab.
// What people actually want to know is whether there is room, not the ratio.
function slotsLabel(roster, capacity) {
  const free = Math.max(0, capacity - roster.length);
  if (!free) return 'full';
  return `${free} slot${free === 1 ? '' : 's'}`;
}

// One row, whatever the board holds. Which court you want is asked behind 🙋
// Join, where the list is private and can offer Join or Leave per court — a row
// per booking made the pinned message noisy and still could not say which.
// One button. Everything else — adding, managing, and the fuller picture an
// admin needs — lives behind it, in a panel that is private and so can differ
// per person, which a keyboard on a shared pinned message never can.
function boardButtons(bookings) {
  if (!bookings.length) return { inline_keyboard: [] };
  return { inline_keyboard: [[{ text: '🙋 Join', callback_data: 'sb:join' }]] };
}

// The court list is built per person and sent only to them, so it can offer
// Join for courts they are not on and Leave for the ones they are. A shared
// keyboard on the pinned board could never tell the two apart.
export async function joinPickerView(env, chatId, from, isAdmin = false, now = Date.now()) {
  const bookings = (await activeBookings(env, chatId, now))
    .filter((booking) => booking.starts_at > now);
  if (!bookings.length) return null;
  const tz = await getTimezone(env, chatId);
  const rosters = await rostersFor(env, chatId, bookings.map((booking) => booking.id));
  const mySlug = identity(from).slug;

  const rows = [];
  // Every court the board lists appears here too, full ones marked rather than
  // hidden: a court you can see pinned and then cannot find in this list reads
  // as a bug, and the board no longer keeps full courts back.
  for (const booking of bookings.slice(0, MAX_JOIN_BUTTONS)) {
    const roster = rosters.get(booking.id) || [];
    const capacity = booking.capacity || DEFAULT_CAPACITY;
    const label = `${shortDate(booking.starts_at, tz)} · ` +
      `${compactTimeRange(booking.starts_at, booking.ends_at, tz)} · ` +
      `${courtName(booking)} · ${slotsLabel(roster, capacity)}`;
    if (roster.some((player) => player.slug === mySlug)) {
      rows.push([{ text: `🚪 Leave · ${label}`, callback_data: `sb:leave:${booking.id}` }]);
    } else if (roster.length < capacity) {
      rows.push([{ text: `🙋 Join · ${label}`, callback_data: `sb:join:${booking.id}` }]);
    } else {
      rows.push([{ text: `🔒 Full · ${label}`, callback_data: `sb:full:${booking.id}` }]);
    }
  }
  // The board carries a single Join button, so this panel is the only way in.
  // Being private, it can hold what only an admin should act on — and name the
  // rosters, which the shared board deliberately does not.
  if (isAdmin) {
    rows.push([{ text: '⚙️ Manage bookings', callback_data: 'sb:manage' }]);
  }
  rows.push([{ text: '➕ Add booking', callback_data: 'sb:add' }]);
  rows.push([{ text: '✕ Close', callback_data: 'sb:close' }]);

  const lines = ['🎾 <b>Courts you can join</b>', '', 'Only you can see this list.'];
  const dropped = bookings.length - Math.min(bookings.length, MAX_JOIN_BUTTONS);
  // Never claim to be the complete list when it is not.
  if (dropped) lines.push(`${dropped} further court${dropped === 1 ? '' : 's'} not shown.`);
  if (isAdmin) {
    for (const booking of bookings.slice(0, MAX_JOIN_BUTTONS)) {
      const roster = rosters.get(booking.id) || [];
      lines.push('');
      lines.push(`${shortDate(booking.starts_at, tz)} · ` +
        `${shortClock(booking.starts_at, tz)} · <b>${escapeHtml(courtName(booking))}</b>`);
      lines.push(`👥 ${playerTags(roster)}`);
    }
  }
  return {
    html: lines.join('\n'),
    replyMarkup: { inline_keyboard: rows },
  };
}

async function renderBoard(env, chatId, now) {
  const tz = await getTimezone(env, chatId);
  const bookings = await activeBookings(env, chatId, now);
  if (!bookings.length) return { html: null, replyMarkup: null };
  const rosters = await rostersFor(env, chatId, bookings.map((booking) => booking.id));

  // Two short lines and a gap per booking. A phone wraps anything much past
  // thirty characters, and a wrapped “Court 4” or “1 slot” is what made the
  // board read as a wall. The roster is dropped because DEFAULT_PLAYERS puts
  // the same handles on every row; who is playing lives behind 🙋 Join, which
  // can answer it per person as the shared board never could.
  // Every court is listed, full ones included: the board is the answer to "what
  // is booked", and a court missing from it reads as a court nobody took. The
  // slot count carries the difference.
  const lines = ['🎾 <b>Upcoming squash courts</b>'];
  for (const booking of bookings) {
    const roster = rosters.get(booking.id) || [];
    lines.push('');
    lines.push(formatCountdown(booking.starts_at, tz, now));
    lines.push(
      `${compactTimeRange(booking.starts_at, booking.ends_at, tz)} · ` +
      `<b>${escapeHtml(courtName(booking))}</b> · ` +
      `${slotsLabel(roster, booking.capacity || DEFAULT_CAPACITY)}`
    );
  }
  return {
    html: lines.join('\n'),
    replyMarkup: boardButtons(bookings),
  };
}

export async function boardHtml(env, chatId, now = Date.now()) {
  return (await renderBoard(env, chatId, now)).html;
}

// Every group sharing these bookings gets the same pinned board.
export async function updateBoard(env, chatId, now = Date.now()) {
  const board = await renderBoard(env, chatId, now);
  for (const chat of boardChats(env, chatId)) {
    await updatePinnedMessage(
      env, chat, 'board_message_id', board.html, board.replyMarkup, 'court board'
    );
  }
}

function bookingLabel(booking, tz) {
  return `${courtName(booking)} · ${shortDate(booking.starts_at, tz)} · ${formatTime(booking.starts_at, tz)}`;
}

// Manage used to redraw the pinned message's keyboard, one shared surface that
// any tap republished to the group. It is a private panel now. It lists every
// active court, matching the board — hiding full ones here would protect
// nothing the board does not already show, and would leave a booked-out court
// with no way to edit or delete it.
const MANAGER_HEADER = '⚙️ <b>Manage bookings</b>\n\nOnly you can see this list.';

export async function managerView(env, chatId, now = Date.now()) {
  const bookings = await activeBookings(env, chatId, now);
  const tz = await getTimezone(env, chatId);
  const rows = bookings.map((booking) => [{
    text: `✏️ ${bookingLabel(booking, tz)}`,
    callback_data: `sb:pick:${booking.id}`,
  }]);
  rows.push([{ text: '➕ Add booking', callback_data: 'sb:add' }]);
  rows.push([{ text: '✕ Close', callback_data: 'sb:close' }]);
  return {
    html: bookings.length ? MANAGER_HEADER
      : `${MANAGER_HEADER}\n\nNothing booked yet.`,
    replyMarkup: { inline_keyboard: rows },
  };
}

export async function bookingPanelView(env, chatId, bookingId) {
  const booking = await env.DB.prepare(
    'SELECT * FROM bookings WHERE id = ? AND chat_id = ? AND ends_at > ?'
  ).bind(bookingId, dataChatId(env, chatId), Date.now()).first();
  if (!booking) return null;
  const tz = await getTimezone(env, chatId);
  const capacity = booking.capacity || DEFAULT_CAPACITY;
  const rows = [
    [{ text: `✏️ ${bookingLabel(booking, tz)}`, callback_data: `sb:pick:${booking.id}` }],
    [
      { text: '📅 Change date', callback_data: `sb:edit:${booking.id}:d` },
      { text: '🔢 Change court', callback_data: `sb:edit:${booking.id}:c` },
    ],
    [{ text: '🕐 Change time', callback_data: `sb:edit:${booking.id}:t` }],
  ];
  if (capacity < MAX_CAPACITY) {
    rows.push([{
      text: `👥 Admin: room for ${capacity + 1}`, callback_data: `sb:cap:${booking.id}`,
    }]);
  }
  const roster = await rosterFor(env, booking.id);
  if (roster.length) {
    rows.push([{
      text: '🚪 Admin: remove a player', callback_data: `sb:kick:${booking.id}`,
    }]);
  }
  rows.push([{ text: '🗑 Delete booking', callback_data: `sb:delete:${booking.id}` }]);
  rows.push([{ text: '← Back to bookings', callback_data: 'sb:manage' }]);
  // The board cannot name the roster without repeating the same handles on
  // every row, but this panel is private and about one court, so it is the
  // place to answer who is playing.
  return {
    html: `⚙️ <b>${escapeHtml(bookingLabel(booking, tz))}</b>\n`
      + `👥 ${playerTags(roster)} · ${slotsLabel(roster, capacity)}\n\n`
      + 'Only you can see this.',
    replyMarkup: { inline_keyboard: rows },
  };
}

export async function removePlayerView(env, chatId, bookingId) {
  const booking = await env.DB.prepare(
    'SELECT * FROM bookings WHERE id = ? AND chat_id = ? AND ends_at > ?'
  ).bind(bookingId, dataChatId(env, chatId), Date.now()).first();
  if (!booking) return null;
  const roster = await rosterFor(env, bookingId);
  if (!roster.length) return null;
  const tz = await getTimezone(env, chatId);
  const rows = roster.map((player) => [{
    text: `🚪 ${player.name}`,
    callback_data: `sb:kick:${bookingId}:${player.id}`,
  }]);
  rows.push([{ text: '← Back', callback_data: `sb:pick:${bookingId}` }]);
  return {
    html: `🚪 <b>Take somebody off ${escapeHtml(bookingLabel(booking, tz))}</b>`,
    replyMarkup: { inline_keyboard: rows },
  };
}

// The person taken off is told privately. Nobody else needs the notification.
export async function notifyRemovedPlayer(env, chatId, player, booking) {
  if (!player.user_id) return;
  const tz = await getTimezone(env, chatId);
  await sendPrivately(env, reachableChat(env, player, chatId),
    `🚪 You were taken off <b>${escapeHtml(courtName(booking))}</b> on ` +
    `${formatDate(booking.starts_at, tz)} · ${formatTime(booking.starts_at, tz)}.\n` +
    'Tap the 🙋 button on the pinned board if that was a mistake.',
    player.user_id, endOfLocalDay(booking.starts_at, tz));
}

// The board no longer names who is on a court, so the people already on it are
// told directly when somebody takes a slot. Each is messaged privately; the
// joiner is skipped, and so is anyone whose numeric id is not known yet.
export async function notifyRosterOfJoin(env, chatId, booking, from) {
  const tz = await getTimezone(env, chatId);
  const roster = await rosterFor(env, booking.id);
  const joined = identity(from);
  const html = `🙋 <b>${escapeHtml(joined.name)}</b> joined ` +
    `${escapeHtml(courtName(booking))}\n` +
    `${shortDate(booking.starts_at, tz)} · ` +
    `${compactTimeRange(booking.starts_at, booking.ends_at, tz)} · ` +
    `${slotsLabel(roster, booking.capacity || DEFAULT_CAPACITY)}`;
  // By id, not by slug: one person can briefly hold two roster rows while their
  // username is still being merged, and two copies of this would be a bug.
  const told = new Set([from && from.id]);
  for (const player of roster) {
    if (!player.user_id || player.slug === joined.slug || told.has(player.user_id)) continue;
    told.add(player.user_id);
    await sendPrivately(env, reachableChat(env, player, chatId), html,
      player.user_id, endOfLocalDay(booking.starts_at, tz));
  }
}

export async function deletePanelView(env, chatId, bookingId) {
  const booking = await env.DB.prepare(
    'SELECT * FROM bookings WHERE id = ? AND chat_id = ? AND ends_at > ?'
  ).bind(bookingId, dataChatId(env, chatId), Date.now()).first();
  if (!booking) return null;
  const tz = await getTimezone(env, chatId);
  return {
    html: `🗑 <b>Delete ${escapeHtml(bookingLabel(booking, tz))}?</b>`,
    replyMarkup: { inline_keyboard: [
      [{ text: '🗑 Confirm delete', callback_data: `sb:cancel:${booking.id}` }],
      [{ text: '← Keep booking', callback_data: `sb:pick:${booking.id}` }],
    ] },
  };
}

export async function restoreBoardButtons(env, chatId, messageId, now = Date.now()) {
  const bookings = await activeBookings(env, chatId, now);
  return editReplyMarkup(env, chatId, messageId, boardButtons(bookings));
}

function reminderHtml(booking, roster, headline, tz) {
  return `🎾 <b>${escapeHtml(headline)}</b>\n` +
    `${escapeHtml(courtName(booking))} · ${formatDate(booking.starts_at, tz)} · ` +
    `${compactTimeRange(booking.starts_at, booking.ends_at, tz)}` +
    (roster.length ? `\n👥 ${playerTags(roster)}` : '');
}

// A reminder is only useful on the day it is about, so it is queued for removal
// at the end of that local day rather than left in the chat.
function endOfLocalDay(epochMs, tz) {
  const parts = localParts(epochMs, tz);
  const next = new Date(Date.UTC(parts.y, parts.mo - 1, parts.d + 1));
  return zonedEpoch(
    next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, 0, tz
  );
}

async function scheduleCleanup(env, chatId, sent, receiverUserId, deleteAfter) {
  const messageId = sent.ephemeral_message_id || sent.message_id;
  if (!messageId) return;
  await env.DB.prepare(
    `INSERT INTO sent_messages
      (chat_id, receiver_user_id, message_id, is_ephemeral, delete_after, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(
    chatId, receiverUserId || null, messageId,
    sent.ephemeral_message_id ? 1 : 0, deleteAfter, Date.now()
  ).run();
}

// Telegram falls back to an ordinary group message when it cannot deliver an
// ephemeral one. Anything addressed to one person — a receipt with the roster on
// it, a reminder, a removal notice — would then sit in the group instead, so the
// public copy is deleted and the caller decides what to do about the failure.
async function sendPrivately(env, chatId, html, userId, deleteAfter, options = {}) {
  const sent = await sendMessage(env, chatId, html, { ...options, receiverUserId: userId });
  if (!sent.ok) return 'failed';
  if (sent.result && sent.result.ephemeral_message_id) {
    await scheduleCleanup(env, chatId, sent.result, userId, deleteAfter);
    return 'private';
  }
  if (sent.result && sent.result.message_id) {
    await deleteMessage(env, chatId, sent.result.message_id);
  }
  return 'not-ephemeral';
}

async function remindPublicly(env, booking, roster, headline, tz) {
  // The roster line already tags everyone, so this needs nothing extra — and it
  // goes out silently, because the one message the group cannot avoid seeing
  // should not also buzz every phone in it.
  const sent = await sendMessage(env, booking.chat_id,
    reminderHtml(booking, roster, headline, tz), { silent: true });
  if (sent.ok && sent.result) {
    await scheduleCleanup(
      env, booking.chat_id, sent.result, null, endOfLocalDay(booking.starts_at, tz)
    );
  }
  return sent.ok;
}

// Maintenance has no incoming update to tell it which chat it is running for, so
// each sweep is scoped the way handleUpdate is. Sharing mode files rows under
// DATA_CHAT_ID, which need not be one of the allowed chats itself. With
// ALLOWED_CHATS unset the sweep stays unscoped, as it has always been.
function maintenanceChats(env) {
  const allowed = allowedChats(env);
  if (!allowed.length) return null;
  const shared = sharingData(env);
  return shared ? [...new Set([shared, ...allowed])] : allowed;
}

function chatScope(env, column) {
  const chats = maintenanceChats(env);
  if (!chats) return { sql: '', args: [] };
  return { sql: ` AND ${column} IN (${chats.map(() => '?').join(', ')})`, args: chats };
}

async function purgeFinishedMessages(env, now) {
  const scope = chatScope(env, 'chat_id');
  const { results } = await env.DB.prepare(
    `SELECT * FROM sent_messages WHERE delete_after <= ?${scope.sql}
     ORDER BY delete_after LIMIT 100`
  ).bind(now, ...scope.args).all();
  for (const row of results) {
    try {
      if (row.is_ephemeral) {
        await deleteEphemeralMessage(env, row.chat_id, row.receiver_user_id, row.message_id);
      } else {
        await deleteMessage(env, row.chat_id, row.message_id);
      }
      // Telegram refuses to delete a message that is already gone, which is the
      // same outcome, so the row goes either way.
      await env.DB.prepare('DELETE FROM sent_messages WHERE id = ?').bind(row.id).run();
    } catch (error) {
      console.log(`Reminder cleanup ${row.id} failed: ${error.stack || error}`);
    }
  }
}

// One claim per player, so someone who joins after the first reminder has gone
// out still gets their own, and a failed send is retried only for that person.
async function sendClaimedReminders(env, now, column, headline) {
  const scope = chatScope(env, 'b.chat_id');
  // Rosters are seeded with their flags unspent, so the booking-level flag is
  // what suppresses a reminder for a court booked inside its own window.
  const { results } = await env.DB.prepare(
    `SELECT p.id AS player_row_id, p.user_id AS player_user_id, p.chat_id AS player_chat_id,
            b.*
     FROM booking_players AS p
     JOIN bookings AS b ON b.id = p.booking_id
     WHERE p.${column}_sent = 0 AND b.${column}_sent = 0
       AND b.${column}_at <= ? AND b.starts_at > ?${scope.sql}
     ORDER BY b.${column}_at, p.id LIMIT 200`
  ).bind(now, now, ...scope.args).all();

  const rosters = new Map();
  for (const row of results) {
    try {
      const claim = await env.DB.prepare(
        `UPDATE booking_players SET ${column}_sent = 1 WHERE id = ? AND ${column}_sent = 0`
      ).bind(row.player_row_id).run();
      if (!claim.meta.changes) continue;
      if (!row.player_user_id) continue;

      if (!rosters.has(row.id)) rosters.set(row.id, await rosterFor(env, row.id));
      const tz = await getTimezone(env, row.player_chat_id || row.chat_id);
      const roster = rosters.get(row.id);
      const chatId = reachableChat(env, { chat_id: row.player_chat_id }, row.chat_id);
      const html = reminderHtml(row, roster, headline, tz);
      const outcome = await sendPrivately(
        env, chatId, html, row.player_user_id, endOfLocalDay(row.starts_at, tz)
      );

      if (outcome === 'private') continue;
      if (outcome === 'not-ephemeral') {
        // Claim the rest of this roster so the public fallback is sent once.
        await env.DB.prepare(
          `UPDATE booking_players SET ${column}_sent = 1 WHERE booking_id = ?`
        ).bind(row.id).run();
        if (!(await remindPublicly(env, row, roster, headline, tz))) {
          await env.DB.prepare(
            `UPDATE booking_players SET ${column}_sent = 0 WHERE booking_id = ?`
          ).bind(row.id).run();
        }
        continue;
      }
      await env.DB.prepare(
        `UPDATE booking_players SET ${column}_sent = 0 WHERE id = ?`
      ).bind(row.player_row_id).run();
    } catch (error) {
      console.log(`${column} reminder for player ${row.player_row_id} failed: ${error.stack || error}`);
    }
  }
}

// Bookings made before rosters existed have nobody to remind individually, so
// they keep the original booking-level reminder to whoever booked them.
async function remindRosterlessBookings(env, now, column, headline) {
  const scope = chatScope(env, 'b.chat_id');
  const { results } = await env.DB.prepare(
    `SELECT * FROM bookings AS b
     WHERE b.${column}_sent = 0 AND b.${column}_at <= ? AND b.starts_at > ?${scope.sql}
       AND NOT EXISTS (SELECT 1 FROM booking_players WHERE booking_id = b.id)
     ORDER BY b.${column}_at LIMIT 100`
  ).bind(now, now, ...scope.args).all();

  for (const booking of results) {
    try {
      const claim = await env.DB.prepare(
        `UPDATE bookings SET ${column}_sent = 1 WHERE id = ? AND ${column}_sent = 0`
      ).bind(booking.id).run();
      if (!claim.meta.changes || !booking.created_by_user_id) continue;
      const tz = await getTimezone(env, booking.chat_id);
      const roster = [{
        user_id: booking.created_by_user_id,
        name: booking.created_by_name || 'Squash player',
      }];
      const html = reminderHtml(booking, roster, headline, tz);
      const outcome = await sendPrivately(
        env, booking.chat_id, html, booking.created_by_user_id,
        endOfLocalDay(booking.starts_at, tz)
      );
      if (outcome === 'not-ephemeral') {
        await remindPublicly(env, booking, roster, headline, tz);
      } else if (outcome === 'failed') {
        await env.DB.prepare(`UPDATE bookings SET ${column}_sent = 0 WHERE id = ?`)
          .bind(booking.id).run();
      }
    } catch (error) {
      console.log(`${column} reminder ${booking.id} failed: ${error.stack || error}`);
    }
  }
}

async function sendReminders(env, now, column, headline) {
  await sendClaimedReminders(env, now, column, headline);
  await remindRosterlessBookings(env, now, column, headline);
}

function sendDueReminders(env, now) {
  return sendReminders(env, now, 'reminder', 'Squash today!');
}

function sendPreReminders(env, now) {
  return sendReminders(env, now, 'pre_reminder', 'Squash in 2 hours!');
}

async function removeExpiredBookings(env, now) {
  const scope = chatScope(env, 'chat_id');
  const { results: expired } = await env.DB.prepare(
    `SELECT * FROM bookings WHERE ends_at <= ?${scope.sql} ORDER BY chat_id, id`
  ).bind(now, ...scope.args).all();
  const chatIds = [...new Set(expired.map((booking) => booking.chat_id))];
  for (const chatId of chatIds) {
    // The money comes first and in its own scope. A board that cannot be pinned
    // — deleted message, revoked permission — used to throw here and silently
    // stop every charge from that point on.
    let charged = 0;
    for (const booking of expired.filter((row) => row.chat_id === chatId)) {
      try {
        // The court has been played by now, so this is the moment the tab moves.
        charged += await chargeBooking(env, booking, await rosterFor(env, booking.id));
        const deleted = await env.DB.prepare(
          'DELETE FROM bookings WHERE id = ? AND chat_id = ? AND ends_at <= ?'
        ).bind(booking.id, chatId, now).run();
        if (deleted.meta.changes) {
          await clearRoster(env, booking.id);
          await recordAudit(
            env, booking.id, chatId, 'deleted', null, 'Expired automatically', booking, null
          );
        }
      } catch (error) {
        console.log(`Cleanup of booking ${booking.id} failed: ${error.stack || error}`);
      }
    }
    try {
      await updateBoard(env, chatId, now);
      if (charged) await updateTab(env, chatId);
    } catch (error) {
      console.log(`Pinned message refresh for chat ${chatId} failed: ${error.stack || error}`);
    }
  }
}

export async function runMaintenance(env, now = Date.now()) {
  try {
    await sendPreReminders(env, now);
  } catch (error) {
    console.log(`Two-hour reminder maintenance failed: ${error.stack || error}`);
  }
  try {
    await sendDueReminders(env, now);
  } catch (error) {
    console.log(`Reminder maintenance failed: ${error.stack || error}`);
  }
  try {
    await purgeFinishedMessages(env, now);
  } catch (error) {
    console.log(`Reminder cleanup failed: ${error.stack || error}`);
  }
  try {
    await removeExpiredBookings(env, now);
  } catch (error) {
    console.log(`Cleanup maintenance failed: ${error.stack || error}`);
  }
}

export function isSameLocalDay(a, b, tz) {
  const x = localParts(a, tz);
  const y = localParts(b, tz);
  return x.y === y.y && x.mo === y.mo && x.d === y.d;
}

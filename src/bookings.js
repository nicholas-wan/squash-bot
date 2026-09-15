import {
  clearRoster, defaultCapacity, DEFAULT_CAPACITY, identity, isChatAdmin,
  knownPlayers, matchesPlayer, MAX_CAPACITY, openBooking, rosterFor, rostersFor, seedRoster,
} from './players.js';
import { compactTimeRange, courtName, formatCountdown, shortClock, shortCourtName, shortDate } from './format.js';
export { formatCountdown } from './format.js';
import { allowedChats, boardChats, dataChatId, reachableChat, sharingData } from './scope.js';
import { getTimezone, updatePinnedMessage } from './settings.js';
import { breakdownLines, chargeBooking, tabBalances, updateTab } from './tab.js';
import { formatDate, formatTime, localParts, zonedEpoch } from './time.js';
import { queuePinnedRefresh } from './refresh-queue.js';
import { maintainAnnouncements, syncAnnouncements } from './announcements.js';
import {
  deleteEphemeralMessage, deleteMessage, editReplyMarkup, escapeHtml, mentionHtml,
  OK_MARKUP, sendMessage,
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
  await auditStatement(env, bookingId, chatId, action, from, sourceText, before, after).run();
}

function auditStatement(
  env, bookingId, chatId, action, from, sourceText, before = null, after = null,
  { requireBooking = false, requireState = null } = {}
) {
  const sql = requireState
    ? `INSERT INTO booking_audit
        (booking_id, chat_id, action, actor_user_id, actor_name, source_text,
         before_json, after_json, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM bookings
         WHERE id = ? AND chat_id = ? AND court = ?
           AND starts_at = ? AND ends_at = ? AND reminder_at = ?
       )`
    : requireBooking
    ? `INSERT INTO booking_audit
        (booking_id, chat_id, action, actor_user_id, actor_name, source_text,
         before_json, after_json, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE EXISTS (SELECT 1 FROM bookings WHERE id = ? AND chat_id = ?)`
    : `INSERT INTO booking_audit
        (booking_id, chat_id, action, actor_user_id, actor_name, source_text,
         before_json, after_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  const args = [
    bookingId, dataChatId(env, chatId), action, from && from.id || null, actorName(from),
    sourceText || null, before ? JSON.stringify(bookingSnapshot(before)) : null,
    after ? JSON.stringify(bookingSnapshot(after)) : null, Date.now(),
  ];
  if (requireState) {
    args.push(
      bookingId, dataChatId(env, chatId), String(requireState.court),
      requireState.startsAt, requireState.endsAt, requireState.reminderAt
    );
  } else if (requireBooking) {
    args.push(bookingId, dataChatId(env, chatId));
  }
  return env.DB.prepare(sql).bind(...args);
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

// The booker's receipt stays private; availability has its own group message.
async function confirmToBooker(env, chatId, bookingId, booking, capacity, from, callbackQueryId) {
  if (!from || !from.id) return;
  const tz = await getTimezone(env, chatId);
  const startsAt = booking.startsAt ?? booking.starts_at;
  const endsAt = booking.endsAt ?? booking.ends_at;
  const court = courtName(booking);
  const roster = await rosterFor(env, bookingId);
  // If OK is never tapped it still clears itself at the end of the day, and a
  // receipt Telegram could not keep private is removed rather than left up.
  await sendPrivately(env, chatId,
    `🎾 <b>${escapeHtml(court)} booked</b>\n` +
    `${formatDate(startsAt, tz)} · ${compactTimeRange(startsAt, endsAt, tz)}\n` +
    `👥 ${playerTags(roster)} · ${slotsLabel(roster, capacity)}`,
    from.id, endOfLocalDay(startsAt, tz),
    { callbackQueryId, replyMarkup: OK_MARKUP }
  );
}

export async function addBooking(
  env, chatId, parsed, from, sourceText = null,
  { allowConflict = false, callbackQueryId = null, bookedFor = null, companions = {} } = {}
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
    reminderSent, preReminderAt, preReminderSent, capacity,
    // An admin can record somebody else as the booker: that person owns the
    // booking — seated first, billed the booker's share, allowed to cancel it
    // — while the audit row still names the admin who typed it in.
    bookedFor ? bookedFor.userId || null : from && from.id || null,
    bookedFor ? bookedFor.name : actorName(from), sourceText, now, allowConflict ? 1 : 0,
    dataChatId(env, chatId), parsed.court, parsed.endsAt, parsed.startsAt
  ).run();
  if (!result.meta.changes) {
    throw new BookingConflictError(await findBookingConflicts(env, chatId, parsed));
  }
  const bookingId = result.meta.last_row_id;
  try {
    await recordAudit(env, bookingId, chatId, 'added', from, sourceText, null, parsed);
    await seedRoster(env, chatId, bookingId, from, capacity, bookedFor, companions);
  } catch (error) {
    // The booking insert has already committed. Compensate all of its internal
    // rows so a transient audit/roster failure cannot leave a half-booking.
    const cleanup = [
      env.DB.prepare('DELETE FROM booking_players WHERE booking_id = ?').bind(bookingId),
      env.DB.prepare("DELETE FROM booking_audit WHERE booking_id = ? AND action = 'added'").bind(bookingId),
      env.DB.prepare('DELETE FROM bookings WHERE id = ? AND chat_id = ?')
        .bind(bookingId, dataChatId(env, chatId)),
    ];
    for (const statement of cleanup) {
      try {
        await statement.run();
      } catch (cleanupError) {
        // Keep going: an unavailable audit table, for example, must not prevent
        // the booking itself from being removed by the final statement.
        console.log(`Compensation for booking ${bookingId} failed: ${cleanupError.stack || cleanupError}`);
      }
    }
    throw error;
  }
  try {
    await updateBoard(env, chatId);
  } catch (error) {
    // The booking is committed. Reporting the whole operation as failed invites
    // a duplicate retry; updateBoard has queued a maintenance retry.
    console.log(`Board refresh after adding booking ${bookingId} failed: ${error.stack || error}`);
  }
  // Booked on behalf, the receipt is skipped: it would be an unprompted
  // ephemeral to somebody who tapped nothing — the kind Telegram drops.
  // The attribution is for the record, and the board carries the news.
  if (!bookedFor) {
    try {
      await confirmToBooker(env, chatId, bookingId, parsed, capacity, from, callbackQueryId);
    } catch (error) {
      console.log(`Receipt for booking ${bookingId} failed: ${error.stack || error}`);
    }
  }
  return bookingId;
}

export async function updateBooking(
  env, chatId, id, parsed, from, sourceText = null, { allowConflict = false } = {}
) {
  const before = await env.DB.prepare('SELECT * FROM bookings WHERE id = ? AND chat_id = ?')
    .bind(id, dataChatId(env, chatId)).first();
  if (!before) return false;
  const now = Date.now();
  // A stale form must not move a court after it has finished. In particular,
  // an admin can open an edit during play and leave it on screen past the end;
  // without this unconditional guard the already-played court escapes charging.
  if (before.ends_at <= now) return 'played';
  // The form can be saved long after it was opened, so the start is checked
  // here as well as when the form is opened: without it a court that came into
  // play while somebody sat on the wizard could still be moved off the tab.
  if (from && before.starts_at <= now && !(await isChatAdmin(env, chatId, from))) {
    return 'started';
  }
  const preReminderAt = parsed.startsAt - 2 * 60 * 60 * 1000;
  const updateStatement = env.DB.prepare(
    `UPDATE bookings SET
       court = ?, starts_at = ?, ends_at = ?, reminder_at = ?,
       reminder_sent = ?, pre_reminder_at = ?, pre_reminder_sent = ?
     WHERE id = ? AND chat_id = ? AND ends_at > ? AND (
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
    preReminderAt <= now ? 1 : 0, id, dataChatId(env, chatId), now, allowConflict ? 1 : 0,
    dataChatId(env, chatId), parsed.court, parsed.endsAt, parsed.startsAt, id
  );
  const resetReminders = env.DB.prepare(
    `UPDATE booking_players SET reminder_sent = ?, pre_reminder_sent = ?
     WHERE booking_id = ? AND EXISTS (
       SELECT 1 FROM bookings
       WHERE id = ? AND chat_id = ? AND court = ?
         AND starts_at = ? AND ends_at = ? AND reminder_at = ?
     )`
  ).bind(
    parsed.reminderAt <= now ? 1 : 0, preReminderAt <= now ? 1 : 0,
    id, id, dataChatId(env, chatId), String(parsed.court),
    parsed.startsAt, parsed.endsAt, parsed.reminderAt
  );
  let result;
  if (typeof env.DB.batch === 'function') {
    const outcomes = await env.DB.batch([
      updateStatement,
      resetReminders,
      auditStatement(env, id, chatId, 'edited', from, sourceText, before, parsed,
        { requireState: parsed }),
    ]);
    result = outcomes[0];
  } else {
    result = await updateStatement.run();
  }
  if (!result.meta.changes) {
    const current = await env.DB.prepare(
      'SELECT ends_at FROM bookings WHERE id = ? AND chat_id = ?'
    ).bind(id, dataChatId(env, chatId)).first();
    if (current && current.ends_at <= Date.now()) return 'played';
    const conflicts = await findBookingConflicts(env, chatId, parsed, id);
    if (conflicts.length) throw new BookingConflictError(conflicts);
    return false;
  }
  // The roster claims its own reminders, so a booking moved to another day has
  // to hand them back or everyone already told hears nothing about the new one.
  if (typeof env.DB.batch !== 'function') {
    await resetReminders.run();
    await recordAudit(env, id, chatId, 'edited', from, sourceText, before, parsed);
  }
  // A moved court is news to everyone on it: the re-armed reminders would say
  // so eventually, but not before somebody plans their evening around the old
  // time. Old details ride along so the change reads as a change.
  const roster = await rosterFor(env, id);
  try {
    if (roster.length) {
      const tz = await getTimezone(env, chatId);
      await notifyRosterDirectly(env, chatId, roster,
        `✏️ <b>Booking changed</b> by <b>${escapeHtml(actorName(from) || 'an admin')}</b>\n` +
        `Now: ${escapeHtml(courtName(parsed))} · ${formatDate(parsed.startsAt, tz)} · ` +
        `${compactTimeRange(parsed.startsAt, parsed.endsAt, tz)}\n` +
        `Was: ${escapeHtml(courtName(before))} · ${formatDate(before.starts_at, tz)} · ` +
        `${compactTimeRange(before.starts_at, before.ends_at, tz)}`,
        endOfLocalDay(parsed.startsAt, tz), from && from.id);
    }
    await updateBoard(env, chatId);
  } catch (error) {
    console.log(`Post-commit work for edited booking ${id} failed: ${error.stack || error}`);
  }
  return true;
}

const BOOKING_GONE = 'That booking has already gone.';

// The hour of play is when everybody on the court is committed to their share:
// the charge is only written when the booking expires, so a booker who cancels
// — or moves the court to tomorrow and cancels it there — during that hour
// erases the whole roster's bill. An admin can still act, because a no-show or
// a court nobody could get into is theirs to sort out.
export const BOOKING_STARTED =
  'That court has already started, so only a group admin can change it.';

// Booking ids are small sequential numbers, so without this any member could
// walk the whole group's history away. One rule for /cancel and for every button
// that edits or deletes: whoever booked the court, or a group admin, and only
// until the court starts. A refusal says nothing about the booking beyond who to
// ask. `from` is null only on the automatic expiry sweep, which answers to the
// clock rather than to a person.
export async function authorizeBookingChange(env, chatId, id, from, action = 'change') {
  const booking = await env.DB.prepare('SELECT * FROM bookings WHERE id = ? AND chat_id = ?')
    .bind(id, dataChatId(env, chatId)).first();
  if (!booking) return { allowed: false, status: 'gone', message: BOOKING_GONE, booking: null };
  if (!from) return { allowed: true, status: 'ok', message: '', booking };
  const booked = booking.created_by_user_id
    && Number(booking.created_by_user_id) === Number(from.id);
  // Asked at most once and only when it is needed: the booker's own path costs
  // no getChatMember round trip until their court has started.
  let admin;
  const isAdmin = () => (admin ??= isChatAdmin(env, chatId, from));
  if (!booked && !(await isAdmin())) {
    return {
      allowed: false,
      status: 'forbidden',
      message: `Only ${booking.created_by_name || 'whoever booked it'} or a group admin ` +
        `can ${action} that booking.`,
      booking: null,
    };
  }
  if (booking.starts_at <= Date.now() && !(await isAdmin())) {
    return { allowed: false, status: 'started', message: BOOKING_STARTED, booking: null };
  }
  return { allowed: true, status: 'ok', message: '', booking };
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
  // Read before the delete: clearRoster is about to take the only record of
  // who needs to hear that this court is gone.
  const roster = await rosterFor(env, id);
  const deleteBooking = env.DB.prepare('DELETE FROM bookings WHERE id = ? AND chat_id = ?')
    .bind(id, dataChatId(env, chatId));
  let result;
  if (typeof env.DB.batch === 'function') {
    const outcomes = await env.DB.batch([
      auditStatement(env, id, chatId, 'deleted', from, sourceText, booking, null,
        { requireBooking: true }),
      env.DB.prepare('DELETE FROM booking_players WHERE booking_id = ?').bind(id),
      deleteBooking,
    ]);
    result = outcomes[2];
  } else {
    result = await deleteBooking.run();
  }
  if (!result.meta.changes) {
    return { allowed: false, status: 'gone', message: BOOKING_GONE, booking: null };
  }
  // A cancelled booking is never played, so it never reaches the tab.
  if (typeof env.DB.batch !== 'function') {
    await clearRoster(env, id);
    await recordAudit(env, id, chatId, 'deleted', from, sourceText, booking, null);
  }
  // The roster hears before the board is touched, for the same reason a join
  // notice does: a board Telegram refuses to edit must not swallow the one
  // message that stops somebody showing up to a cancelled court. Their morning
  // reminder may already be in hand; silence here is how no-shows happen.
  try {
    if (roster.length) {
      const tz = await getTimezone(env, chatId);
      await notifyRosterDirectly(env, chatId, roster,
        `🗑 <b>Cancelled</b> — ${escapeHtml(courtName(booking))}\n` +
        `${formatDate(booking.starts_at, tz)} · ` +
        `${compactTimeRange(booking.starts_at, booking.ends_at, tz)}` +
        (from ? `\nCancelled by <b>${escapeHtml(actorName(from))}</b>.` : ''),
        endOfLocalDay(booking.starts_at, tz), from && from.id);
    }
    await updateBoard(env, chatId);
  } catch (error) {
    console.log(`Post-commit work for cancelled booking ${id} failed: ${error.stack || error}`);
  }
  return { allowed: true, status: 'cancelled', message: '', booking };
}

// "9pm", or "9:30pm" when there are minutes to show.
async function activeBookings(env, chatId, now = Date.now()) {
  return (await env.DB.prepare(
    'SELECT * FROM bookings WHERE chat_id = ? AND ends_at > ? ORDER BY starts_at, court, id'
  ).bind(dataChatId(env, chatId), now).all()).results;
}

// The private list is the fallback for everything the board's own buttons
// cannot reach, so it has to be the longer of the two. If it were the same
// length it would drop exactly the courts the board sends people here for.
const MAX_JOIN_BUTTONS = 12;

// The comma Intl puts after the weekday is dropped: these read alongside “·”
// separators, and on a phone every character counts against wrapping.
// Slots one roster row holds: two when an admin seated that member with a
// friend. A row written before the column existed carries no heads at all, and
// stands for the one person it always did.
function playerHeads(player) {
  return player.heads || 1;
}

// Capacity and the tab both count people, not rows, so every comparison against
// capacity goes through this rather than roster.length.
function rosterHeads(roster) {
  return roster.reduce((total, player) => total + playerHeads(player), 0);
}

// A player whose numeric id is known gets a real tag. Anyone still seeded from
// config by username is written as plain @handle, which Telegram links and
// notifies by itself; their id is filled in the first time they post.
function playerTags(roster) {
  if (!roster.length) return 'nobody yet';
  return roster.map((player) => {
    // A friend has no identity of their own, so they are named on the person
    // who brought them rather than as a row nobody could tap or bill.
    const name = playerHeads(player) > 1 ? `${player.name} +1` : player.name;
    return player.user_id ? mentionHtml(player.user_id, name) : escapeHtml(name);
  }).join(', ');
}

// The board stays about who is playing. Money lives on the tab.
// Room first, then the head count: "1 slot · 2/3" answers "can I join" at a
// glance and "how big is the game" right behind it. A full court needs no
// ratio — full already says 3 of 3.
function slotsLabel(roster, capacity) {
  const heads = rosterHeads(roster);
  const free = Math.max(0, capacity - heads);
  if (!free) return 'full';
  return `${free} slot${free === 1 ? '' : 's'} · ${heads}/${capacity}`;
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
  const [active, tz] = await Promise.all([
    activeBookings(env, chatId, now), getTimezone(env, chatId),
  ]);
  const bookings = active.filter((booking) => booking.starts_at > now);
  if (!bookings.length) return null;
  const rosters = await rostersFor(env, chatId, bookings.map((booking) => booking.id));
  // May be a promise started alongside the reads above, so the getChatMember
  // round trip it hides costs no extra wall clock. isChatAdmin never rejects,
  // which is what makes the early return above safe to leave it unawaited.
  isAdmin = await isAdmin;
  const rows = [];
  // Every court the board lists appears here too, full ones marked rather than
  // hidden: a court you can see pinned and then cannot find in this list reads
  // as a bug, and the board no longer keeps full courts back.
  // The labels are as short as they can stay unambiguous: a phone truncates
  // button text from the right, so the free-slot count — the reason to tap —
  // has to survive the cut. Full rows drop it; the padlock already says full.
  for (const booking of bookings.slice(0, MAX_JOIN_BUTTONS)) {
    const roster = rosters.get(booking.id) || [];
    const capacity = booking.capacity || DEFAULT_CAPACITY;
    const label = `${shortDate(booking.starts_at, tz)} ` +
      `${compactTimeRange(booking.starts_at, booking.ends_at, tz)} · ` +
      `${shortCourtName(booking)}`;
    const free = Math.max(0, capacity - rosterHeads(roster));
    if (roster.some((player) => matchesPlayer(player, from))) {
      rows.push([{ text: `🚪 Leave ${label}`, callback_data: `sb:leave:${booking.id}` }]);
    } else if (free) {
      rows.push([{
        text: `🙋 Join ${label} · ${free} left`, callback_data: `sb:join:${booking.id}`,
      }]);
    } else {
      rows.push([{ text: `🔒 Full ${label}`, callback_data: `sb:full:${booking.id}` }]);
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
  // You can see who you are playing with, on the courts you are on. An admin
  // sees every court, because keeping the household straight is their job. The
  // board names nobody, so this is the only place either of them can read it.
  for (const booking of bookings.slice(0, MAX_JOIN_BUTTONS)) {
    const roster = rosters.get(booking.id) || [];
    if (!isAdmin && !roster.some((player) => matchesPlayer(player, from))) continue;
    lines.push('');
    lines.push(`${shortDate(booking.starts_at, tz)} · ` +
      `${shortClock(booking.starts_at, tz)} · <b>${escapeHtml(courtName(booking))}</b>`);
    lines.push(`👥 ${playerTags(roster)}`);
  }
  return {
    html: lines.join('\n'),
    replyMarkup: { inline_keyboard: rows },
  };
}

async function renderBoard(env, chatId, now) {
  const [tz, bookings] = await Promise.all([
    getTimezone(env, chatId), activeBookings(env, chatId, now),
  ]);
  if (!bookings.length) return { html: null, replyMarkup: null };
  const rosters = await rostersFor(env, chatId, bookings.map((booking) => booking.id));

  // Two short lines and a gap per booking. A phone wraps anything much past
  // thirty characters, and a wrapped “Court 4” or “1 slot” is what made the
  // board read as a wall. An open court's roster is dropped because
  // DEFAULT_PLAYERS puts the same handles on every row; who is playing lives
  // behind 🙋 Join, which can answer it per person as the shared board never
  // could. A full court is the exception: nobody can join it, so the one
  // question left about it is who took it, and that is answered underneath.
  // Every court is listed, full ones included: the board is the answer to "what
  // is booked", and a court missing from it reads as a court nobody took. The
  // slot count carries the difference.
  const lines = ['🎾 <b>Upcoming squash courts</b>'];
  for (const booking of bookings) {
    const roster = rosters.get(booking.id) || [];
    const slots = slotsLabel(roster, booking.capacity || DEFAULT_CAPACITY);
    const line = `${compactTimeRange(booking.starts_at, booking.ends_at, tz)} · ` +
      `<b>${escapeHtml(courtName(booking))}</b> · ${slots}`;
    lines.push('');
    lines.push(formatCountdown(booking.starts_at, tz, now));
    // A full court stays listed — dropping it would read as a court nobody
    // took — but struck through, so the open slots pop at a glance.
    lines.push(slots === 'full' ? `<s>${line}</s>` : line);
    if (slots === 'full' && roster.length) lines.push(`👥 ${playerTags(roster)}`);
  }
  return {
    html: lines.join('\n'),
    replyMarkup: boardButtons(bookings),
  };
}

export async function boardHtml(env, chatId, now = Date.now()) {
  return (await renderBoard(env, chatId, now)).html;
}

// Every group sharing these bookings gets the same pinned board. A sibling
// chat gone bad — bot kicked, group deleted, pin rights revoked — is logged
// and skipped: it must not take down the chat the tap actually came from,
// which once turned one kicked group into every command failing everywhere.
// Only the acting chat's own failure still surfaces, because there it is the
// answer the person is waiting on.
export async function updateBoard(env, chatId, now = Date.now()) {
  const board = await renderBoard(env, chatId, now);
  // Shared chats are independent Telegram calls. Running them together keeps a
  // dead sibling from adding one full network round trip per group, while the
  // acting chat still decides whether the operation itself succeeds.
  const outcomes = await Promise.all(boardChats(env, chatId).map(async (chat) => {
    try {
      // Announcement errors are retried by maintenance and do not block the board.
      try { await syncAnnouncements(env, chat, now); }
      catch (error) { console.log(`Announcement refresh failed: ${error.message || error}`); }
      const id = await updatePinnedMessage(
        env, chat, 'board_message_id', board.html, board.replyMarkup, 'court board'
      );
      return { chat, id };
    } catch (error) {
      return { chat, error };
    }
  }));
  for (const outcome of outcomes.filter((item) => item.error)) {
    try {
      await queuePinnedRefresh(env, outcome.chat, 'board');
    } catch (queueError) {
      console.log(`Could not queue board refresh for chat ${outcome.chat}: ${queueError.stack || queueError}`);
    }
  }
  for (const outcome of outcomes) {
    if (!outcome.error || outcome.chat === chatId) continue;
    console.log(
      `Board update for sibling chat ${outcome.chat} failed: `
      + `${outcome.error.stack || outcome.error}`
    );
  }
  const acting = outcomes.find((outcome) => outcome.chat === chatId);
  if (acting && acting.error) throw acting.error;
  // The acting chat's pinned id comes back, so a command can say whether a
  // board exists at all — null means nothing is booked and nothing is pinned.
  return acting ? acting.id : null;
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
  const [bookings, tz] = await Promise.all([
    activeBookings(env, chatId, now), getTimezone(env, chatId),
  ]);
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
  const booking = await openBooking(env, chatId, bookingId);
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
  // Only while a slot is free: seating somebody never squeezes past capacity.
  if (rosterHeads(roster) < capacity) {
    rows.push([{
      text: '➕ Admin: add a player', callback_data: `sb:addp:${booking.id}`,
    }]);
  }
  if (roster.length) {
    rows.push([{
      text: '👥 Admin: +1 for a player', callback_data: `sb:plus:${booking.id}`,
    }]);
    rows.push([{
      text: '🚪 Admin: remove a player', callback_data: `sb:kick:${booking.id}`,
    }]);
  }
  rows.push([{ text: '🗑 Delete booking', callback_data: `sb:delete:${booking.id}` }]);
  rows.push([{ text: '← Back to bookings', callback_data: 'sb:manage' }]);
  // The board cannot name the roster without repeating the same handles on
  // every row, but this panel is private and about one court, so it is the
  // place to answer who is playing.
  // The booker is named here and nowhere else visible: attribution is for
  // admins keeping the record straight, not for the board or the group.
  return {
    html: `⚙️ <b>${escapeHtml(bookingLabel(booking, tz))}</b>\n`
      + `👥 ${playerTags(roster)} · ${slotsLabel(roster, capacity)}\n`
      + (booking.created_by_name
        ? `📝 Booked by ${escapeHtml(booking.created_by_name)}\n` : '')
      + '\nOnly you can see this.',
    replyMarkup: { inline_keyboard: rows },
  };
}

// Who an admin can seat: everyone the bot knows who is not already on this
// court, while a slot is free. Somebody the bot has never seen is not listed —
// they are in the group anyway, and can tap 🙋 Join themselves.
//
// heads is what the toggle at the top of the keyboard is holding: 2 seats the
// next person tapped with a friend, and needs two free slots rather than one,
// so the whole panel is unavailable when only one is left.
export async function addPlayerView(env, chatId, bookingId, heads = 1) {
  const booking = await openBooking(env, chatId, bookingId);
  if (!booking) return null;
  const roster = await rosterFor(env, bookingId);
  const capacity = booking.capacity || DEFAULT_CAPACITY;
  if (rosterHeads(roster) + heads > capacity) return null;
  const seated = new Set(roster.map((player) => player.slug));
  const encoder = new TextEncoder();
  const candidates = (await knownPlayers(env, chatId))
    .filter((player) => !seated.has(player.slug))
    // Telegram caps callback_data at 64 bytes; a slug that will not fit
    // cannot be offered as a button.
    .filter((player) => encoder
      .encode(`sb:addp:${bookingId}:${heads}:${player.slug}`).length <= 64)
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, MAX_JOIN_BUTTONS);
  if (!candidates.length) return null;
  const tz = await getTimezone(env, chatId);
  // The toggle sits above the names because it changes what tapping one of them
  // does, and a switch read after the fact is a switch nobody read.
  const rows = [[heads > 1
    ? {
      text: '👥 Bringing a friend: yes — pays double',
      callback_data: `sb:addp:${bookingId}:h1`,
    }
    : {
      text: '👥 Bringing a friend: no',
      callback_data: `sb:addp:${bookingId}:h2`,
    }]];
  for (const player of candidates) {
    rows.push([{
      text: `➕ ${player.name}`,
      callback_data: `sb:addp:${bookingId}:${heads}:${player.slug}`,
    }]);
  }
  rows.push([{ text: '← Back', callback_data: `sb:pick:${bookingId}` }]);
  return {
    html: `➕ <b>Seat somebody on ${escapeHtml(bookingLabel(booking, tz))}</b>\n\n`
      + (heads > 1
        ? 'They take two slots and pay two shares. The friend is nobody the bot '
          + 'knows — whoever you seat sponsors them.'
        : 'They are billed like anyone who joined themselves. Anyone not listed '
          + 'can tap 🙋 Join on the pinned board.'),
    replyMarkup: { inline_keyboard: rows },
  };
}

// Flip a +1 on somebody already seated: each row names the member and which
// way tapping them flips. Keyed on the roster row id like the kick picker —
// a row id cannot go stale into somebody else the way a re-typed handle can.
export async function plusOneView(env, chatId, bookingId) {
  const booking = await openBooking(env, chatId, bookingId);
  if (!booking) return null;
  const roster = await rosterFor(env, bookingId);
  if (!roster.length) return null;
  const tz = await getTimezone(env, chatId);
  const rows = roster.map((player) => [{
    text: playerHeads(player) > 1
      ? `➖ ${player.name} +1 — back to one share`
      : `➕ ${player.name} — bring a friend, pays double`,
    callback_data: `sb:plus:${bookingId}:${player.id}`,
  }]);
  rows.push([{ text: '← Back', callback_data: `sb:pick:${bookingId}` }]);
  return {
    html: `👥 <b>+1 on ${escapeHtml(bookingLabel(booking, tz))}</b>\n\n`
      + 'A friend takes a slot and a share, both carried by whoever brings them.',
    replyMarkup: { inline_keyboard: rows },
  };
}

export async function removePlayerView(env, chatId, bookingId) {
  const booking = await openBooking(env, chatId, bookingId);
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

// One private note to everyone reachable on a roster, minus whoever acted —
// they already have their toast. Used for the changes that have no join-shaped
// wording: a cancelled court and a moved one. Dedup is by id, like
// notifyRosterOfChange, and the cleanup rows land in one batch.
async function notifyRosterDirectly(env, chatId, roster, html, deleteAfter, excludeUserId = null) {
  const told = new Set();
  const cleanups = [];
  await Promise.all(roster.map((player) => {
    if (!player.user_id || player.user_id === excludeUserId || told.has(player.user_id)) {
      return null;
    }
    told.add(player.user_id);
    return sendPrivately(env, chatId, html, player.user_id, deleteAfter,
      { replyMarkup: OK_MARKUP, cleanups });
  }));
  if (cleanups.length) {
    if (typeof env.DB.batch === 'function') await env.DB.batch(cleanups);
    else for (const statement of cleanups) await statement.run();
  }
}

// The person taken off is told privately. Deliberately narrower than the
// join/leave notices: the rest of the court is not told a kick freed a slot —
// an asymmetry recorded under Known gaps in the README, not an oversight.
export async function notifyRemovedPlayer(env, chatId, player, booking) {
  if (!player.user_id) return;
  const tz = await getTimezone(env, chatId);
  // The chat the admin acted in, for the same reason a join notice goes there.
  await sendPrivately(env, chatId,
    `🚪 You were taken off <b>${escapeHtml(courtName(booking))}</b> on ` +
    `${formatDate(booking.starts_at, tz)} · ${formatTime(booking.starts_at, tz)}.\n` +
    'Tap the 🙋 button on the pinned board if that was a mistake.',
    player.user_id, endOfLocalDay(booking.starts_at, tz), { replyMarkup: OK_MARKUP });
}

// The board names who is on a court only once it is full, so the whole roster
// hears when a slot changes hands: the others that it happened, and whoever tapped as a
// confirmation they can read after the toast has gone. Leaving is told the same
// way as joining — a freed slot is news to the people still on the court, and
// silence would read as the tap not having worked.
//
// Everything goes to the chat the tap came from, not the chat each roster row
// was created in. An ephemeral message is only visible in the chat it is posted
// to, and with DATA_CHAT_ID a roster spans groups, so honouring a row's own
// chat_id delivered notices into whichever group that member was first seen in
// — correct by the letter, invisible to somebody reading the other one.
//
// heads is the size of the row that changed hands, which only an admin seating
// somebody with a friend ever makes 2. It is passed rather than read back off
// the roster because that would rest on the seated player resolving to the same
// slug their row was written under, which is exactly what rememberPlayer moves.
export async function notifyRosterOfChange(
  env, chatId, booking, from, action, heads = 1, { callbackQueryId = null } = {}
) {
  // Loud, not lenient: an unrecognised action falling through to one of the
  // messages would announce something that did not happen. 'added' is an
  // admin seating somebody — for them and the roster it reads like a join,
  // but the wording says who did it was not them.
  if (!['joined', 'left', 'added', 'plus', 'minus'].includes(action)) {
    throw new Error(`notifyRosterOfChange: unknown action "${action}"`);
  }
  const left = action === 'left';
  // These reads are independent and both sit before the notification burst;
  // starting them together shortens the path after the tap was acknowledged.
  const [tz, roster] = await Promise.all([
    getTimezone(env, chatId), rosterFor(env, booking.id),
  ]);
  const actor = identity(from);
  const where = `${escapeHtml(courtName(booking))}\n`
    + `${shortDate(booking.starts_at, tz)} · `
    + `${compactTimeRange(booking.starts_at, booking.ends_at, tz)} · `
    + `${slotsLabel(roster, booking.capacity || DEFAULT_CAPACITY)}\n`
    + `👥 ${playerTags(roster)}`;
  // The sponsor hears about both shares from the bot itself, not first from
  // the tab: a doubled charge nobody warned them about reads as a mistake.
  const name = escapeHtml(actor.name);
  const twoShares = '\nYour +1 plays on your tab — this court counts as two shares for you.';
  const toOthers = {
    joined: `🙋 <b>${name}</b> joined ${where}`,
    left: `🚪 <b>${name}</b> left ${where}`,
    added: `➕ <b>${name}</b>${heads > 1 ? ' (+1)' : ''}`
      + ` ${heads > 1 ? 'were' : 'was'} seated on ${where}`,
    plus: `👥 <b>${name}</b> is bringing a friend to ${where}`,
    minus: `👥 <b>${name}</b> is no longer bringing a friend to ${where}`,
  }[action];
  const toActor = {
    joined: `✅ <b>You are on</b> ${where}`,
    left: `🚪 <b>You are off</b> ${where}`,
    added: `✅ <b>You are on</b> ${where}` + (heads > 1 ? twoShares : ''),
    plus: `👥 <b>Your +1 is on</b> ${where}${twoShares}`,
    minus: `👥 <b>Your +1 is off</b> ${where}\nBack to one share for you.`,
  }[action];
  // The actor's copy is planned first whichever way the slot went — a leaver's
  // row is already deleted, so the roster could never produce it, and one path
  // for both actions beats two that must agree. Dedup is by id, not slug: one
  // person can briefly hold two roster rows while their username is still
  // being merged, and two copies of this would be a bug.
  const told = new Set();
  const sends = [];
  if (actor.userId) {
    told.add(actor.userId);
    sends.push({
      isActor: true, userId: actor.userId, html: toActor, callbackQueryId,
    });
  }
  // A row with no id under another slug is someone seeded from config who has
  // never posted: unreachable, which the caller's toast should not paper over.
  let unreachable = false;
  for (const player of roster) {
    if (player.user_id && !told.has(player.user_id)) {
      told.add(player.user_id);
      sends.push({ isActor: false, userId: player.user_id, html: toOthers });
    } else if (!player.user_id && player.slug !== actor.slug) {
      unreachable = true;
    }
  }
  // The sends are independent people, so they go out together rather than one
  // round trip at a time, and their cleanup rows land in a single batch — a
  // full court is a dozen messages, and each was two subrequests on its own.
  const deleteAfter = endOfLocalDay(booking.starts_at, tz);
  const cleanups = [];
  const outcomes = await Promise.all(sends.map(async (send) => ({
    isActor: send.isActor,
    outcome: await sendPrivately(env, chatId, send.html, send.userId, deleteAfter,
      {
        replyMarkup: OK_MARKUP,
        cleanups,
        callbackQueryId: send.isActor ? send.callbackQueryId : null,
      }),
  })));
  if (cleanups.length) {
    if (typeof env.DB.batch === 'function') await env.DB.batch(cleanups);
    else for (const statement of cleanups) await statement.run();
  }
  // Admin actions report whether their subject and the rest of the court were
  // actually reached rather than claiming success for a refused private send.
  return {
    allTold: Boolean(actor.userId) && !unreachable
      && outcomes.every((send) => send.outcome === 'private'),
  };
}

export async function deletePanelView(env, chatId, bookingId, now = Date.now()) {
  const booking = await openBooking(env, chatId, bookingId);
  if (!booking) return null;
  const tz = await getTimezone(env, chatId);
  // Only an admin reaches this panel once the court is in play, and the money
  // is the part that is easy to miss: the charge is written when the booking
  // expires, so deleting it now is deleting everybody's share of it.
  return {
    html: `🗑 <b>Delete ${escapeHtml(bookingLabel(booking, tz))}?</b>`
      + (booking.starts_at <= now
        ? '\n\n⚠️ This court is in progress. Deleting it means nobody is charged for it.'
        : ''),
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

function cleanupStatement(env, chatId, sent, receiverUserId, deleteAfter) {
  const messageId = sent.ephemeral_message_id || sent.message_id;
  if (!messageId) return null;
  return env.DB.prepare(
    `INSERT INTO sent_messages
      (chat_id, receiver_user_id, message_id, is_ephemeral, delete_after, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(
    chatId, receiverUserId || null, messageId,
    sent.ephemeral_message_id ? 1 : 0, deleteAfter, Date.now()
  );
}

async function scheduleCleanup(env, chatId, sent, receiverUserId, deleteAfter) {
  const statement = cleanupStatement(env, chatId, sent, receiverUserId, deleteAfter);
  if (statement) await statement.run();
}

// What Telegram says when a person is out of reach for good rather than for
// now: blocked the bot, left the group, deleted the account, or was never
// somebody this bot could write to. Everything else — a timeout, a 429, a 500
// — is worth another go on the next tick.
const PERMANENT_REFUSAL = /blocked|not found|not a member|not_participant|forbidden|deactivated/i;

// Telegram falls back to an ordinary group message when it cannot deliver an
// ephemeral one. Anything addressed to one person — a receipt with the roster on
// it, a reminder, a removal notice — would then sit in the group instead, so the
// public copy is deleted and the caller decides what to do about the failure.
//
// A caller sending a burst can pass `cleanups`, an array the sent_messages row
// is pushed into instead of written, to be committed in one env.DB.batch —
// one subrequest for the burst rather than one INSERT per message.
//
// A refusal is told apart from a failure: 'failed' is worth retrying — a
// timeout, a 429, a Telegram hiccup — while 'refused' is Telegram saying this
// person cannot be reached at all, and retrying that is a request per minute
// that will never land.
async function sendPrivately(env, chatId, html, userId, deleteAfter, options = {}) {
  const { cleanups, ...sendOptions } = options;
  const sent = await sendMessage(env, chatId, html, { ...sendOptions, receiverUserId: userId });
  if (!sent.ok) {
    return PERMANENT_REFUSAL.test(String(sent.description || '')) ? 'refused' : 'failed';
  }
  if (sent.result && sent.result.ephemeral_message_id) {
    const statement = cleanupStatement(env, chatId, sent.result, userId, deleteAfter);
    if (cleanups) cleanups.push(statement);
    else await statement.run();
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
  // should not also buzz every phone in it. The booking row lives under the
  // data chat id, which may be no chat the bot can still post to, so the
  // fallback goes to a chat it is actually in.
  const chatId = reachableChat(env, { chat_id: booking.chat_id }, booking.chat_id);
  const sent = await sendMessage(env, chatId,
    reminderHtml(booking, roster, headline, tz), { silent: true });
  if (sent.ok && sent.result) {
    await scheduleCleanup(
      env, chatId, sent.result, null, endOfLocalDay(booking.starts_at, tz)
    );
  }
  return sent.ok;
}

// Maintenance has no incoming update to tell it which chat it is running for, so
// each sweep is scoped the way handleUpdate is. Sharing mode files rows under
// DATA_CHAT_ID, which need not be one of the allowed chats itself. An empty or
// malformed allowlist must fail closed: interactive updates already refuse it,
// and maintenance must not keep charging historical chats behind their back.
function maintenanceChats(env) {
  const allowed = allowedChats(env);
  if (!allowed.length) return [];
  const shared = sharingData(env);
  return shared ? [...new Set([shared, ...allowed])] : allowed;
}

function chatScope(env, column) {
  const chats = maintenanceChats(env);
  if (!chats.length) return { sql: ' AND 1 = 0', args: [] };
  return { sql: ` AND ${column} IN (${chats.map(() => '?').join(', ')})`, args: chats };
}

// Telegram refuses to delete a message that is already gone, which is the same
// outcome as deleting it, so the row goes on either of these.
const ALREADY_DELETED =
  /not found|MESSAGE_NOT_FOUND|can't be deleted|MESSAGE_ID_INVALID|message to delete not found/i;

// A row Telegram keeps failing on is kept and retried, but not forever: a day
// past its due time it is dropped anyway. These messages are about one day,
// so a call a minute for longer than that is not worth the message — and one
// wedged row would otherwise hold a place in every LIMIT 100 window from then
// on and starve the rows behind it.
const PURGE_GIVE_UP_MS = 24 * 60 * 60 * 1000;

async function purgeFinishedMessages(env, now) {
  let failures = 0;
  const scope = chatScope(env, 'chat_id');
  const { results } = await env.DB.prepare(
    `SELECT * FROM sent_messages WHERE delete_after <= ?${scope.sql}
     ORDER BY delete_after LIMIT 100`
  ).bind(now, ...scope.args).all();
  for (const row of results) {
    try {
      // Forgetting the row on a timeout or a 429 leaves the message in the chat
      // forever, so the row is only dropped once the message is actually gone.
      const outcome = row.is_ephemeral
        ? await deleteEphemeralMessage(env, row.chat_id, row.receiver_user_id, row.message_id)
        : await deleteMessage(env, row.chat_id, row.message_id);
      const gone = outcome.ok
        || ALREADY_DELETED.test(String(outcome.description || ''));
      if (gone || row.delete_after <= now - PURGE_GIVE_UP_MS) {
        await env.DB.prepare('DELETE FROM sent_messages WHERE id = ?').bind(row.id).run();
      } else {
        failures += 1;
      }
    } catch (error) {
      failures += 1;
      console.log(`Reminder cleanup ${row.id} failed: ${error.stack || error}`);
    }
  }
  return failures;
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
  let failures = 0;
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
        env, chatId, html, row.player_user_id, endOfLocalDay(row.starts_at, tz),
        { replyMarkup: OK_MARKUP }
      );

      if (outcome === 'private') continue;
      // Telegram will refuse this player every minute until the court starts,
      // and a claim handed back sorts straight to the front of the next
      // window's LIMIT. The claim stays spent: one line in the log is the whole
      // record, and the rest of the roster still gets reminded.
      if (outcome === 'refused') {
        console.log(
          `${column} reminder for player ${row.player_row_id} refused by Telegram; not retried`
        );
        continue;
      }
      if (outcome === 'not-ephemeral') {
        // Claim the rest of this roster so the public fallback is sent once.
        await env.DB.prepare(
          `UPDATE booking_players SET ${column}_sent = 1 WHERE booking_id = ?`
        ).bind(row.id).run();
        if (!(await remindPublicly(env, row, roster, headline, tz))) {
          await env.DB.prepare(
            `UPDATE booking_players SET ${column}_sent = 0 WHERE booking_id = ?`
          ).bind(row.id).run();
          failures += 1;
        }
        continue;
      }
      await env.DB.prepare(
        `UPDATE booking_players SET ${column}_sent = 0 WHERE id = ?`
      ).bind(row.player_row_id).run();
      failures += 1;
    } catch (error) {
      failures += 1;
      console.log(`${column} reminder for player ${row.player_row_id} failed: ${error.stack || error}`);
    }
  }
  return failures;
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

  let failures = 0;
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
        endOfLocalDay(booking.starts_at, tz), { replyMarkup: OK_MARKUP }
      );
      if (outcome === 'not-ephemeral') {
        if (!(await remindPublicly(env, booking, roster, headline, tz))) {
          await env.DB.prepare(`UPDATE bookings SET ${column}_sent = 0 WHERE id = ?`)
            .bind(booking.id).run();
          failures += 1;
        }
      } else if (outcome === 'failed') {
        // Only a transient failure is handed back. A refusal — blocked, gone,
        // never reachable — would come back the same every minute, so the flag
        // stays spent there, the same as on the roster path.
        await env.DB.prepare(`UPDATE bookings SET ${column}_sent = 0 WHERE id = ?`)
          .bind(booking.id).run();
        failures += 1;
      } else if (outcome === 'refused') {
        console.log(`${column} reminder ${booking.id} refused by Telegram; not retried`);
      }
    } catch (error) {
      failures += 1;
      console.log(`${column} reminder ${booking.id} failed: ${error.stack || error}`);
    }
  }
  return failures;
}

async function sendReminders(env, now, column, headline) {
  return (await sendClaimedReminders(env, now, column, headline))
    + (await remindRosterlessBookings(env, now, column, headline));
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
  let failures = 0;
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
        failures += 1;
        console.log(`Cleanup of booking ${booking.id} failed: ${error.stack || error}`);
      }
    }
    try {
      await updateBoard(env, chatId, now);
      if (charged) await updateTab(env, chatId);
    } catch (error) {
      failures += 1;
      console.log(`Pinned message refresh for chat ${chatId} failed: ${error.stack || error}`);
    }
  }
  return failures;
}

// "in 5 days" is only true on the day it was written. Nothing else touches a
// board that nobody books or joins, so each one is redrawn once per local day.
// The stamp is written before the redraw so a throw cannot turn into an
// every-minute retry — but only the current hour is claimed, not the whole
// day: a redraw that dies at the midnight tick (a deploy evicting the
// isolate, a Telegram hiccup) used to leave the countdown wrong until the
// next midnight, and one transient failure is not worth a day of lying.
// Success trades the hour stamp for the day's, which ends the retrying.
async function refreshStaleBoards(env, now) {
  let failures = 0;
  for (const chatId of allowedChats(env)) {
    try {
      const tz = await getTimezone(env, chatId);
      const parts = localParts(now, tz);
      const today = `${parts.y}-${parts.mo}-${parts.d}`;
      const attempt = `${today}~${parts.h}`;
      const setting = await env.DB.prepare(
        'SELECT board_message_id, board_day FROM settings WHERE chat_id = ?'
      ).bind(chatId).first();
      if (!setting || !setting.board_message_id) continue;
      if (setting.board_day === today || setting.board_day === attempt) continue;
      await env.DB.prepare('UPDATE settings SET board_day = ? WHERE chat_id = ?')
        .bind(attempt, chatId).run();
      await updateBoard(env, chatId);
      await env.DB.prepare('UPDATE settings SET board_day = ? WHERE chat_id = ?')
        .bind(today, chatId).run();
    } catch (error) {
      failures += 1;
      // One chat's dead board is its own problem; the others still redraw.
      console.log(`Daily board redraw for chat ${chatId} failed: ${error.stack || error}`);
    }
  }
  return failures;
}

async function flushPendingRefreshes(env) {
  const chats = allowedChats(env);
  if (!chats.length) return 0;
  const { results } = await env.DB.prepare(
    `SELECT * FROM pending_refreshes
     WHERE chat_id IN (${chats.map(() => '?').join(', ')})
     ORDER BY updated_at LIMIT 50`
  ).bind(...chats).all();
  let failures = 0;
  for (const row of results) {
    try {
      if (row.board) await updateBoard(env, row.chat_id);
      if (row.tab) await updateTab(env, row.chat_id);
      await env.DB.prepare('DELETE FROM pending_refreshes WHERE chat_id = ?')
        .bind(row.chat_id).run();
    } catch (error) {
      failures += 1;
      console.log(`Queued pinned refresh for chat ${row.chat_id} failed: ${error.stack || error}`);
    }
  }
  return failures;
}

// Once a month, everyone still owing hears their own total — in the group, as
// an ephemeral message only they can see, the same as every other private
// note. The bot doing the asking is the point: nobody has to be the naggy one.
// Delivery is claimed per debtor, so retries do not duplicate copies which
// already arrived. Nothing goes out before 9am local.
async function sendMonthlyTabNotices(env, now) {
  const chats = allowedChats(env);
  if (!chats.length) return 0;
  // One pass per set of books: the single shared ledger under DATA_CHAT_ID, or
  // each chat's own when nothing is shared. The old shape served only
  // chats[0], which silently skipped every other unshared chat's debtors.
  const dataChats = [...new Set(chats.map((chat) => dataChatId(env, chat)))];
  let failures = 0;
  for (const chatId of dataChats) {
    try {
      failures += Number(await sendMonthlyTabNoticesFor(
        env, now, chatId, chats.includes(chatId) ? chatId : chats[0]
      )) || 0;
    } catch (error) {
      failures += 1;
      console.log(`Monthly tab notices for chat ${chatId} failed: ${error.stack || error}`);
    }
  }
  return failures;
}

async function sendMonthlyTabNoticesFor(env, now, chatId, fallbackChat) {
  const tz = await getTimezone(env, chatId);
  const parts = localParts(now, tz);
  if (parts.h < 9) return;
  const month = `${parts.y}-${parts.mo}`;
  const setting = await env.DB.prepare(
    'SELECT nudged_month FROM settings WHERE chat_id = ?'
  ).bind(chatId).first();
  if (setting && setting.nudged_month === month) return;
  const monthName = new Intl.DateTimeFormat('en-SG', {
    timeZone: tz, month: 'long', year: 'numeric',
  }).format(new Date(now));
  const deleteAfter = endOfLocalDay(now, tz);
  let failures = 0;
  let pending = false;
  for (const entry of await tabBalances(env, chatId)) {
    // A row without a numeric id cannot be reached until that player posts
    // once; the pinned tab still names them.
    if (entry.balance <= 0) continue;
    if (!entry.user_id) {
      pending = true;
      continue;
    }
    // A cron overlap, deploy, or timeout may leave a row in "sending". Five
    // minutes later it is claimable again; delivered/refused rows are terminal.
    const claim = await env.DB.prepare(
      `INSERT INTO monthly_notice_deliveries
        (chat_id, month, slug, status, last_attempt_at, delivered_at, last_error)
       VALUES (?, ?, ?, 'sending', ?, NULL, NULL)
       ON CONFLICT(chat_id, month, slug) DO UPDATE SET
         status = 'sending', last_attempt_at = excluded.last_attempt_at, last_error = NULL
       WHERE monthly_notice_deliveries.status NOT IN ('delivered', 'refused')
         AND monthly_notice_deliveries.last_attempt_at <= ?`
    ).bind(chatId, month, entry.slug, now, now - 5 * 60 * 1000).run();
    if (!claim.meta.changes) {
      const delivery = await env.DB.prepare(
        `SELECT status FROM monthly_notice_deliveries
         WHERE chat_id = ? AND month = ? AND slug = ?`
      ).bind(chatId, month, entry.slug).first();
      if (!delivery || !['delivered', 'refused'].includes(delivery.status)) pending = true;
      continue;
    }
    // The ask arrives with its reasons: the same line-by-line story 🧾 My tab
    // tells, minus the rate card, so paying needs no second tap to trust.
    const { results: rows } = await env.DB.prepare(
      'SELECT * FROM ledger WHERE chat_id = ? AND slug = ? ORDER BY created_at, id'
    ).bind(chatId, entry.slug).all();
    const lines = [
      `💰 <b>Your squash tab — ${escapeHtml(monthName)}</b>`,
      ...breakdownLines(env, rows, tz, { pricing: false }),
    ];
    // An ephemeral message is only visible in the chat it is posted to, and
    // the data chat id may be no chat at all: aim for the chat this player
    // was last seated from, falling back to one the bot serves.
    const seat = await env.DB.prepare(
      'SELECT chat_id FROM booking_players WHERE user_id = ? ORDER BY id DESC LIMIT 1'
    ).bind(entry.user_id).first();
    const target = reachableChat(env, { chat_id: seat && seat.chat_id }, fallbackChat);
    const outcome = await sendPrivately(env, target, lines.join('\n'),
      entry.user_id, deleteAfter, { replyMarkup: OK_MARKUP });
    if (outcome === 'private' || outcome === 'refused') {
      await env.DB.prepare(
        `UPDATE monthly_notice_deliveries
         SET status = ?, delivered_at = ?, last_error = NULL
         WHERE chat_id = ? AND month = ? AND slug = ?`
      ).bind(
        outcome === 'private' ? 'delivered' : 'refused',
        outcome === 'private' ? now : null,
        chatId, month, entry.slug
      ).run();
      continue;
    }
    pending = true;
    failures += 1;
    await env.DB.prepare(
      `UPDATE monthly_notice_deliveries
       SET status = 'pending', last_error = ?
       WHERE chat_id = ? AND month = ? AND slug = ?`
    ).bind(`Telegram delivery ${outcome}`, chatId, month, entry.slug).run();
  }
  if (!pending) {
    await env.DB.prepare(
      `INSERT INTO settings (chat_id, nudged_month) VALUES (?, ?)
       ON CONFLICT(chat_id) DO UPDATE SET nudged_month = excluded.nudged_month`
    ).bind(chatId, month).run();
  }
  return failures;
}

export async function runMaintenance(env, now = Date.now()) {
  const stages = [
    ['availability announcements', () => maintainAnnouncements(env, now)],
    ['two-hour reminders', () => sendPreReminders(env, now)],
    ['queued pinned refreshes', () => flushPendingRefreshes(env)],
    ['board refresh', () => refreshStaleBoards(env, now)],
    ['monthly tab notices', () => sendMonthlyTabNotices(env, now)],
    ['day reminders', () => sendDueReminders(env, now)],
    ['message cleanup', () => purgeFinishedMessages(env, now)],
    ['booking cleanup', () => removeExpiredBookings(env, now)],
  ];
  const failures = [];
  for (const [name, run] of stages) {
    try {
      const count = Number(await run()) || 0;
      if (count) failures.push(`${name}: ${count} failed item${count === 1 ? '' : 's'}`);
    } catch (error) {
      failures.push(`${name}: ${error.message || error}`);
      console.log(`${name} maintenance failed: ${error.stack || error}`);
    }
  }
  return { ok: failures.length === 0, failures };
}

export function isSameLocalDay(a, b, tz) {
  const x = localParts(a, tz);
  const y = localParts(b, tz);
  return x.y === y.y && x.mo === y.mo && x.d === y.d;
}

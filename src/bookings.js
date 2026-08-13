import {
  clearRoster, defaultCapacity, DEFAULT_CAPACITY, identity, MAX_CAPACITY,
  rosterFor, rostersFor, seedRoster,
} from './players.js';
import { boardChats, dataChatId, reachableChat } from './scope.js';
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
  const sent = await sendMessage(env, chatId,
    `🎾 <b>${escapeHtml(court)} booked</b>\n` +
    `${formatDate(startsAt, tz)} · ${compactTimeRange(startsAt, endsAt, tz)}\n` +
    `👥 ${playerTags(roster)} · ${slotsLabel(roster, capacity)}`,
    {
      receiverUserId: from.id,
      callbackQueryId,
      replyMarkup: { inline_keyboard: [[{ text: '👍 OK', callback_data: 'sb:ok' }]] },
    }
  );
  // If OK is never tapped it still clears itself at the end of the day.
  if (sent.ok && sent.result) {
    await scheduleCleanup(env, chatId, sent.result, from.id, endOfLocalDay(startsAt, tz));
  }
}

export async function addBooking(
  env, chatId, parsed, from, sourceText = null,
  { allowConflict = false, callbackQueryId = null } = {}
) {
  const now = Date.now();
  const preReminderAt = parsed.startsAt - 2 * 60 * 60 * 1000;
  const preReminderSent = preReminderAt <= now ? 1 : 0;
  const capacity = defaultCapacity(env);
  const result = await env.DB.prepare(
    `INSERT INTO bookings
      (chat_id, court, starts_at, ends_at, reminder_at, pre_reminder_at,
       pre_reminder_sent, capacity, created_by_user_id, created_by_name, source_text, created_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
     WHERE ? = 1 OR NOT EXISTS (
       SELECT 1 FROM bookings
       WHERE chat_id = ? AND LOWER(TRIM(court)) = LOWER(TRIM(?))
         AND starts_at < ? AND ends_at > ?
     )`
  ).bind(
    dataChatId(env, chatId), parsed.court, parsed.startsAt, parsed.endsAt, parsed.reminderAt,
    preReminderAt, preReminderSent, capacity, from && from.id || null,
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
  await recordAudit(env, id, chatId, 'edited', from, sourceText, before, parsed);
  await updateBoard(env, chatId);
  return true;
}

export async function cancelBooking(env, chatId, id, from = null, sourceText = null) {
  const booking = await env.DB.prepare('SELECT * FROM bookings WHERE id = ? AND chat_id = ?')
    .bind(id, dataChatId(env, chatId)).first();
  if (!booking) return false;
  const result = await env.DB.prepare('DELETE FROM bookings WHERE id = ? AND chat_id = ?')
    .bind(id, dataChatId(env, chatId)).run();
  if (result.meta.changes) {
    // A cancelled booking is never played, so it never reaches the tab.
    await clearRoster(env, id);
    await recordAudit(env, id, chatId, 'deleted', from, sourceText, booking, null);
    await updateBoard(env, chatId);
  }
  return Boolean(result.meta.changes);
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
  const weekday = new Intl.DateTimeFormat('en-SG', {
    timeZone: tz, weekday: 'short',
  }).format(new Date(epochMs));
  if (days <= 0) return `today · ${weekday}`;
  if (days === 1) return `tomorrow · ${weekday}`;
  const date = new Intl.DateTimeFormat('en-SG', {
    timeZone: tz, day: 'numeric', month: 'short',
  }).format(new Date(epochMs));
  return `in ${days} days · ${weekday} ${date}`;
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

// Join buttons live on the pinned board so nobody has to scroll back to the
// announcement. The list is capped to keep the keyboard readable.
const MAX_JOIN_BUTTONS = 6;

function courtName(booking) {
  return booking.court.startsWith('Court ') ? booking.court : `Court ${booking.court}`;
}

function shortDate(epochMs, tz) {
  return new Intl.DateTimeFormat('en-SG', {
    timeZone: tz, weekday: 'short', day: 'numeric', month: 'short',
  }).format(new Date(epochMs));
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

function rosterLine(roster, capacity) {
  return `👥 ${playerTags(roster)} · ${slotsLabel(roster, capacity)}`;
}

// One compact row. Picking a specific court happens behind the join button, so
// the board does not grow a row per booking.
function defaultBoardButtons(bookings = []) {
  const row = [];
  if (bookings.length) row.push({ text: '🙋 Join', callback_data: 'sb:join' });
  row.push({ text: '➕ Add', callback_data: 'sb:add' });
  if (bookings.length) row.push({ text: '⚙️ Manage', callback_data: 'sb:manage' });
  return { inline_keyboard: [row] };
}

// The court list is built per person and sent only to them, so it can offer
// Join for courts they are not on and Leave for the ones they are. A shared
// keyboard on the pinned board could never tell the two apart.
export async function joinPickerView(env, chatId, from, now = Date.now()) {
  const bookings = (await activeBookings(env, chatId, now))
    .filter((booking) => booking.starts_at > now);
  if (!bookings.length) return null;
  const tz = await getTimezone(env, chatId);
  const rosters = await rostersFor(env, chatId, bookings.map((booking) => booking.id));
  const mySlug = identity(from).slug;

  const rows = [];
  for (const booking of bookings.slice(0, MAX_JOIN_BUTTONS)) {
    const roster = rosters.get(booking.id) || [];
    const capacity = booking.capacity || DEFAULT_CAPACITY;
    const label = `${shortDate(booking.starts_at, tz)} · ` +
      `${compactTimeRange(booking.starts_at, booking.ends_at, tz)} · ` +
      `${courtName(booking)} · ${slotsLabel(roster, capacity)}`;
    if (roster.some((player) => player.slug === mySlug)) {
      rows.push([{ text: `🚪 Leave · ${label}`, callback_data: `sb:leave:${booking.id}` }]);
    } else if (roster.length >= capacity) {
      rows.push([{ text: `🔒 Full · ${label}`, callback_data: `sb:full:${booking.id}` }]);
    } else {
      rows.push([{ text: `🙋 Join · ${label}`, callback_data: `sb:join:${booking.id}` }]);
    }
  }
  rows.push([{ text: '✕ Close', callback_data: 'sb:close' }]);
  return {
    html: '🎾 <b>Courts you can join</b>\n\nOnly you can see this list.',
    replyMarkup: { inline_keyboard: rows },
  };
}

async function renderBoard(env, chatId, now) {
  const tz = await getTimezone(env, chatId);
  const bookings = await activeBookings(env, chatId, now);
  if (!bookings.length) return { html: null, replyMarkup: null };
  const rosters = await rostersFor(env, chatId, bookings.map((booking) => booking.id));

  const lines = ['🎾 <b>Upcoming squash courts</b>', ''];
  for (const booking of bookings) {
    lines.push(
      `${formatCountdown(booking.starts_at, tz, now)} · ` +
      `${compactTimeRange(booking.starts_at, booking.ends_at, tz)} · ` +
      `<b>${escapeHtml(courtName(booking))}</b>`
    );
    lines.push(rosterLine(rosters.get(booking.id) || [], booking.capacity || DEFAULT_CAPACITY));
  }
  return {
    html: lines.join('\n'),
    replyMarkup: defaultBoardButtons(bookings),
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

function managerMarkup(bookings, tz) {
  const rows = bookings.map((booking) => [{
    text: `✏️ ${bookingLabel(booking, tz)}`,
    callback_data: `sb:pick:${booking.id}`,
  }]);
  rows.push([{ text: '➕ Add booking', callback_data: 'sb:add' }]);
  rows.push([{ text: '← Done', callback_data: 'sb:back' }]);
  return { inline_keyboard: rows };
}

export async function showBoardManager(env, chatId, messageId, now = Date.now()) {
  const bookings = await activeBookings(env, chatId, now);
  const tz = await getTimezone(env, chatId);
  return editReplyMarkup(env, chatId, messageId, managerMarkup(bookings, tz));
}

export async function showCancelConfirmation(env, chatId, messageId, bookingId) {
  const booking = await env.DB.prepare(
    'SELECT * FROM bookings WHERE id = ? AND chat_id = ? AND ends_at > ?'
  ).bind(bookingId, dataChatId(env, chatId), Date.now()).first();
  if (!booking) return false;
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
  if ((await rosterFor(env, booking.id)).length) {
    rows.push([{
      text: '🚪 Admin: remove a player', callback_data: `sb:kick:${booking.id}`,
    }]);
  }
  rows.push([{ text: '🗑 Delete booking', callback_data: `sb:delete:${booking.id}` }]);
  rows.push([{ text: '← Back to bookings', callback_data: 'sb:manage' }]);
  await editReplyMarkup(env, chatId, messageId, { inline_keyboard: rows });
  return true;
}

export async function showRemovePlayer(env, chatId, messageId, bookingId) {
  const booking = await env.DB.prepare(
    'SELECT * FROM bookings WHERE id = ? AND chat_id = ? AND ends_at > ?'
  ).bind(bookingId, dataChatId(env, chatId), Date.now()).first();
  if (!booking) return false;
  const roster = await rosterFor(env, bookingId);
  if (!roster.length) return false;
  const rows = roster.map((player) => [{
    text: `🚪 ${player.name}`,
    callback_data: `sb:kick:${bookingId}:${player.id}`,
  }]);
  rows.push([{ text: '← Back', callback_data: `sb:pick:${bookingId}` }]);
  await editReplyMarkup(env, chatId, messageId, { inline_keyboard: rows });
  return true;
}

// The person taken off is told privately. Nobody else needs the notification.
export async function notifyRemovedPlayer(env, chatId, player, booking) {
  if (!player.user_id) return;
  const tz = await getTimezone(env, chatId);
  await sendMessage(env, reachableChat(env, player, chatId),
    `🚪 You were taken off <b>${escapeHtml(courtName(booking))}</b> on ` +
    `${formatDate(booking.starts_at, tz)} · ${formatTime(booking.starts_at, tz)}.\n` +
    'Tap the 🙋 button on the pinned board if that was a mistake.',
    { receiverUserId: player.user_id });
}

export async function showDeleteConfirmation(env, chatId, messageId, bookingId) {
  const booking = await env.DB.prepare(
    'SELECT * FROM bookings WHERE id = ? AND chat_id = ? AND ends_at > ?'
  ).bind(bookingId, dataChatId(env, chatId), Date.now()).first();
  if (!booking) return false;
  const tz = await getTimezone(env, chatId);
  await editReplyMarkup(env, chatId, messageId, { inline_keyboard: [
    [{
      text: `🗑 Confirm delete · ${bookingLabel(booking, tz)}`,
      callback_data: `sb:cancel:${booking.id}`,
    }],
    [{ text: '← Keep booking', callback_data: `sb:pick:${booking.id}` }],
  ] });
  return true;
}

export async function restoreBoardButtons(env, chatId, messageId) {
  const bookings = await activeBookings(env, chatId);
  return editReplyMarkup(env, chatId, messageId, defaultBoardButtons(bookings));
}

function reminderHtml(booking, roster, headline, tz) {
  return `🎾 <b>${escapeHtml(headline)}</b>\n` +
    `${escapeHtml(courtName(booking))} · ${formatDate(booking.starts_at, tz)} · ` +
    `${compactTimeRange(booking.starts_at, booking.ends_at, tz)}` +
    (roster.length ? `\n👥 ${playerTags(roster)}` : '');
}

// Telegram falls back to an ordinary group message when it cannot deliver an
// ephemeral one, which for a roster would mean one public post per player. If
// that happens, the copy is deleted and the whole roster is told once, publicly,
// rather than the same reminder being shouted N times.
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

async function sendPrivateReminder(env, chatId, html, userId, deleteAfter) {
  const sent = await sendMessage(env, chatId, html, { receiverUserId: userId });
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
  // The roster line already tags everyone, so this needs nothing extra.
  const sent = await sendMessage(env, booking.chat_id, reminderHtml(booking, roster, headline, tz));
  if (sent.ok && sent.result) {
    await scheduleCleanup(
      env, booking.chat_id, sent.result, null, endOfLocalDay(booking.starts_at, tz)
    );
  }
  return sent.ok;
}

async function purgeFinishedMessages(env, now) {
  const { results } = await env.DB.prepare(
    'SELECT * FROM sent_messages WHERE delete_after <= ? ORDER BY delete_after LIMIT 100'
  ).bind(now).all();
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
  const { results } = await env.DB.prepare(
    `SELECT p.id AS player_row_id, p.user_id AS player_user_id, p.chat_id AS player_chat_id,
            b.*
     FROM booking_players AS p
     JOIN bookings AS b ON b.id = p.booking_id
     WHERE p.${column}_sent = 0 AND b.${column}_at <= ? AND b.starts_at > ?
     ORDER BY b.${column}_at, p.id LIMIT 200`
  ).bind(now, now).all();

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
      const outcome = await sendPrivateReminder(
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
  const { results } = await env.DB.prepare(
    `SELECT * FROM bookings AS b
     WHERE b.${column}_sent = 0 AND b.${column}_at <= ? AND b.starts_at > ?
       AND NOT EXISTS (SELECT 1 FROM booking_players WHERE booking_id = b.id)
     ORDER BY b.${column}_at LIMIT 100`
  ).bind(now, now).all();

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
      const outcome = await sendPrivateReminder(
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
  const { results: expired } = await env.DB.prepare(
    'SELECT * FROM bookings WHERE ends_at <= ? ORDER BY chat_id, id'
  ).bind(now).all();
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

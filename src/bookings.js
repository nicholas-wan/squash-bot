import { formatDate, formatTime, localParts } from './time.js';
import {
  deleteMessage, editMessage, editReplyMarkup, escapeHtml, mentionHtml,
  pinMessage, sendMessage, unpinMessage,
} from './telegram.js';

const DEFAULT_TZ = 'Asia/Singapore';

export async function getTimezone(env, chatId) {
  const row = await env.DB.prepare('SELECT tz FROM settings WHERE chat_id = ?').bind(chatId).first();
  return (row && row.tz) || env.DEFAULT_TIMEZONE || DEFAULT_TZ;
}

function ownerName(from) {
  if (!from) return null;
  return from.username ? `@${from.username}` : from.first_name || null;
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
    bookingId, chatId, action, from && from.id || null, ownerName(from),
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
  const args = [chatId, String(booking.court), booking.endsAt, booking.startsAt];
  if (excludeBookingId != null) args.push(excludeBookingId);
  return (await env.DB.prepare(query).bind(...args).all()).results;
}

async function announceBookingChange(env, chatId, booking, action) {
  const tz = await getTimezone(env, chatId);
  const startsAt = booking.startsAt ?? booking.starts_at;
  const endsAt = booking.endsAt ?? booking.ends_at;
  const court = booking.court.startsWith('Court ') ? booking.court : `Court ${booking.court}`;
  await sendMessage(env, chatId,
    `🎾 <b>${escapeHtml(court)} ${action}</b>\n` +
    `${formatDate(startsAt, tz)} · ${formatTime(startsAt, tz)}–${formatTime(endsAt, tz)}`
  );
}

export async function addBooking(
  env, chatId, parsed, from, sourceText = null, { allowConflict = false } = {}
) {
  const now = Date.now();
  const preReminderAt = parsed.startsAt - 2 * 60 * 60 * 1000;
  const preReminderSent = preReminderAt <= now ? 1 : 0;
  const result = await env.DB.prepare(
    `INSERT INTO bookings
      (chat_id, court, starts_at, ends_at, reminder_at, pre_reminder_at,
       pre_reminder_sent, created_by_user_id, created_by_name, source_text, created_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
     WHERE ? = 1 OR NOT EXISTS (
       SELECT 1 FROM bookings
       WHERE chat_id = ? AND LOWER(TRIM(court)) = LOWER(TRIM(?))
         AND starts_at < ? AND ends_at > ?
     )`
  ).bind(
    chatId, parsed.court, parsed.startsAt, parsed.endsAt, parsed.reminderAt,
    preReminderAt, preReminderSent, from && from.id || null,
    ownerName(from), sourceText, now, allowConflict ? 1 : 0,
    chatId, parsed.court, parsed.endsAt, parsed.startsAt
  ).run();
  if (!result.meta.changes) {
    throw new BookingConflictError(await findBookingConflicts(env, chatId, parsed));
  }
  await recordAudit(
    env, result.meta.last_row_id, chatId, 'added', from, sourceText, null, parsed
  );
  await updateBoard(env, chatId);
  await announceBookingChange(env, chatId, parsed, 'booked');
  return result.meta.last_row_id;
}

export async function updateBooking(
  env, chatId, id, parsed, from, sourceText = null, { allowConflict = false } = {}
) {
  const before = await env.DB.prepare('SELECT * FROM bookings WHERE id = ? AND chat_id = ?')
    .bind(id, chatId).first();
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
    preReminderAt <= now ? 1 : 0, id, chatId, allowConflict ? 1 : 0,
    chatId, parsed.court, parsed.endsAt, parsed.startsAt, id
  ).run();
  if (!result.meta.changes) {
    const conflicts = await findBookingConflicts(env, chatId, parsed, id);
    if (conflicts.length) throw new BookingConflictError(conflicts);
    return false;
  }
  await recordAudit(env, id, chatId, 'edited', from, sourceText, before, parsed);
  await updateBoard(env, chatId);
  await announceBookingChange(env, chatId, parsed, 'updated');
  return true;
}

export async function cancelBooking(env, chatId, id, from = null, sourceText = null) {
  const booking = await env.DB.prepare('SELECT * FROM bookings WHERE id = ? AND chat_id = ?')
    .bind(id, chatId).first();
  if (!booking) return false;
  const result = await env.DB.prepare('DELETE FROM bookings WHERE id = ? AND chat_id = ?')
    .bind(id, chatId).run();
  if (result.meta.changes) {
    await recordAudit(env, id, chatId, 'deleted', from, sourceText, booking, null);
    await updateBoard(env, chatId);
    await announceBookingChange(env, chatId, booking, 'removed');
  }
  return Boolean(result.meta.changes);
}

function clock(epochMs, tz) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(new Date(epochMs));
}

export function formatCountdown(epochMs, tz, now = Date.now()) {
  const target = localParts(epochMs, tz);
  const current = localParts(now, tz);
  const days = Math.round((
    Date.UTC(target.y, target.mo - 1, target.d)
    - Date.UTC(current.y, current.mo - 1, current.d)
  ) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'tomorrow';
  const date = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, month: 'short', day: 'numeric',
  }).format(new Date(epochMs));
  return `in ${days} days · ${date}`;
}

function compactTimeRange(startsAt, endsAt, tz) {
  const start = clock(startsAt, tz);
  const end = clock(endsAt, tz);
  const startPeriod = start.match(/\s([AP]M)$/);
  const endPeriod = end.match(/\s([AP]M)$/);
  if (startPeriod && endPeriod && startPeriod[1] === endPeriod[1]) {
    return `${start.replace(/\s[AP]M$/, '')}–${end}`;
  }
  return `${start}–${end}`;
}

async function activeBookings(env, chatId, now = Date.now()) {
  return (await env.DB.prepare(
    'SELECT * FROM bookings WHERE chat_id = ? AND ends_at > ? ORDER BY starts_at, court, id'
  ).bind(chatId, now).all()).results;
}

function defaultBoardButtons(hasBookings) {
  const row = [{ text: '➕ Add booking', callback_data: 'sb:add' }];
  if (hasBookings) row.push({ text: '⚙️ Manage bookings', callback_data: 'sb:manage' });
  return { inline_keyboard: [row] };
}

export async function boardHtml(env, chatId, now = Date.now()) {
  const tz = await getTimezone(env, chatId);
  const results = await activeBookings(env, chatId, now);
  if (!results.length) return null;

  const lines = ['🎾 <b>Upcoming squash courts</b>', ''];
  for (const booking of results) {
    const court = booking.court.startsWith('Court ') ? booking.court : `Court ${booking.court}`;
    lines.push(
      `${formatCountdown(booking.starts_at, tz, now)} · ` +
      `${compactTimeRange(booking.starts_at, booking.ends_at, tz)} · ` +
      `<b>${escapeHtml(court)}</b>`
    );
  }
  return lines.join('\n');
}

export async function updateBoard(env, chatId, now = Date.now()) {
  const setting = await env.DB.prepare('SELECT board_message_id FROM settings WHERE chat_id = ?')
    .bind(chatId).first();
  const existingId = setting && setting.board_message_id;
  const html = await boardHtml(env, chatId, now);

  if (!html) {
    if (existingId) {
      await unpinMessage(env, chatId, existingId);
      await deleteMessage(env, chatId, existingId);
      await env.DB.prepare('UPDATE settings SET board_message_id = NULL WHERE chat_id = ?')
        .bind(chatId).run();
    }
    return;
  }

  if (existingId) {
    const edited = await editMessage(env, chatId, existingId, html, defaultBoardButtons(true));
    if (edited.ok || String(edited.description || '').includes('message is not modified')) return;
  }

  const sent = await sendMessage(env, chatId, html, {
    silent: true, replyMarkup: defaultBoardButtons(true),
  });
  if (!sent.ok) throw new Error(`Could not create court board: ${sent.description || 'unknown Telegram error'}`);
  const pinned = await pinMessage(env, chatId, sent.result.message_id);
  if (!pinned.ok) {
    await deleteMessage(env, chatId, sent.result.message_id);
    throw new Error(`Could not pin court board: ${pinned.description || 'check the bot admin permissions'}`);
  }
  await env.DB.prepare(
    `INSERT INTO settings (chat_id, board_message_id) VALUES (?, ?)
     ON CONFLICT(chat_id) DO UPDATE SET board_message_id = excluded.board_message_id`
  ).bind(chatId, sent.result.message_id).run();
}

function bookingLabel(booking, tz) {
  const court = booking.court.startsWith('Court ') ? booking.court : `Court ${booking.court}`;
  const date = new Intl.DateTimeFormat('en-SG', {
    timeZone: tz, weekday: 'short', day: 'numeric', month: 'short',
  }).format(new Date(booking.starts_at));
  return `${court} · ${date} · ${formatTime(booking.starts_at, tz)}`;
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
  ).bind(bookingId, chatId, Date.now()).first();
  if (!booking) return false;
  const tz = await getTimezone(env, chatId);
  await editReplyMarkup(
    env, chatId, messageId, { inline_keyboard: [
      [{ text: `✏️ ${bookingLabel(booking, tz)}`, callback_data: `sb:pick:${booking.id}` }],
      [
        { text: '📅 Change date', callback_data: `sb:edit:${booking.id}:d` },
        { text: '🔢 Change court', callback_data: `sb:edit:${booking.id}:c` },
      ],
      [{ text: '🕐 Change time', callback_data: `sb:edit:${booking.id}:t` }],
      [{ text: '🗑 Delete booking', callback_data: `sb:delete:${booking.id}` }],
      [{ text: '← Back to bookings', callback_data: 'sb:manage' }],
    ] }
  );
  return true;
}

export async function showDeleteConfirmation(env, chatId, messageId, bookingId) {
  const booking = await env.DB.prepare(
    'SELECT * FROM bookings WHERE id = ? AND chat_id = ? AND ends_at > ?'
  ).bind(bookingId, chatId, Date.now()).first();
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
  return editReplyMarkup(env, chatId, messageId, defaultBoardButtons(bookings.length > 0));
}

async function sendDueReminders(env, now) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM bookings
     WHERE reminder_sent = 0 AND reminder_at <= ? AND starts_at > ?
     ORDER BY reminder_at LIMIT 100`
  ).bind(now, now).all();

  for (const booking of results) {
    try {
      const claim = await env.DB.prepare(
        'UPDATE bookings SET reminder_sent = 1 WHERE id = ? AND reminder_sent = 0'
      ).bind(booking.id).run();
      if (!claim.meta.changes) continue;
      const tz = await getTimezone(env, booking.chat_id);
      const who = mentionHtml(booking.created_by_user_id, booking.created_by_name || 'Squash player');
      const court = escapeHtml(booking.court.startsWith('Court ') ? booking.court : `Court ${booking.court}`);
      const sent = await sendMessage(env, booking.chat_id,
        `🎾 ${who}, squash today!\n<b>${court}</b> · ${formatTime(booking.starts_at, tz)}–${formatTime(booking.ends_at, tz)}`
      );
      if (!sent.ok) {
        await env.DB.prepare('UPDATE bookings SET reminder_sent = 0 WHERE id = ?').bind(booking.id).run();
      }
    } catch (error) {
      console.log(`Reminder ${booking.id} failed: ${error.stack || error}`);
    }
  }
}

async function sendPreReminders(env, now) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM bookings
     WHERE pre_reminder_sent = 0 AND pre_reminder_at <= ? AND starts_at > ?
     ORDER BY pre_reminder_at LIMIT 100`
  ).bind(now, now).all();

  for (const booking of results) {
    try {
      const claim = await env.DB.prepare(
        'UPDATE bookings SET pre_reminder_sent = 1 WHERE id = ? AND pre_reminder_sent = 0'
      ).bind(booking.id).run();
      if (!claim.meta.changes) continue;
      const tz = await getTimezone(env, booking.chat_id);
      const who = mentionHtml(booking.created_by_user_id, booking.created_by_name || 'Squash player');
      const court = escapeHtml(
        booking.court.startsWith('Court ') ? booking.court : `Court ${booking.court}`
      );
      const sent = await sendMessage(env, booking.chat_id,
        `🎾 ${who}, squash in 2 hours!\n` +
        `<b>${court}</b> · ${formatTime(booking.starts_at, tz)}–${formatTime(booking.ends_at, tz)}`
      );
      if (!sent.ok) {
        await env.DB.prepare(
          'UPDATE bookings SET pre_reminder_sent = 0 WHERE id = ?'
        ).bind(booking.id).run();
      }
    } catch (error) {
      console.log(`Two-hour reminder ${booking.id} failed: ${error.stack || error}`);
    }
  }
}

async function removeExpiredBookings(env, now) {
  const { results: expired } = await env.DB.prepare(
    'SELECT * FROM bookings WHERE ends_at <= ? ORDER BY chat_id, id'
  ).bind(now).all();
  const chatIds = [...new Set(expired.map((booking) => booking.chat_id))];
  for (const chatId of chatIds) {
    try {
      // Render without expired rows first. If Telegram fails, keep the rows so
      // the next minute retries the board cleanup.
      await updateBoard(env, chatId, now);
      for (const booking of expired.filter((row) => row.chat_id === chatId)) {
        const deleted = await env.DB.prepare(
          'DELETE FROM bookings WHERE id = ? AND chat_id = ? AND ends_at <= ?'
        ).bind(booking.id, chatId, now).run();
        if (deleted.meta.changes) {
          await recordAudit(
            env, booking.id, chatId, 'deleted', null, 'Expired automatically', booking, null
          );
        }
      }
    } catch (error) {
      console.log(`Cleanup for chat ${chatId} failed: ${error.stack || error}`);
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

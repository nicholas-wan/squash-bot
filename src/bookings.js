import { formatDate, formatTime, localParts } from './time.js';
import {
  deleteMessage, editEphemeralMessage, editMessage, escapeHtml, mentionHtml,
  pinMessage, sendMessage, unpinMessage,
} from './telegram.js';

const DEFAULT_TZ = 'Asia/Singapore';
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export async function getTimezone(env, chatId) {
  const row = await env.DB.prepare('SELECT tz FROM settings WHERE chat_id = ?').bind(chatId).first();
  return (row && row.tz) || env.DEFAULT_TIMEZONE || DEFAULT_TZ;
}

function ownerName(from) {
  if (!from) return null;
  return from.username ? `@${from.username}` : from.first_name || null;
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

export async function addBooking(env, chatId, parsed, from) {
  const result = await env.DB.prepare(
    `INSERT INTO bookings
      (chat_id, court, starts_at, ends_at, reminder_at, created_by_user_id, created_by_name, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    chatId, parsed.court, parsed.startsAt, parsed.endsAt, parsed.reminderAt,
    from && from.id || null, ownerName(from), Date.now()
  ).run();
  await updateBoard(env, chatId);
  await announceBookingChange(env, chatId, parsed, 'booked');
  return result.meta.last_row_id;
}

export async function cancelBooking(env, chatId, id) {
  const booking = await env.DB.prepare('SELECT * FROM bookings WHERE id = ? AND chat_id = ?')
    .bind(id, chatId).first();
  if (!booking) return false;
  const result = await env.DB.prepare('DELETE FROM bookings WHERE id = ? AND chat_id = ?')
    .bind(id, chatId).run();
  if (result.meta.changes) {
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

// Same hybrid countdown used by NagBot's pinned dashboard.
export function formatCountdown(epochMs, tz, now = Date.now()) {
  const target = localParts(epochMs, tz);
  const current = localParts(now, tz);
  const days = Math.round((
    Date.UTC(target.y, target.mo - 1, target.d)
    - Date.UTC(current.y, current.mo - 1, current.d)
  ) / 86400000);
  const time = clock(epochMs, tz);
  if (days <= 0) return `today ${time}`;
  if (days === 1) return `tomorrow ${time}`;
  const weekday = DAY_NAMES[new Date(Date.UTC(target.y, target.mo - 1, target.d)).getUTCDay()];
  const absolute = days < 7 ? `${weekday} ${time}` : new Intl.DateTimeFormat('en-US', {
    timeZone: tz, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(new Date(epochMs));
  return `in ${days} days · ${absolute}`;
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
    lines.push(
      `${formatCountdown(booking.starts_at, tz, now)} · <b>${escapeHtml(booking.court.startsWith('Court ') ? booking.court : `Court ${booking.court}`)}</b>`,
      `      <i>${formatDate(booking.starts_at, tz)} · ${formatTime(booking.starts_at, tz)}–${formatTime(booking.ends_at, tz)}</i>`
    );
    lines.push('');
  }
  return lines.join('\n').trimEnd();
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

function managerMarkup(bookings) {
  const rows = bookings.map((booking) => [{
    text: `✏️ #${booking.id} · ${booking.court.startsWith('Court ') ? booking.court : `Court ${booking.court}`}`,
    callback_data: `sb:pick:${booking.id}`,
  }]);
  rows.push([{ text: '➕ Add booking', callback_data: 'sb:add' }]);
  rows.push([{ text: '✕ Close', callback_data: 'sb:close' }]);
  return { inline_keyboard: rows };
}

export async function showBoardManager(
  env, chatId, receiverUserId, callbackQueryId, ephemeralMessageId = null,
  now = Date.now(), noticeHtml = ''
) {
  const bookings = await activeBookings(env, chatId, now);
  const body = bookings.length
    ? '⚙️ <b>Manage squash bookings</b>\n\nSelect a booking to cancel it.'
    : '⚙️ <b>Manage squash bookings</b>\n\nThere are no upcoming bookings.';
  const html = noticeHtml ? `${noticeHtml}\n\n${body}` : body;
  const replyMarkup = managerMarkup(bookings);
  if (ephemeralMessageId) {
    return editEphemeralMessage(
      env, chatId, receiverUserId, ephemeralMessageId, html, replyMarkup
    );
  }
  return sendMessage(env, chatId, html, {
    receiverUserId, callbackQueryId, replyMarkup,
  });
}

export async function showCancelConfirmation(
  env, chatId, receiverUserId, ephemeralMessageId, bookingId
) {
  const booking = await env.DB.prepare(
    'SELECT * FROM bookings WHERE id = ? AND chat_id = ? AND ends_at > ?'
  ).bind(bookingId, chatId, Date.now()).first();
  if (!booking) return false;
  const court = booking.court.startsWith('Court ') ? booking.court : `Court ${booking.court}`;
  await editEphemeralMessage(
    env, chatId, receiverUserId, ephemeralMessageId,
    `🗑 <b>Cancel booking #${booking.id}?</b>\n\n${escapeHtml(court)}`,
    { inline_keyboard: [
      [{ text: `🗑 Yes, cancel #${booking.id}`, callback_data: `sb:cancel:${booking.id}` }],
      [{ text: '← Back to bookings', callback_data: 'sb:manage' }],
    ] }
  );
  return true;
}

export async function closeManager(env, chatId, receiverUserId, ephemeralMessageId) {
  return editEphemeralMessage(
    env, chatId, receiverUserId, ephemeralMessageId,
    '✓ <i>Booking manager closed.</i>', { inline_keyboard: [] }
  );
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

async function removeExpiredBookings(env, now) {
  const { results } = await env.DB.prepare(
    'SELECT DISTINCT chat_id FROM bookings WHERE ends_at <= ?'
  ).bind(now).all();
  for (const { chat_id: chatId } of results) {
    try {
      // Render without expired rows first. If Telegram fails, keep the rows so
      // the next minute retries the board cleanup.
      await updateBoard(env, chatId, now);
      await env.DB.prepare('DELETE FROM bookings WHERE chat_id = ? AND ends_at <= ?')
        .bind(chatId, now).run();
    } catch (error) {
      console.log(`Cleanup for chat ${chatId} failed: ${error.stack || error}`);
    }
  }
}

export async function runMaintenance(env, now = Date.now()) {
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

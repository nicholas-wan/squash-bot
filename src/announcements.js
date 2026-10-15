import { compactTimeRange, courtName, formatCountdown, playerTags } from './format.js';
import { allowedChats, dataChatId } from './scope.js';
import { DEFAULT_CAPACITY, rosterFor } from './players.js';
import { getTimezone } from './settings.js';
import { deleteMessage, editMessage, escapeHtml, sendMessage } from './telegram.js';

// One silent message per group, always about the earliest upcoming court with a
// free slot. Slot counts and edits to that court change the message in place;
// a nearer court appearing, or the current one filling, starting, or being
// cancelled, retires the message and posts a fresh one for whichever court is
// next. So the bot's latest message is always the most upcoming open court,
// and a batch of new bookings produces one message rather than one each.

const CLOSED_TEXT = '🎾 This court is no longer open. See the pinned board.';

// True when the message is gone. Telegram lets a bot delete its own messages
// for 48 hours; after that it needs the Delete Messages admin right, and
// without it the message stays. The caller keeps such a message and edits it
// in place rather than leaving a stub behind every retired announcement.
async function deleteAnnouncement(env, chatId, messageId) {
  const removed = await deleteMessage(env, chatId, messageId);
  if (removed.ok || /message to delete not found/i.test(removed.description || '')) return true;
  if (/message can.t be deleted/i.test(removed.description || '')) return false;
  throw new Error(removed.description || 'Announcement deletion failed');
}

async function closeAnnouncement(env, chatId, messageId) {
  const closed = await editMessage(env, chatId, messageId, CLOSED_TEXT, { inline_keyboard: [] });
  if (!closed.ok && !/message is not modified/i.test(closed.description || '')) {
    throw new Error(closed.description || 'Announcement retirement failed');
  }
}

async function nextOpenBooking(env, chatId, now) {
  const booking = await env.DB.prepare(`SELECT b.* FROM bookings b
    WHERE b.chat_id = ? AND b.starts_at > ?
      AND b.capacity > (SELECT COALESCE(SUM(p.heads), 0)
        FROM booking_players p WHERE p.booking_id = b.id)
    ORDER BY b.starts_at, b.id LIMIT 1`).bind(dataChatId(env, chatId), now).first();
  if (!booking) return null;
  const roster = await rosterFor(env, booking.id);
  const capacity = booking.capacity || DEFAULT_CAPACITY;
  const free = capacity - roster.reduce((sum, player) => sum + (player.heads || 1), 0);
  // The roster can fill between the two reads; the next sync sees the change.
  return free > 0 ? { booking, capacity, free, roster } : null;
}

export async function syncAnnouncements(env, chatId, now = Date.now()) {
  await env.DB.prepare('INSERT OR IGNORE INTO availability_notices (chat_id) VALUES (?)')
    .bind(chatId).run();
  // Serialize webhook/cron sends for this chat. Expiry recovers a dead worker.
  const lease = Date.now() + 60000;
  const claimed = await env.DB.prepare(`UPDATE availability_notices SET lease_until = ?
    WHERE chat_id = ? AND lease_until <= ?`).bind(lease, chatId, Date.now()).run();
  if (!claimed.meta.changes) return 0;
  try {
    const current = await env.DB.prepare('SELECT * FROM availability_notices WHERE chat_id = ?')
      .bind(chatId).first() || { booking_id: null, message_id: null, html: null };
    const next = await nextOpenBooking(env, chatId, now);
    if (current.message_id && current.booking_id !== (next?.booking.id ?? null)) {
      // The tracked court is no longer the one to point at. Whether it filled,
      // started, was cancelled, or was overtaken by a nearer booking, the
      // message goes so that a fresh one can land at the bottom of the chat.
      // A message Telegram will not delete is kept and rewritten in place
      // instead: one long-lived message beats a trail of retired ones.
      const deleted = await deleteAnnouncement(env, chatId, current.message_id);
      if (deleted) {
        await env.DB.prepare(`UPDATE availability_notices
          SET message_id = NULL, html = NULL, booking_id = NULL WHERE chat_id = ?`).bind(chatId).run();
        current.message_id = null;
        current.html = null;
      } else {
        await env.DB.prepare('UPDATE availability_notices SET booking_id = NULL WHERE chat_id = ?')
          .bind(chatId).run();
      }
      current.booking_id = null;
    }
    if (!next) {
      if (current.message_id && current.html !== CLOSED_TEXT) {
        await closeAnnouncement(env, chatId, current.message_id);
        await env.DB.prepare('UPDATE availability_notices SET html = ? WHERE chat_id = ?')
          .bind(CLOSED_TEXT, chatId).run();
      }
      return 0;
    }
    const { booking, capacity, free, roster } = next;
    const tz = await getTimezone(env, chatId);
    const html = '🎾 <b>Next available court</b>\n\n'
      + `${formatCountdown(booking.starts_at, tz, now)}\n`
      + `${compactTimeRange(booking.starts_at, booking.ends_at, tz)} · `
      + `<b>${escapeHtml(courtName(booking))}</b> · `
      + `${free} slot${free === 1 ? '' : 's'} · ${capacity - free}/${capacity}\n`
      // Who is already on it, so "should I join" can be answered from the
      // message itself. The booker stays off: the roster is the news.
      + `👥 ${playerTags(roster)}`;
    // The keyboard is shared, so the admin row is drawn for everyone; the
    // routes behind it refuse a member with a toast. Both open the same
    // private pickers Manage reaches, one tap from the court in question
    // rather than four taps in.
    const replyMarkup = { inline_keyboard: [
      [{ text: '🙋 Join', callback_data: `sb:join:${booking.id}` }],
      [
        { text: '➕ Admin: add', callback_data: `sb:addp:${booking.id}` },
        { text: '➖ Admin: remove', callback_data: `sb:kick:${booking.id}` },
      ],
    ] };
    // What is stored is the whole rendering, keyboard included, so a change
    // to the buttons alone still reaches a message whose text is unchanged.
    const signature = `${html}\n${JSON.stringify(replyMarkup)}`;
    if (current.message_id && current.html === signature) return 0;
    if (current.message_id) {
      const edited = await editMessage(env, chatId, current.message_id, html, replyMarkup);
      if (edited.ok || /message is not modified/i.test(edited.description || '')) {
        // booking_id moves too: a kept message may now show a different court.
        await env.DB.prepare('UPDATE availability_notices SET booking_id = ?, html = ? WHERE chat_id = ?')
          .bind(booking.id, signature, chatId).run();
        return 0;
      }
      if (!/message to edit not found/i.test(edited.description || '')) {
        throw new Error(edited.description || 'Announcement edit failed');
      }
    }
    const sent = await sendMessage(env, chatId, html, { silent: true, replyMarkup });
    if (!sent.ok || !sent.result?.message_id) {
      throw new Error(sent.description || 'Announcement send failed');
    }
    try {
      await env.DB.prepare(`UPDATE availability_notices SET booking_id = ?, message_id = ?, html = ?
        WHERE chat_id = ?`).bind(booking.id, sent.result.message_id, signature, chatId).run();
    } catch (error) {
      // Telegram has already accepted this message. Remove it if persistence
      // failed, otherwise a retry could leave an untracked public duplicate.
      try {
        if (!await deleteAnnouncement(env, chatId, sent.result.message_id)) {
          await closeAnnouncement(env, chatId, sent.result.message_id);
        }
      } catch (cleanupError) {
        console.log(`Untracked announcement ${chatId}/${sent.result.message_id}: ${cleanupError.message}`);
      }
      throw error;
    }
    return 0;
  } catch (error) {
    console.log(`Announcement for ${chatId} failed: ${error.message || error}`);
    return 1;
  } finally {
    await env.DB.prepare(`UPDATE availability_notices SET lease_until = 0
      WHERE chat_id = ? AND lease_until = ?`).bind(chatId, lease).run();
  }
}

export async function maintainAnnouncements(env, now) {
  let failures = 0;
  for (const chatId of allowedChats(env)) {
    try { failures += await syncAnnouncements(env, chatId, now); }
    catch (error) {
      failures += 1;
      console.log(`Announcements for ${chatId} failed: ${error.message || error}`);
    }
  }
  return failures;
}

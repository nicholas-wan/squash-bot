import { compactTimeRange, courtName, formatCountdown, playerTags } from './format.js';
import { allowedChats, dataChatId } from './scope.js';
import { DEFAULT_CAPACITY, rosterFor } from './players.js';
import { miniAppLink } from './miniapp-link.js';
import { getTimezone, pinnedIds } from './settings.js';
import { deleteMessage, editMessage, escapeHtml, sendMessage } from './telegram.js';

// One silent message per group, always about the earliest upcoming court with a
// free slot. Slot counts and edits to that court change the message in place;
// a nearer court appearing, or the current one filling, starting, or being
// cancelled, retires the message and posts a fresh one for whichever court is
// next. So the bot's latest message is always the most upcoming open court,
// and a batch of new bookings produces one message rather than one each.

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

// What a kept message says once there is no open court to show. It used to
// name the court it had announced, marked played, full or cancelled, which
// read as the court still on offer. Now it says plainly that nothing is open,
// and is rewritten in place for the next court that opens.
export const NO_COURTS_HTML = '🎾 <b>No courts available</b>';

// False when the message is already gone, so the caller can stop tracking it.
async function closeAnnouncement(env, chatId, messageId, text) {
  const closed = await editMessage(env, chatId, messageId, text, { inline_keyboard: [] });
  if (closed.ok || /message is not modified/i.test(closed.description || '')) return true;
  if (/message to edit not found/i.test(closed.description || '')) return false;
  throw new Error(closed.description || 'Announcement retirement failed');
}

// The court and its roster are read together: the roster query finds the
// same court by itself, so neither waits for the other.
const NEXT_OPEN = `SELECT b.* FROM bookings b
    WHERE b.chat_id = ? AND b.starts_at > ?
      AND b.capacity > (SELECT COALESCE(SUM(p.heads), 0)
        FROM booking_players p WHERE p.booking_id = b.id)
    ORDER BY b.starts_at, b.id LIMIT 1`;

async function nextOpenBooking(env, chatId, now) {
  const dataChat = dataChatId(env, chatId);
  const [booking, players] = await Promise.all([
    env.DB.prepare(NEXT_OPEN).bind(dataChat, now).first(),
    // Says which court it chose: one row with no player for a court nobody
    // is on, and no rows at all when it found no court.
    env.DB.prepare(`SELECT n.id AS next_id, p.* FROM (${NEXT_OPEN}) AS n
      LEFT JOIN booking_players AS p ON p.booking_id = n.id ORDER BY p.id`)
      .bind(dataChat, now).all(),
  ]);
  if (!booking) return null;
  // Both reads name the same court unless a change landed between them; then
  // the roster is read again for the court that was found.
  const rows = (players && players.results) || [];
  const same = rows.length > 0 && rows.every((row) => row.next_id === booking.id);
  const roster = same
    ? rows.filter((row) => row.booking_id != null).map(({ next_id: _, ...player }) => player)
    : await rosterFor(env, booking.id);
  const capacity = booking.capacity || DEFAULT_CAPACITY;
  const free = capacity - roster.reduce((sum, player) => sum + (player.heads || 1), 0);
  // The roster can fill between the two reads; the next sync sees the change.
  return free > 0 ? { booking, capacity, free, roster } : null;
}

// `known.pinned` is the chat's pinned ids when the caller has them already, as
// a board redraw does.
export async function syncAnnouncements(env, chatId, now = Date.now(), known = {}) {
  // Serialize webhook/cron sends for this chat. Expiry recovers a dead worker.
  // One round trip creates the row if need be, claims the lease, and reads the
  // row back; no row comes back while another worker holds the lease.
  const lease = Date.now() + 60000;
  // The reads go out with the claim rather than after it: they only decide
  // what to send, and are dropped unread when the lease is somebody else's.
  // The timezone is only needed when there is a court to announce, but it is
  // usually cached, and fetching it alongside costs no extra wall clock.
  const [claimed, ...reads] = await Promise.allSettled([
    env.DB.prepare(`INSERT INTO availability_notices (chat_id, lease_until)
      VALUES (?, ?) ON CONFLICT(chat_id) DO UPDATE SET lease_until = excluded.lease_until
      WHERE availability_notices.lease_until <= ? RETURNING *`)
      .bind(chatId, lease, Date.now()).first(),
    nextOpenBooking(env, chatId, now),
    known.pinned !== undefined ? known.pinned : pinnedIds(env, chatId),
    getTimezone(env, chatId),
  ]);
  if (claimed.status === 'rejected') throw claimed.reason;
  const current = claimed.value;
  if (!current) return 0;
  // The last write of a pass gives the lease back in the same statement, so
  // the finally below has nothing left to do.
  let released = false;
  const RELEASE = 'lease_until = CASE WHEN lease_until = ? THEN 0 ELSE lease_until END';
  try {
    // A read that failed beside a claim that held: thrown inside the try, so
    // the lease is still given back.
    const failed = reads.find((read) => read.status === 'rejected');
    if (failed) throw failed.reason;
    const [next, pinned, tz] = reads.map((read) => read.value);
    // Message ids only grow within a chat, so a pinned board or tab with a
    // higher id was posted after this message and sits below it. The bot's
    // last word is meant to be the next open court; one buried under a freshly
    // posted board reads as stale, so it is retired and posted again.
    const buried = Boolean(current.message_id) && current.message_id
      < Math.max(Number(pinned?.board_message_id) || 0, Number(pinned?.tab_message_id) || 0);
    if (current.message_id && (buried || current.booking_id !== (next?.booking.id ?? null))) {
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
        current.booking_id = null;
      }
    }
    if (!next) {
      // Nothing to point at and no way to remove the message: say so, once.
      // booking_id is cleared, so later sweeps leave it alone until a court
      // opens and the message is rewritten for that one. A message closed
      // before this text existed still names its old court, and is caught
      // here too because its stored rendering differs.
      if (current.message_id && current.html !== NO_COURTS_HTML) {
        const kept = await closeAnnouncement(env, chatId, current.message_id, NO_COURTS_HTML);
        await env.DB.prepare(`UPDATE availability_notices SET booking_id = NULL, html = ?,
          message_id = ?, ${RELEASE} WHERE chat_id = ?`)
          .bind(kept ? NO_COURTS_HTML : null, kept ? current.message_id : null, lease, chatId).run();
        released = true;
      } else if (current.booking_id !== null) {
        await env.DB.prepare(`UPDATE availability_notices SET booking_id = NULL, ${RELEASE}
          WHERE chat_id = ?`).bind(lease, chatId).run();
        released = true;
      }
      return 0;
    }
    const { booking, free, roster } = next;
    // An invitation, not a listing: the pinned board is the schedule, and this
    // used to repeat one of its lines under a near-identical heading. It leads
    // with the one thing it is for — a slot you can take — then when, then who
    // is already on it, so "should I join" is answered from the message
    // itself. The booker stays off: the roster is the news.
    const when = formatCountdown(booking.starts_at, tz, now);
    const html = `🙋 <b>${free} slot${free === 1 ? '' : 's'} left on `
      + `${escapeHtml(courtName(booking))}</b>\n`
      + `${when.charAt(0).toUpperCase()}${when.slice(1)} · `
      + `${compactTimeRange(booking.starts_at, booking.ends_at, tz)}\n`
      + (roster.length ? `Playing: ${playerTags(roster)}` : 'Nobody on it yet.');
    // The keyboard is shared, so the admin row is drawn for everyone; what is
    // behind it refuses a member. With the Mini App registered it is one
    // button that opens this court's screen over the chat, where seating and
    // removing sit side by side. Without it, both open the same private
    // pickers Manage reaches, one tap from the court rather than four taps in.
    const app = miniAppLink(env, chatId, booking.id);
    const replyMarkup = { inline_keyboard: [
      [{ text: '🙋 Join', callback_data: `sb:join:${booking.id}` }],
      app
        ? [{ text: '⚙️ Admin: add / remove', url: app }]
        : [
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
        await env.DB.prepare(`UPDATE availability_notices SET booking_id = ?, html = ?, ${RELEASE}
          WHERE chat_id = ?`).bind(booking.id, signature, lease, chatId).run();
        released = true;
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
      await env.DB.prepare(`UPDATE availability_notices SET booking_id = ?, message_id = ?, html = ?,
        ${RELEASE} WHERE chat_id = ?`)
        .bind(booking.id, sent.result.message_id, signature, lease, chatId).run();
      released = true;
    } catch (error) {
      // Telegram has already accepted this message. Remove it if persistence
      // failed, otherwise a retry could leave an untracked public duplicate.
      try {
        // A message seconds old is always deletable; the close is a last resort.
        if (!await deleteAnnouncement(env, chatId, sent.result.message_id)) {
          await closeAnnouncement(env, chatId, sent.result.message_id, html);
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
    if (!released) {
      await env.DB.prepare(`UPDATE availability_notices SET lease_until = 0
        WHERE chat_id = ? AND lease_until = ?`).bind(chatId, lease).run();
    }
  }
}

// Each chat has its own lease and its own message, so they sync side by side:
// the sweep takes as long as the slowest chat rather than the sum of them all.
export async function maintainAnnouncements(env, now) {
  const results = await Promise.all(allowedChats(env).map(async (chatId) => {
    try { return await syncAnnouncements(env, chatId, now); }
    catch (error) {
      console.log(`Announcements for ${chatId} failed: ${error.message || error}`);
      return 1;
    }
  }));
  return results.reduce((sum, failures) => sum + failures, 0);
}

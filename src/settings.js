import { deleteMessage, editMessage, pinMessage, sendMessage, unpinMessage } from './telegram.js';

const DEFAULT_TZ = 'Asia/Singapore';
// Must match the DEFAULT on settings.tz in schema.sql.
const SCHEMA_DEFAULT_TZ = 'Asia/Singapore';
const PINNED_COLUMNS = new Set(['board_message_id', 'tab_message_id']);

// Telegram's way of saying the pinned message is beyond editing: somebody
// deleted it, or the bot was kicked and re-added and no longer owns it. Only
// those answers justify sending a replacement, because a supergroup allows many
// pins and the old one is still live — so a fresh send after a failure
// that was merely transient (a 429, a 5xx, the fifteen-second timeout in
// telegram(), which comes back as a description too) leaves a second board
// pinned while the first stays up forever as a stale zombie nobody edits again.
// Everything else is therefore thrown and left to the caller, which already
// logs a sibling chat's failure and rethrows the acting chat's.
const GONE_DESCRIPTIONS = [
  'message to edit not found',
  "message can't be edited",
  'message can’t be edited',
  'message not found',
  'message_id_invalid',
];

function editTargetIsGone(description) {
  const text = String(description || '').toLowerCase();
  return GONE_DESCRIPTIONS.some((phrase) => text.includes(phrase));
}

// What a pinned message says when there is nothing to show but Telegram will
// not let the bot delete it.
const EMPTY_HTML = {
  board_message_id: '📌 <b>Court schedule</b>\n\nNo courts booked.',
  tab_message_id: '💰 <b>Squash tab</b>\n\nEveryone is settled.',
};

// Takes an empty board or settled tab down. True when the message is gone and
// its id can be forgotten. The id used to be forgotten whatever Telegram said,
// so a message it refused to delete — older than 48 hours, in a group where
// the bot lacks the Delete Messages right — stayed in the chat showing its
// last courts, and the next booking pinned a second board beside it. Such a
// message is now kept pinned, rewritten to say there is nothing to show, and
// edited in place when there is again, as the availability message is. A
// failure that is merely transient is thrown, keeping the id, so the queued
// refresh tries again rather than leaving a stale board behind.
async function removePinned(env, chatId, column, messageId, label) {
  const removed = await deleteMessage(env, chatId, messageId);
  const description = String(removed.description || '');
  if (removed.ok || /message to delete not found/i.test(description)) return true;
  if (!/message can.t be deleted/i.test(description)) {
    throw new Error(`Could not remove ${label}: ${description || 'unknown Telegram error'}`);
  }
  const edited = await editMessage(env, chatId, messageId, EMPTY_HTML[column]);
  if (edited.ok || /message is not modified/i.test(edited.description || '')) return false;
  if (editTargetIsGone(edited.description)) {
    // Gone after all, or kept but beyond editing: unpinned, so that whatever
    // is left cannot pass for the current one.
    await unpinMessage(env, chatId, messageId);
    return true;
  }
  throw new Error(`Could not clear ${label}: ${edited.description || 'unknown Telegram error'}`);
}

// The timezone is a D1 query on nearly every code path, often several times per
// update, and the answer changes approximately never — nothing writes tz today.
// Cached per database handle rather than globally, so tests and local adapters
// with their own DB never read another's answer, and a redeployed isolate
// starts clean.
const TZ_CACHE_TTL_MS = 5 * 60 * 1000;
const tzCache = new WeakMap();

// The settings row is created by pinning a board, which never writes tz, so the
// column falls to its NOT NULL default. Reading that default back as a per-chat
// choice would silently retire DEFAULT_TIMEZONE the moment a chat pins anything,
// so it counts as unset here and only a tz written on purpose outranks the env.
export async function getTimezone(env, chatId) {
  let perDb = tzCache.get(env.DB);
  if (!perDb) tzCache.set(env.DB, (perDb = new Map()));
  const cached = perDb.get(chatId);
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    return cached.chosen || env.DEFAULT_TIMEZONE || DEFAULT_TZ;
  }
  const row = await env.DB.prepare('SELECT tz FROM settings WHERE chat_id = ?').bind(chatId).first();
  const chosen = row && row.tz !== SCHEMA_DEFAULT_TZ ? row.tz : null;
  // Only the database's answer is cached; the env fallback stays live so a
  // redeployed DEFAULT_TIMEZONE is honoured without waiting out the TTL.
  perDb.set(chatId, { chosen, expiresAt: now + TZ_CACHE_TTL_MS });
  return chosen || env.DEFAULT_TIMEZONE || DEFAULT_TZ;
}

// The ids of the chat's pinned board and tab: the settings row, or null.
export async function pinnedIds(env, chatId) {
  return env.DB.prepare(
    'SELECT board_message_id, tab_message_id FROM settings WHERE chat_id = ?'
  ).bind(chatId).first();
}

// Keeps one pinned message per column in sync. A null html removes the pin
// entirely, so an empty board or a settled tab leaves no clutter behind.
// `existing` is the chat's settings row when the caller has just read it with
// pinnedIds (null for no row), which spares this a read of its own.
export async function updatePinnedMessage(env, chatId, column, html, replyMarkup, label, options = {}) {
  if (!PINNED_COLUMNS.has(column)) throw new Error(`Unknown pinned column: ${column}`);
  const setting = 'existing' in options ? options.existing : await pinnedIds(env, chatId);
  const existingId = setting && setting[column];

  if (!html) {
    if (existingId && await removePinned(env, chatId, column, existingId, label)) {
      await env.DB.prepare(`UPDATE settings SET ${column} = NULL WHERE chat_id = ?`)
        .bind(chatId).run();
    }
    // Null either way: there is nothing to show, even when an old message is
    // kept pinned saying so.
    return null;
  }

  if (existingId) {
    const edited = await editMessage(env, chatId, existingId, html, replyMarkup);
    if (edited.ok || String(edited.description || '').includes('message is not modified')) {
      return existingId;
    }
    if (!editTargetIsGone(edited.description)) {
      throw new Error(
        `Could not update ${label}: ${edited.description || 'unknown Telegram error'}`
      );
    }
    // One that still exists but cannot be edited (the bot was kicked and
    // re-added) would otherwise stay pinned beside its replacement. Best
    // effort: for a deleted message there is nothing to unpin.
    await unpinMessage(env, chatId, existingId);
  }

  const sent = await sendMessage(env, chatId, html, { silent: true, replyMarkup });
  if (!sent.ok) {
    throw new Error(`Could not create ${label}: ${sent.description || 'unknown Telegram error'}`);
  }
  const pinned = await pinMessage(env, chatId, sent.result.message_id);
  if (!pinned.ok) {
    await deleteMessage(env, chatId, sent.result.message_id);
    throw new Error(`Could not pin ${label}: ${pinned.description || 'check the bot admin permissions'}`);
  }
  await env.DB.prepare(
    `INSERT INTO settings (chat_id, ${column}) VALUES (?, ?)
     ON CONFLICT(chat_id) DO UPDATE SET ${column} = excluded.${column}`
  ).bind(chatId, sent.result.message_id).run();
  return sent.result.message_id;
}

// The monthly tab notice: from which balance it is queued, and on which day
// of the month cron sends it blind to anyone not seen since the 1st. Both are
// read from wrangler.toml; unset or unreadable falls back to the default.

const DEFAULT_TAB_NOTICE_MIN_DOLLARS = 20;
const DEFAULT_TAB_NOTICE_FALLBACK_DAY = 7;

function configuredNumber(env, name) {
  const raw = String((env && env[name]) || '').trim();
  // Number('') is 0, which would read "unset" as a real zero.
  return raw === '' ? NaN : Number(raw);
}

// TAB_NOTICE_MIN, in dollars: balances under it are not asked for.
export function tabNoticeThresholdCents(env) {
  const configured = configuredNumber(env, 'TAB_NOTICE_MIN');
  return Math.round((Number.isFinite(configured) && configured >= 0
    ? configured : DEFAULT_TAB_NOTICE_MIN_DOLLARS) * 100);
}

// TAB_NOTICE_FALLBACK_DAY: the day of the month from which a notice nobody
// has collected by posting is sent anyway. 0 turns the blind send off.
export function tabNoticeFallbackDay(env) {
  const configured = configuredNumber(env, 'TAB_NOTICE_FALLBACK_DAY');
  if (!Number.isFinite(configured) || configured < 0) return DEFAULT_TAB_NOTICE_FALLBACK_DAY;
  return Math.min(Math.floor(configured), 28);
}

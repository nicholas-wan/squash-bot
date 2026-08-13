import { deleteMessage, editMessage, pinMessage, sendMessage, unpinMessage } from './telegram.js';

const DEFAULT_TZ = 'Asia/Singapore';
const PINNED_COLUMNS = new Set(['board_message_id', 'tab_message_id']);

export async function getTimezone(env, chatId) {
  const row = await env.DB.prepare('SELECT tz FROM settings WHERE chat_id = ?').bind(chatId).first();
  return (row && row.tz) || env.DEFAULT_TIMEZONE || DEFAULT_TZ;
}

// Keeps one pinned message per column in sync. A null html removes the pin
// entirely, so an empty board or a settled tab leaves no clutter behind.
export async function updatePinnedMessage(env, chatId, column, html, replyMarkup, label) {
  if (!PINNED_COLUMNS.has(column)) throw new Error(`Unknown pinned column: ${column}`);
  const setting = await env.DB.prepare(
    'SELECT board_message_id, tab_message_id FROM settings WHERE chat_id = ?'
  ).bind(chatId).first();
  const existingId = setting && setting[column];

  if (!html) {
    if (existingId) {
      await unpinMessage(env, chatId, existingId);
      await deleteMessage(env, chatId, existingId);
      await env.DB.prepare(`UPDATE settings SET ${column} = NULL WHERE chat_id = ?`)
        .bind(chatId).run();
    }
    return null;
  }

  if (existingId) {
    const edited = await editMessage(env, chatId, existingId, html, replyMarkup);
    if (edited.ok || String(edited.description || '').includes('message is not modified')) {
      return existingId;
    }
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

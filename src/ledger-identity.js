import { boardChats, dataChatId } from './scope.js';
import { queuePinnedRefresh } from './refresh-queue.js';

// Only call with Telegram's authenticated message/callback sender. Display names
// and admin-entered free text must never establish ownership of financial history.
export async function rememberLedgerIdentity(env, chatId, from) {
  if (!from?.id || !from.username) return;
  const slug = `@${String(from.username).replace(/^@/, '').toLowerCase()}`;
  const dataChat = dataChatId(env, chatId);
  const linked = await env.DB.prepare(`INSERT OR IGNORE INTO ledger_identity_aliases
    (chat_id, slug, user_id) VALUES (?, ?, ?)`)
    .bind(dataChat, slug, from.id).run();
  // The database links provisional history in the same transaction. Existing
  // aliases cannot be stolen by a new account taking the same username.
  if (!linked.meta.changes) return;
  const history = await env.DB.prepare('SELECT id FROM ledger WHERE chat_id = ? AND user_id = ? LIMIT 1')
    .bind(dataChat, from.id).first();
  if (history) {
    for (const chat of boardChats(env, chatId)) await queuePinnedRefresh(env, chat, 'tab');
  }
}

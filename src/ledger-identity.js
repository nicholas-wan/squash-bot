import { boardChats, dataChatId } from './scope.js';
import { queuePinnedRefresh } from './refresh-queue.js';

// An alias can never change once written (ledger_alias_immutable), so after
// one insert, linked or ignored, the same account and handle can never change
// anything again. Remembering that per isolate spares a D1 write on nearly
// every tap. Keyed by database, as the timezone cache is, so tests and
// environments never share it.
const MAX_SEEN = 2048;
const seenByDb = new WeakMap();

// Only call with Telegram's authenticated message/callback sender. Display names
// and admin-entered free text must never establish ownership of financial history.
export async function rememberLedgerIdentity(env, chatId, from) {
  if (!from?.id || !from.username) return;
  const slug = `@${String(from.username).replace(/^@/, '').toLowerCase()}`;
  const dataChat = dataChatId(env, chatId);
  let seen = seenByDb.get(env.DB);
  if (!seen) seenByDb.set(env.DB, (seen = new Set()));
  const key = `${dataChat}:${slug}:${from.id}`;
  if (seen.has(key)) return;
  const linked = await env.DB.prepare(`INSERT OR IGNORE INTO ledger_identity_aliases
    (chat_id, slug, user_id) VALUES (?, ?, ?)`)
    .bind(dataChat, slug, from.id).run();
  // The database links provisional history in the same transaction. Existing
  // aliases cannot be stolen by a new account taking the same username.
  if (seen.size >= MAX_SEEN) seen.clear();
  seen.add(key);
  if (!linked.meta.changes) return;
  const history = await env.DB.prepare('SELECT id FROM ledger WHERE chat_id = ? AND user_id = ? LIMIT 1')
    .bind(dataChat, from.id).first();
  if (history) {
    for (const chat of boardChats(env, chatId)) await queuePinnedRefresh(env, chat, 'tab');
  }
}

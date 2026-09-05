// Pinned-message updates happen after the database mutation they represent.
// When Telegram is unavailable, this durable flag lets maintenance retry the
// presentation work without asking the user to repeat an already-saved action.
export async function queuePinnedRefresh(env, chatId, kind) {
  if (!['board', 'tab'].includes(kind)) throw new Error(`Unknown refresh kind: ${kind}`);
  const board = kind === 'board' ? 1 : 0;
  const tab = kind === 'tab' ? 1 : 0;
  await env.DB.prepare(
    `INSERT INTO pending_refreshes (chat_id, board, tab, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(chat_id) DO UPDATE SET
       board = MAX(pending_refreshes.board, excluded.board),
       tab = MAX(pending_refreshes.tab, excluded.tab),
       updated_at = excluded.updated_at`
  ).bind(chatId, board, tab, Date.now()).run();
}

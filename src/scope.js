// Several Telegram groups can share one set of bookings, rosters, history, and
// one money tab. DATA_CHAT_ID is the id every shared row is stored under; with
// it unset each chat keeps its own data, which is the original behaviour.
export function allowedChats(env) {
  return String((env && env.ALLOWED_CHATS) || '').split(',')
    .map((id) => id.trim()).filter(Boolean).map(Number)
    .filter((id) => Number.isFinite(id) && id !== 0);
}

export function sharingData(env) {
  const shared = Number(String((env && env.DATA_CHAT_ID) || '').trim());
  return Number.isFinite(shared) && shared !== 0 ? shared : null;
}

// Where a booking, player, ledger, or audit row lives.
export function dataChatId(env, chatId) {
  return sharingData(env) || chatId;
}

// Where the pinned board, the tab, and new-booking announcements are shown.
export function boardChats(env, chatId) {
  if (!sharingData(env)) return [chatId];
  const all = allowedChats(env);
  return all.length ? all : [chatId];
}

// A player is reachable in the chat they joined from. Anything else — an old row
// or a chat that has since been removed — falls back to the shared chat.
export function reachableChat(env, player, fallbackChatId) {
  const chats = boardChats(env, fallbackChatId);
  return chats.includes(player.chat_id) ? player.chat_id : chats[0];
}

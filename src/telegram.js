export async function telegram(env, method, body) {
  if (!env.BOT_TOKEN) return { ok: false, description: 'BOT_TOKEN is missing' };
  try {
    const response = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN.trim()}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    if (!data.ok) console.log(`Telegram ${method} failed: ${JSON.stringify(data)}`);
    return data;
  } catch (error) {
    console.log(`Telegram ${method} failed: ${error}`);
    return { ok: false, description: String(error) };
  }
}

export function sendMessage(env, chatId, html, {
  silent = false, replyMarkup = null, replyTo = null,
} = {}) {
  const body = {
    chat_id: chatId, text: html, parse_mode: 'HTML', disable_notification: silent,
  };
  if (replyMarkup) body.reply_markup = replyMarkup;
  if (replyTo) body.reply_parameters = { message_id: replyTo };
  return telegram(env, 'sendMessage', body);
}

export function editMessage(env, chatId, messageId, html, replyMarkup = null) {
  const body = {
    chat_id: chatId, message_id: messageId, text: html, parse_mode: 'HTML',
  };
  if (replyMarkup) body.reply_markup = replyMarkup;
  return telegram(env, 'editMessageText', body);
}

export function editReplyMarkup(env, chatId, messageId, replyMarkup) {
  return telegram(env, 'editMessageReplyMarkup', {
    chat_id: chatId, message_id: messageId, reply_markup: replyMarkup,
  });
}

export function deleteMessage(env, chatId, messageId) {
  return telegram(env, 'deleteMessage', { chat_id: chatId, message_id: messageId });
}

export function pinMessage(env, chatId, messageId) {
  return telegram(env, 'pinChatMessage', {
    chat_id: chatId, message_id: messageId, disable_notification: true,
  });
}

export function unpinMessage(env, chatId, messageId) {
  return telegram(env, 'unpinChatMessage', { chat_id: chatId, message_id: messageId });
}

export function answerCallback(env, callbackId, text = '', showAlert = false) {
  return telegram(env, 'answerCallbackQuery', {
    callback_query_id: callbackId, text, show_alert: showAlert,
  });
}

export function escapeHtml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function mentionHtml(userId, name) {
  const safeName = escapeHtml(name || 'Player');
  return userId ? `<a href="tg://user?id=${userId}">${safeName}</a>` : safeName;
}

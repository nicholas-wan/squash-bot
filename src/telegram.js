// The one dismiss button. Every private note carries it, so nobody has to wait
// for the end-of-day sweep to be rid of a message they have read. The callback
// handler in index.js matches the callback_data string exactly, which is why
// every site shares this literal.
export const OK_MARKUP = { inline_keyboard: [[{ text: '👍 OK', callback_data: 'sb:ok' }]] };

// Bounded, because a fetch that never resolves is worse than one that fails:
// it dies with the isolate's grace period, past every catch — no log, no
// error reply, half-written state, and a person staring at a bot that said
// nothing. Fifteen seconds is far beyond any healthy Telegram round trip.
const TELEGRAM_TIMEOUT_MS = 15 * 1000;

export async function telegram(env, method, body) {
  if (!env.BOT_TOKEN) return { ok: false, description: 'BOT_TOKEN is missing' };
  try {
    const response = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN.trim()}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
    });
    const data = await response.json();
    if (!data.ok) console.log(`Telegram ${method} failed: ${JSON.stringify(data)}`);
    return data;
  } catch (error) {
    console.log(`Telegram ${method} failed: ${error}`);
    return { ok: false, description: String(error) };
  }
}

export async function setBotProfilePhoto(env, imageUrl) {
  if (!env.BOT_TOKEN) return { ok: false, description: 'BOT_TOKEN is missing' };
  try {
    const imageResponse = await fetch(imageUrl);
    if (!imageResponse.ok) {
      return { ok: false, description: `Could not download profile photo (${imageResponse.status})` };
    }
    const form = new FormData();
    form.append('photo', JSON.stringify({ type: 'static', photo: 'attach://profile_photo' }));
    form.append('profile_photo', new Blob([await imageResponse.arrayBuffer()], {
      type: 'image/jpeg',
    }), 'squashbot-logo.jpg');
    const response = await fetch(
      `https://api.telegram.org/bot${env.BOT_TOKEN.trim()}/setMyProfilePhoto`,
      { method: 'POST', body: form }
    );
    return await response.json();
  } catch (error) {
    return { ok: false, description: String(error) };
  }
}

export function sendMessage(env, chatId, html, {
  silent = false, replyMarkup = null, replyTo = null,
  receiverUserId = null, callbackQueryId = null, replyToEphemeral = null,
} = {}) {
  const body = {
    chat_id: chatId, text: html, parse_mode: 'HTML', disable_notification: silent,
  };
  if (replyMarkup) body.reply_markup = replyMarkup;
  if (replyTo) body.reply_parameters = { message_id: replyTo };
  if (replyToEphemeral) body.reply_parameters = { ephemeral_message_id: replyToEphemeral };
  if (receiverUserId) body.receiver_user_id = receiverUserId;
  if (callbackQueryId) body.callback_query_id = callbackQueryId;
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

export function editEphemeralMessage(env, chatId, receiverUserId, ephemeralMessageId, html, replyMarkup = null) {
  const body = {
    chat_id: chatId,
    receiver_user_id: receiverUserId,
    ephemeral_message_id: ephemeralMessageId,
    text: html,
    parse_mode: 'HTML',
  };
  if (replyMarkup) body.reply_markup = replyMarkup;
  return telegram(env, 'editEphemeralMessageText', body);
}

export function deleteEphemeralMessage(env, chatId, receiverUserId, ephemeralMessageId) {
  return telegram(env, 'deleteEphemeralMessage', {
    chat_id: chatId,
    receiver_user_id: receiverUserId,
    ephemeral_message_id: ephemeralMessageId,
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

// The first answer to a tap can ride back on the webhook's own HTTP response
// instead of costing a separate round trip to api.telegram.org — the Bot API
// allows one method call as the webhook reply ("Making requests when getting
// updates"), and that round trip is the whole toast latency: the API is served
// from Amsterdam, a quarter second away from this worker. The webhook route
// arms a capture before handling starts; the first answerCallback for that id
// resolves it, and every later answer — or any answer with no arm, as in tests
// and re-answers — travels over HTTPS exactly as before. Keyed by callback id,
// which Telegram makes unique per tap, so two updates being handled in one
// isolate cannot take each other's answers.
const webhookAnswers = new Map();

export function armWebhookAnswer(callbackId) {
  let capture;
  const promise = new Promise((resolve) => { capture = resolve; });
  webhookAnswers.set(callbackId, capture);
  return {
    promise,
    // Arming must always be undone: an id whose answer never comes would leak,
    // and once the webhook has been answered without the toast, the eventual
    // answer has to fall back to HTTPS rather than resolve a response nobody
    // is waiting on. Resolving twice is a no-op, so disarming after a capture
    // is harmless.
    disarm() {
      webhookAnswers.delete(callbackId);
      capture(null);
    },
  };
}

export function answerCallback(env, callbackId, text = '', showAlert = false) {
  const capture = webhookAnswers.get(callbackId);
  if (capture) {
    webhookAnswers.delete(callbackId);
    capture({
      method: 'answerCallbackQuery',
      callback_query_id: callbackId, text, show_alert: showAlert,
    });
    // Telegram never reports the outcome of a method returned on the webhook,
    // so success is asserted rather than known — the same blindness every
    // fired-and-forgotten HTTPS answer already has in practice.
    return Promise.resolve({ ok: true, result: true });
  }
  return telegram(env, 'answerCallbackQuery', {
    callback_query_id: callbackId, text, show_alert: showAlert,
  });
}

// The bot's own @username, for telling "/tab@squashbot" apart from a command
// aimed at some other bot in the same group. getMe never changes for a token,
// so one answer is kept per isolate. A failed lookup answers null, and the
// caller then answers the command anyway — the behaviour before this existed,
// and the safer side of the two: a bot that ignores its own commands reads as
// dead, one that answers a stranger's is merely noisy.
const botUsernames = new Map();

export async function botUsername(env) {
  const token = env.BOT_TOKEN ? env.BOT_TOKEN.trim() : '';
  if (!token) return null;
  if (botUsernames.has(token)) return botUsernames.get(token);
  const me = await telegram(env, 'getMe', {});
  const username = me.ok && me.result && me.result.username
    ? String(me.result.username).toLowerCase() : null;
  if (username) botUsernames.set(token, username);
  return username;
}

export function clearBotUsernameCache() {
  botUsernames.clear();
}

export function escapeHtml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function mentionHtml(userId, name) {
  const safeName = escapeHtml(name || 'Player');
  return userId ? `<a href="tg://user?id=${userId}">${safeName}</a>` : safeName;
}

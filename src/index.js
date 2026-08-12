import {
  cancelBooking, restoreBoardButtons, runMaintenance, showBoardManager,
  showCancelConfirmation, updateBoard,
} from './bookings.js';
import {
  answerCallback, deleteMessage, escapeHtml, sendMessage, setBotProfilePhoto, telegram,
} from './telegram.js';
import {
  beginBooking, handleBookingCallback, handleBookingReply, pruneBookingDrafts,
} from './wizard.js';

function chatAllowed(env, chatId) {
  const ids = String(env.ALLOWED_CHATS || '').split(',').map((x) => x.trim()).filter(Boolean);
  return ids.length > 0 && ids.includes(String(chatId));
}

function helpHtml() {
  return '🎾 <b>SquashBot</b>\n\n' +
    'Send a booking in natural language:\n' +
    '<code>13 Aug Court 4 9pm</code>\n' +
    '<code>court four tomorrow at 9pm</code>\n' +
    '<code>Friday 9pm-10:30pm, Court 2</code>\n\n' +
    'No end time means one hour. If anything is missing or ambiguous, ' +
    'SquashBot asks with buttons and saves only after confirmation.\n' +
    '/courts — refresh the pinned board\n' +
    '/cancel ID — remove a booking\n' +
    '/book — open a blank booking form';
}

async function helpBoardMarkup(env, chatId) {
  const setting = await env.DB.prepare(
    'SELECT board_message_id FROM settings WHERE chat_id = ?'
  ).bind(chatId).first();
  if (!setting || !setting.board_message_id) return null;
  const internalChatId = String(chatId).replace(/^-100/, '');
  if (!/^\d+$/.test(internalChatId)) return null;
  return { inline_keyboard: [[{
    text: '📌 View pinned court board',
    url: `https://t.me/c/${internalChatId}/${setting.board_message_id}`,
  }]] };
}

async function handleBoardCallback(env, callback) {
  const data = String(callback.data || '');
  if (!data.startsWith('sb:') || !callback.message) return false;
  const chatId = callback.message.chat.id;
  const messageId = callback.message.message_id;

  if (data === 'sb:add') {
    await beginBooking(env, {
      chat: callback.message.chat,
      from: callback.from,
      message_id: messageId,
    }, '', { forceIntent: true, callbackQueryId: callback.id });
    await answerCallback(env, callback.id, 'Booking form opened');
    return true;
  }
  if (data === 'sb:manage') {
    await showBoardManager(env, chatId, messageId);
    await answerCallback(env, callback.id, 'Choose a booking on the pinned message');
    return true;
  }
  if (data === 'sb:back') {
    await restoreBoardButtons(env, chatId, messageId);
    await answerCallback(env, callback.id);
    return true;
  }
  const pick = data.match(/^sb:pick:(\d+)$/);
  if (pick) {
    const found = await showCancelConfirmation(env, chatId, messageId, Number(pick[1]));
    await answerCallback(env, callback.id, found ? '' : 'That booking has already gone.', !found);
    if (!found) await updateBoard(env, chatId);
    return true;
  }
  const cancel = data.match(/^sb:cancel:(\d+)$/);
  if (cancel) {
    const removed = await cancelBooking(env, chatId, Number(cancel[1]));
    await answerCallback(env, callback.id,
      removed ? 'Booking cancelled' : 'That booking has already gone.', !removed);
    return true;
  }
  return false;
}

export async function handleUpdate(env, update) {
  const callback = update.callback_query;
  if (callback && callback.message) {
    if (!chatAllowed(env, callback.message.chat && callback.message.chat.id)) return;
    try {
      if (!(await handleBoardCallback(env, callback))) await handleBookingCallback(env, callback);
    } catch (error) {
      console.log(`Callback failed: ${error.stack || error}`);
    }
    return;
  }

  const msg = update.message;
  if (!msg || !msg.text || !chatAllowed(env, msg.chat && msg.chat.id)) return;
  const text = msg.text.trim();

  try {
    if (await handleBookingReply(env, msg)) return;
    if (!text.startsWith('/')) {
      await beginBooking(env, msg, text);
      return;
    }

    const match = text.match(/^\/(\w+)(?:@\w+)?(?:\s+([\s\S]*))?$/);
    if (!match) return;
    const command = match[1].toLowerCase();
    const args = (match[2] || '').trim();
    const knownCommands = new Set(['start', 'help', 'book', 'courts', 'cancel']);
    if (knownCommands.has(command) && msg.message_id) {
      // Older clients may still send a normal group message. Native ephemeral
      // commands have no public copy, so there is nothing to delete.
      await deleteMessage(env, msg.chat.id, msg.message_id);
    }

    if (command === 'start' || command === 'help') {
      const replyMarkup = await helpBoardMarkup(env, msg.chat.id);
      await sendMessage(env, msg.chat.id, helpHtml(), {
        receiverUserId: msg.from.id,
        replyToEphemeral: msg.ephemeral_message_id || null,
        replyMarkup,
      });
      return;
    }
    if (command === 'book') {
      await beginBooking(env, msg, args, { forceIntent: true });
      return;
    }
    if (command === 'courts') {
      await updateBoard(env, msg.chat.id);
      return;
    }
    if (command === 'cancel') {
      if (!/^\d+$/.test(args)) {
        await sendMessage(env, msg.chat.id,
          'Use <code>/cancel ID</code>, for example <code>/cancel 3</code>.', {
            receiverUserId: msg.from.id,
            replyToEphemeral: msg.ephemeral_message_id || null,
          });
        return;
      }
      const removed = await cancelBooking(env, msg.chat.id, Number(args));
      await sendMessage(env, msg.chat.id,
        removed ? `🗑 Removed booking <b>#${escapeHtml(args)}</b>.` : `I couldn't find booking <b>#${escapeHtml(args)}</b>.`,
        {
          silent: true,
          receiverUserId: msg.from.id,
          replyToEphemeral: msg.ephemeral_message_id || null,
        }
      );
      return;
    }
  } catch (error) {
    console.log(`Update failed: ${error.stack || error}`);
    await sendMessage(env, msg.chat.id,
      `⚠️ ${escapeHtml(error.message || 'Something went wrong. Please try again.')}`, {
        receiverUserId: msg.from.id,
        replyToEphemeral: msg.ephemeral_message_id || null,
      });
  }
}

function adminAuthorized(request, env) {
  if (!env.ADMIN_SECRET) return false;
  return request.headers.get('Authorization') === `Bearer ${env.ADMIN_SECRET}`
    || request.headers.get('X-Admin-Secret') === env.ADMIN_SECRET;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/webhook') {
      if (!env.WEBHOOK_SECRET
        || request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.WEBHOOK_SECRET) {
        return new Response('forbidden', { status: 403 });
      }
      let update;
      try {
        update = await request.json();
      } catch {
        return new Response('bad request', { status: 400 });
      }
      ctx.waitUntil(handleUpdate(env, update));
      return new Response('ok');
    }

    if (url.pathname === '/setup') {
      if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });
      if (!adminAuthorized(request, env)) return new Response('forbidden', { status: 403 });
      if (!env.BOT_TOKEN || !env.WEBHOOK_SECRET) {
        return new Response('BOT_TOKEN and WEBHOOK_SECRET must be configured first.', { status: 500 });
      }
      const webhook = await telegram(env, 'setWebhook', {
        url: `${url.origin}/webhook`, secret_token: env.WEBHOOK_SECRET,
        allowed_updates: ['message', 'callback_query'],
      });
      const commands = await telegram(env, 'setMyCommands', { commands: [
        { command: 'book', description: 'Add a court booking', is_ephemeral: true },
        { command: 'courts', description: 'Show or refresh the pinned court board', is_ephemeral: true },
        { command: 'cancel', description: 'Cancel a booking by ID', is_ephemeral: true },
        { command: 'help', description: 'Show examples', is_ephemeral: true },
      ] });
      const profile = await telegram(env, 'setMyName', { name: 'SquashBot' });
      const allowedChatIds = String(env.ALLOWED_CHATS || '').split(',').map((id) => id.trim()).filter(Boolean);
      const chats = await Promise.all(allowedChatIds.map((chatId) => telegram(env, 'getChat', { chat_id: chatId })));
      const ok = webhook.ok && commands.ok && profile.ok && chats.every((chat) => chat.ok);
      const chatNames = chats.filter((chat) => chat.ok).map((chat) => chat.result.title || chat.result.id).join(', ');
      return new Response(ok
        ? `SquashBot webhook, commands, and profile are ready. Allowed chats: ${chatNames}.`
        : JSON.stringify({ webhook, commands, profile, chats }), {
        status: ok ? 200 : 500,
      });
    }

    if (url.pathname === '/refresh') {
      if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });
      if (!adminAuthorized(request, env)) return new Response('forbidden', { status: 403 });
      const chatIds = String(env.ALLOWED_CHATS || '').split(',').map((id) => id.trim()).filter(Boolean);
      await Promise.all(chatIds.map((chatId) => updateBoard(env, Number(chatId))));
      return new Response(`Refreshed ${chatIds.length} pinned board(s).`);
    }

    if (url.pathname === '/profile-photo') {
      if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });
      if (!adminAuthorized(request, env)) return new Response('forbidden', { status: 403 });
      const result = await setBotProfilePhoto(env,
        'https://raw.githubusercontent.com/nicholas-wan/squash-bot/main/assets/squashbot-logo.jpg');
      return new Response(result.ok ? 'SquashBot profile photo updated.' : JSON.stringify(result), {
        status: result.ok ? 200 : 502,
      });
    }

    return new Response('squashbot is running');
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(Promise.all([runMaintenance(env), pruneBookingDrafts(env)]));
  },
};

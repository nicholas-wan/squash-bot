import { cancelBooking, runMaintenance, updateBoard } from './bookings.js';
import { deleteMessage, escapeHtml, sendMessage, telegram } from './telegram.js';
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

export async function handleUpdate(env, update) {
  const callback = update.callback_query;
  if (callback && callback.message) {
    if (!chatAllowed(env, callback.message.chat && callback.message.chat.id)) return;
    try {
      await handleBookingCallback(env, callback);
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

    if (command === 'start' || command === 'help') {
      await sendMessage(env, msg.chat.id, helpHtml());
      return;
    }
    if (command === 'book') {
      await beginBooking(env, msg, args, { forceIntent: true });
      await deleteMessage(env, msg.chat.id, msg.message_id);
      return;
    }
    if (command === 'courts') {
      await updateBoard(env, msg.chat.id);
      await deleteMessage(env, msg.chat.id, msg.message_id);
      return;
    }
    if (command === 'cancel') {
      if (!/^\d+$/.test(args)) {
        await sendMessage(env, msg.chat.id, 'Use <code>/cancel ID</code>, for example <code>/cancel 3</code>.');
        return;
      }
      const removed = await cancelBooking(env, msg.chat.id, Number(args));
      await sendMessage(env, msg.chat.id,
        removed ? `🗑 Removed booking <b>#${escapeHtml(args)}</b>.` : `I couldn't find booking <b>#${escapeHtml(args)}</b>.`,
        { silent: true }
      );
      if (removed) await deleteMessage(env, msg.chat.id, msg.message_id);
      return;
    }
  } catch (error) {
    console.log(`Update failed: ${error.stack || error}`);
    await sendMessage(env, msg.chat.id,
      `⚠️ ${escapeHtml(error.message || 'Something went wrong. Please try again.')}`);
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
        { command: 'book', description: 'Add a court booking' },
        { command: 'courts', description: 'Show or refresh the pinned court board' },
        { command: 'cancel', description: 'Cancel a booking by ID' },
        { command: 'help', description: 'Show examples' },
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

    return new Response('squashbot is running');
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(Promise.all([runMaintenance(env), pruneBookingDrafts(env)]));
  },
};

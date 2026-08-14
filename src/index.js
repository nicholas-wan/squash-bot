import {
  authorizeBookingChange, bookingPanelView, cancelBooking, deletePanelView, managerView,
  notifyRemovedPlayer, notifyRosterOfJoin, removePlayerView, restoreBoardButtons,
  runMaintenance, joinPickerView, updateBoard,
} from './bookings.js';
import {
  defaultCapacity, isChatAdmin, MAX_CAPACITY, raiseCapacity, rememberPlayer,
  joinBooking, leaveBooking, removeBookingPlayer, toggleBooking,
} from './players.js';
import { looksLikeBooking } from './parser.js';
import { formatMoney } from './pricing.js';
import {
  confirmSettleMarkup, settleMarkup, settleUser, tabBalances, updateTab,
} from './tab.js';
import {
  answerCallback, deleteEphemeralMessage, deleteMessage, editEphemeralMessage,
  editReplyMarkup, escapeHtml, sendMessage,
  setBotProfilePhoto, telegram,
} from './telegram.js';
import {
  beginBooking, beginEditBooking, handleBookingCallback, handleBookingReply,
  pruneBookingDrafts,
} from './wizard.js';

function chatAllowed(env, chat) {
  const ids = String(env.ALLOWED_CHATS || '').split(',').map((x) => x.trim()).filter(Boolean);
  const chatId = chat && chat.id;
  if (ids.length > 0 && ids.includes(String(chatId))) return true;
  // Printed by `npx wrangler tail` so a new group's id can be read off the first
  // message someone sends there. No message text is logged.
  console.log(
    `Ignored update from chat ${chatId}${chat && chat.title ? ` "${chat.title}"` : ''}. ` +
    'Add that id to ALLOWED_CHATS to enable SquashBot there.'
  );
  return false;
}

function helpHtml(env) {
  return '🎾 <b>SquashBot</b>\n\n' +
    'Send a booking in natural language:\n' +
    '<code>13 Aug Court 4 9pm</code>\n' +
    '<code>court four tomorrow at 9pm</code>\n' +
    '<code>Friday 8pm-9:30pm, Court 2</code>\n\n' +
    'Courts run <b>7am to 10pm</b>, so 9pm is the last slot.\n' +
    'No end time means one hour. If anything is missing or ambiguous, ' +
    'SquashBot asks with buttons and saves only after confirmation.\n\n' +
    `Every court holds <b>${defaultCapacity(env)} players</b> by default — tap a ` +
    '🙋 button on the pinned board to join or leave. Group admins can open extra ' +
    'slots from <b>Manage bookings</b>.\n' +
    'Courts cost <b>$6/hour</b> from 6pm, on weekends, and on Singapore public ' +
    'holidays, and <b>$3/hour</b> before 6pm on other days. Your share appears on ' +
    'the pinned tab after you have played.\n\n' +
    '/courts — refresh the pinned board\n' +
    '/tab — refresh the pinned money tab\n' +
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
    await showPanel(env, callback,
      await managerView(env, chatId, callback.from, await isChatAdmin(env, chatId, callback.from)));
    await answerCallback(env, callback.id);
    return true;
  }
  if (data === 'sb:back') {
    await restoreBoardButtons(env, chatId, messageId);
    await answerCallback(env, callback.id);
    return true;
  }
  const pick = data.match(/^sb:pick:(\d+)$/);
  if (pick) {
    const view = await bookingPanelView(env, chatId, Number(pick[1]));
    if (view) await showPanel(env, callback, view);
    await answerCallback(env, callback.id, view ? '' : 'That booking has already gone.', !view);
    if (!view) await updateBoard(env, chatId);
    return true;
  }
  const edit = data.match(/^sb:edit:(\d+):([dct])$/);
  if (edit) {
    const permitted = await authorizeBookingChange(
      env, chatId, Number(edit[1]), callback.from, 'edit'
    );
    if (!permitted.allowed) {
      await answerCallback(env, callback.id, permitted.message, true);
      return true;
    }
    const field = { d: 'date', c: 'court', t: 'time' }[edit[2]];
    const found = await beginEditBooking(env, callback, Number(edit[1]), field);
    if (found) await restoreBoardButtons(env, chatId, messageId);
    await answerCallback(env, callback.id,
      found ? `Change ${field} form opened` : 'That booking has already gone.', !found);
    return true;
  }
  const remove = data.match(/^sb:delete:(\d+)$/);
  if (remove) {
    const permitted = await authorizeBookingChange(
      env, chatId, Number(remove[1]), callback.from, 'delete'
    );
    if (!permitted.allowed) {
      await answerCallback(env, callback.id, permitted.message, true);
      return true;
    }
    const view = await deletePanelView(env, chatId, Number(remove[1]));
    if (view) await showPanel(env, callback, view);
    await answerCallback(env, callback.id, view ? '' : 'That booking has already gone.', !view);
    if (!view) await updateBoard(env, chatId);
    return true;
  }
  const cancel = data.match(/^sb:cancel:(\d+)$/);
  if (cancel) {
    const result = await cancelBooking(
      env, chatId, Number(cancel[1]), callback.from, 'Deleted from pinned booking manager'
    );
    const removed = result.status === 'cancelled';
    await answerCallback(env, callback.id,
      removed ? 'Booking cancelled' : result.message, !removed);
    return true;
  }
  if (data === 'sb:join') {
    const view = await joinPickerView(env, chatId, callback.from);
    if (!view) {
      await answerCallback(env, callback.id, 'There is nothing to join yet.', true);
      return true;
    }
    await sendMessage(env, chatId, view.html, {
      replyMarkup: view.replyMarkup,
      receiverUserId: callback.from.id,
      callbackQueryId: callback.id,
    });
    await answerCallback(env, callback.id);
    return true;
  }
  if (data === 'sb:close' || data === 'sb:ok') {
    await dismissMessage(env, callback);
    await answerCallback(env, callback.id);
    return true;
  }
  const full = data.match(/^sb:full:(\d+)$/);
  if (full) {
    await answerCallback(env, callback.id,
      'That court is full. A group admin can open another slot.', true);
    return true;
  }
  const join = data.match(/^sb:join:(\d+)$/);
  const leave = data.match(/^sb:leave:(\d+)$/);
  const tap = data.match(/^sb:tap:(\d+)$/);
  if (join || leave || tap) {
    const bookingId = Number((join || leave || tap)[1]);
    let result;
    if (tap) result = await toggleBooking(env, chatId, bookingId, callback.from);
    else if (join) result = await joinBooking(env, chatId, bookingId, callback.from);
    else result = await leaveBooking(env, chatId, bookingId, callback.from);
    const replies = {
      joined: ['You are in. Everyone already on the court has been told.', false],
      left: ['You are out. Your slot is free again.', false],
      already: ['You are already on that court.', true],
      absent: ['You were not on that court.', true],
      full: ['That court is full. A group admin can open another slot.', true],
      started: ['That court has already started, so the roster is locked.', true],
      gone: ['That booking has already gone.', true],
    };
    if (result.status === 'joined' || result.status === 'left') {
      await updateBoard(env, chatId);
      await refreshJoinPicker(env, callback);
    }
    if (result.status === 'joined') {
      await notifyRosterOfJoin(env, chatId, result.booking, callback.from);
    }
    await answerCallback(env, callback.id, ...replies[result.status]);
    return true;
  }
  const kicked = data.match(/^sb:kick:(\d+):(\d+)$/);
  if (kicked) {
    if (!(await isChatAdmin(env, chatId, callback.from))) {
      await answerCallback(env, callback.id, 'Only group admins can remove players.', true);
      return true;
    }
    const removed = await removeBookingPlayer(
      env, chatId, Number(kicked[1]), Number(kicked[2])
    );
    if (removed) {
      await updateBoard(env, chatId);
      await notifyRemovedPlayer(env, chatId, removed.player, removed.booking);
      const view = await bookingPanelView(env, chatId, Number(kicked[1]));
      if (view) await showPanel(env, callback, view);
    }
    await answerCallback(env, callback.id,
      removed ? `${removed.player.name} is off this booking.`
        : 'That player has already gone.', !removed);
    return true;
  }
  const kick = data.match(/^sb:kick:(\d+)$/);
  if (kick) {
    if (!(await isChatAdmin(env, chatId, callback.from))) {
      await answerCallback(env, callback.id, 'Only group admins can remove players.', true);
      return true;
    }
    const shown = await removePlayerView(env, chatId, Number(kick[1]));
    if (shown) await showPanel(env, callback, shown);
    await answerCallback(env, callback.id,
      shown ? '' : 'Nobody is on that booking.', !shown);
    return true;
  }
  const capacity = data.match(/^sb:cap:(\d+)$/);
  if (capacity) {
    if (!(await isChatAdmin(env, chatId, callback.from))) {
      await answerCallback(env, callback.id, 'Only group admins can open extra slots.', true);
      return true;
    }
    const raised = await raiseCapacity(env, chatId, Number(capacity[1]));
    if (raised) {
      await updateBoard(env, chatId);
      const view = await bookingPanelView(env, chatId, Number(capacity[1]));
      if (view) await showPanel(env, callback, view);
    }
    await answerCallback(env, callback.id,
      raised ? `This court now holds ${raised} players.`
        : `That booking has gone, or it is already at the ${MAX_CAPACITY} player limit.`,
      !raised);
    return true;
  }
  return false;
}

// Panels are private to one person. The first tap comes off the shared pinned
// board and has to open a new ephemeral message; every tap after that arrives
// from inside the panel and edits it in place. Nothing here ever writes to the
// pinned message, which is what used to publish hidden bookings to the group.
async function showPanel(env, callback, view) {
  const chatId = callback.message.chat.id;
  const ephemeralId = callback.message.ephemeral_message_id;
  if (ephemeralId) {
    return editEphemeralMessage(
      env, chatId, callback.from.id, ephemeralId, view.html, view.replyMarkup
    );
  }
  return sendMessage(env, chatId, view.html, {
    receiverUserId: callback.from.id,
    callbackQueryId: callback.id,
    replyMarkup: view.replyMarkup,
  });
}

// The court list is a private message to one person, so it is edited in place
// through the ephemeral API. Taps that arrive from anywhere else are left alone.
async function refreshJoinPicker(env, callback) {
  const ephemeralId = callback.message && callback.message.ephemeral_message_id;
  if (!ephemeralId) return;
  const chatId = callback.message.chat.id;
  const view = await joinPickerView(env, chatId, callback.from);
  await editEphemeralMessage(
    env, chatId, callback.from.id, ephemeralId,
    view ? view.html : '🎾 <i>Nothing left to join.</i>',
    view ? view.replyMarkup : { inline_keyboard: [] }
  );
}

async function dismissMessage(env, callback) {
  const ephemeralId = callback.message && callback.message.ephemeral_message_id;
  if (ephemeralId) {
    await deleteEphemeralMessage(env, callback.message.chat.id, callback.from.id, ephemeralId);
    return;
  }
  if (callback.message && callback.message.message_id) {
    await deleteMessage(env, callback.message.chat.id, callback.message.message_id);
  }
}

async function handleTabCallback(env, callback) {
  const data = String(callback.data || '');
  if (!data.startsWith('tb:') || !callback.message) return false;
  const chatId = callback.message.chat.id;
  const messageId = callback.message.message_id;

  if (!(await isChatAdmin(env, chatId, callback.from))) {
    await answerCallback(env, callback.id, 'Only group admins can settle the tab.', true);
    return true;
  }
  if (data === 'tb:back') {
    await updateTab(env, chatId);
    await answerCallback(env, callback.id);
    return true;
  }
  if (data === 'tb:pay') {
    await editReplyMarkup(env, chatId, messageId, await settleMarkup(env, chatId));
    await answerCallback(env, callback.id, 'Choose whose debt to clear');
    return true;
  }
  const paid = data.match(/^tb:paid:(.+)$/);
  if (paid) {
    const settled = await settleUser(env, chatId, paid[1], callback.from);
    await answerCallback(env, callback.id,
      settled ? `${settled.name} cleared · ${formatMoney(settled.balance)}`
        : 'That balance is already clear.', !settled);
    return true;
  }
  const pick = data.match(/^tb:pay:(.+)$/);
  if (pick) {
    const confirmation = await confirmSettleMarkup(env, chatId, pick[1]);
    if (!confirmation) {
      await updateTab(env, chatId);
      await answerCallback(env, callback.id, 'That balance is already clear.', true);
      return true;
    }
    await editReplyMarkup(env, chatId, messageId, confirmation.markup);
    await answerCallback(env, callback.id);
    return true;
  }
  return false;
}

// Clearing the message needs the Delete Messages admin right. Failing quietly
// would leave the booking in the group while the bot behaves as though it had
// been cleared, so whoever sent it is told to fix the permission.
async function clearBookingMessage(env, msg) {
  const deleted = await deleteMessage(env, msg.chat.id, msg.message_id);
  if (deleted.ok) return;
  await sendMessage(env, msg.chat.id,
    '⚠️ Your booking message is still in the group — I need the ' +
    '<b>Delete Messages</b> admin right to clear it.',
    { receiverUserId: msg.from.id });
}

export async function handleUpdate(env, update) {
  const callback = update.callback_query;
  if (callback && callback.message) {
    if (!chatAllowed(env, callback.message.chat)) return;
    try {
      await rememberPlayer(env, callback.from);
      if (await handleBoardCallback(env, callback)) return;
      if (await handleTabCallback(env, callback)) return;
      await handleBookingCallback(env, callback);
    } catch (error) {
      console.log(`Callback failed: ${error.stack || error}`);
    }
    return;
  }

  const msg = update.message;
  if (!msg || !msg.text || !chatAllowed(env, msg.chat)) return;
  const text = msg.text.trim();
  // Set once the original has been cleared, so a failure further down can hand
  // the wording back rather than leaving the sender with nothing to retype from.
  let clearedText = null;

  try {
    await rememberPlayer(env, msg.from);
    if (await handleBookingReply(env, msg)) return;
    if (!text.startsWith('/')) {
      // The booking form repeats the text back, and the pinned board is the
      // record, so the original message is cleared out of the group. The intent
      // is read up front and the delete runs in a finally, because a form that
      // fails to open would otherwise leave the booking sitting in the chat.
      const isBooking = looksLikeBooking(text);
      try {
        await beginBooking(env, msg, text);
      } finally {
        if (isBooking && msg.message_id) {
          clearedText = text;
          await clearBookingMessage(env, msg);
        }
      }
      return;
    }

    const match = text.match(/^\/(\w+)(?:@\w+)?(?:\s+([\s\S]*))?$/);
    if (!match) return;
    const command = match[1].toLowerCase();
    const args = (match[2] || '').trim();
    const knownCommands = new Set(['start', 'help', 'book', 'courts', 'cancel', 'tab']);
    if (knownCommands.has(command) && msg.message_id) {
      // Older clients may still send a normal group message. Native ephemeral
      // commands have no public copy, so there is nothing to delete.
      await deleteMessage(env, msg.chat.id, msg.message_id);
    }

    if (command === 'start' || command === 'help') {
      const replyMarkup = await helpBoardMarkup(env, msg.chat.id);
      await sendMessage(env, msg.chat.id, helpHtml(env), {
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
    if (command === 'tab') {
      const pinned = await updateTab(env, msg.chat.id);
      if (!pinned) {
        await sendMessage(env, msg.chat.id,
          '💰 Nothing outstanding. Shares appear on the tab after a court has been played.', {
            receiverUserId: msg.from.id,
            replyToEphemeral: msg.ephemeral_message_id || null,
          });
      }
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
      const result = await cancelBooking(
        env, msg.chat.id, Number(args), msg.from, `/cancel ${args}`
      );
      const replies = {
        cancelled: `🗑 Removed booking <b>#${escapeHtml(args)}</b>.`,
        gone: `I couldn't find booking <b>#${escapeHtml(args)}</b>.`,
      };
      await sendMessage(env, msg.chat.id,
        replies[result.status] || escapeHtml(result.message),
        {
          silent: true,
          receiverUserId: msg.from.id,
          replyToEphemeral: msg.ephemeral_message_id || null,
        }
      );
      return;
    }
  } catch (error) {
    // The detail belongs in the log, not in the chat: an internal message can
    // carry SQL, ids, or configuration. The wizard sends its own wording for
    // anything the person can actually act on before it throws.
    console.log(`Update failed: ${error.stack || error}`);
    await sendMessage(env, msg.chat.id,
      '⚠️ Something went wrong. Please try again.'
      // Their message was deleted before this failed, so it only exists here.
      + (clearedText ? `\n\n<code>${escapeHtml(clearedText)}</code>` : ''), {
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
        { command: 'tab', description: 'Show or refresh the pinned money tab', is_ephemeral: true },
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
      await Promise.all(chatIds.map(async (chatId) => {
        await updateBoard(env, Number(chatId));
        await updateTab(env, Number(chatId));
      }));
      return new Response(`Refreshed the board and tab in ${chatIds.length} chat(s).`);
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

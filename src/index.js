import { runScheduledMaintenance } from './maintenance-schedule.js';
import { rememberLedgerIdentity } from './ledger-identity.js';
import {
  addPlayerView, authorizeBookingChange, bookingPanelView, cancelBooking, deletePanelView,
  managerView, notifyRemovedPlayer, notifyRosterOfChange, plusOneView, removePlayerView,
  restoreBoardButtons, runMaintenance, joinPickerView, updateBoard,
} from './bookings.js';
import {
  adminAddPlayer, defaultCapacity, isChatAdmin, isHouseholdPlayer, knownPlayers,
  MAX_CAPACITY, raiseCapacity, rememberPlayer, togglePlusOne,
  joinBooking, leaveBooking, removeBookingPlayer, toggleBooking,
} from './players.js';
import { looksLikeBooking } from './parser.js';
import { formatMoney } from './pricing.js';
import {
  adjustBalance, confirmSettleMarkup, matchAccount, myTabView,
  parseDebtAdjustment, settleMarkup, settleUser, tabBalances, theirTabView,
  updateTab,
} from './tab.js';
import {
  answerCallback, armWebhookAnswer, botUsername, deleteEphemeralMessage,
  deleteMessage, editEphemeralMessage, editReplyMarkup, escapeHtml, OK_MARKUP,
  sendMessage, setBotProfilePhoto, telegram,
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
    '/debt +2 player reason — admins: add to or take off a debt\n' +
    '/cancel ID — remove a booking\n' +
    '/book [details] [@player or +1] — book with a player or guest';
}

async function helpBoardMarkup(env, chatId) {
  const rows = [];
  const setting = await env.DB.prepare(
    'SELECT board_message_id FROM settings WHERE chat_id = ?'
  ).bind(chatId).first();
  const internalChatId = String(chatId).replace(/^-100/, '');
  if (setting && setting.board_message_id && /^\d+$/.test(internalChatId)) {
    rows.push([{
      text: '📌 View pinned court board',
      url: `https://t.me/c/${internalChatId}/${setting.board_message_id}`,
    }]);
  }
  rows.push(...OK_MARKUP.inline_keyboard);
  return { inline_keyboard: rows };
}

// Every tap the pinned board and its private panels can produce, one row per
// route, tried in order — a two-part pattern (a seat pick with its slug, a +1
// flip or kick with its row id) must sit above its one-part opener, or the
// opener swallows it. A route with `admin` is refused with that exact toast
// before its handler runs. Telegram never checks that callback data matches a
// button the bot drew, so a modified client can send any string — which taps
// are gated, and which deliberately are not, reads straight down this table.
// sb:manage and sb:pick only *render*, but what they render includes rosters a
// non-admin member is deliberately not shown, so they carry the gate too;
// sb:edit, sb:delete, and sb:cancel guard themselves through
// authorizeBookingChange, whose booker-or-admin rule this table cannot express.
// sb:ok and sb:close are open to everyone because the message they clear is
// normally the tapper's own receipt — dismissMessage checks the pinned board
// and tab ids itself, since a hand-sent sb:ok naming one would otherwise
// delete the group's record from under it.
const MANAGE_ADMIN = 'Only group admins can manage bookings.';
const SEAT_ADMIN = 'Only group admins can add players.';
const PLUS_ADMIN = 'Only group admins can change a +1.';
const KICK_ADMIN = 'Only group admins can remove players.';
const boardRoutes = [
  { pattern: /^sb:add$/, handler: beginBoardBooking },
  { pattern: /^sb:manage$/, admin: MANAGE_ADMIN, handler: openManager },
  { pattern: /^sb:back$/, handler: restoreBoard },
  { pattern: /^sb:pick:(\d+)$/, admin: MANAGE_ADMIN, handler: openBookingPanel },
  { pattern: /^sb:edit:(\d+):([dct])$/, handler: openEditForm },
  { pattern: /^sb:delete:(\d+)$/, handler: openDeleteConfirmation },
  { pattern: /^sb:cancel:(\d+)$/, handler: cancelFromPanel },
  { pattern: /^sb:join$/, handler: openJoinPicker },
  { pattern: /^sb:(?:close|ok)$/, handler: dismissTapped },
  { pattern: /^sb:full:(\d+)$/, handler: fullCourtToast },
  { pattern: /^sb:(join|leave|tap):(\d+)$/, handler: moveSlot },
  // The head count comes before the slug and is a bare 1 or 2, which is what
  // keeps this apart from the picker's own :h1 / :h2 rows — a slug can start
  // with anything, so the digit has to be matched first and anchored.
  { pattern: /^sb:addp:(\d+):([12]):(.+)$/, admin: SEAT_ADMIN, handler: seatPickedPlayer },
  { pattern: /^sb:addp:(\d+)(?::h([12]))?$/, admin: SEAT_ADMIN, handler: openSeatPicker },
  { pattern: /^sb:plus:(\d+):(\d+)$/, admin: PLUS_ADMIN, handler: flipPlusOne },
  { pattern: /^sb:plus:(\d+)$/, admin: PLUS_ADMIN, handler: openPlusOnePicker },
  { pattern: /^sb:kick:(\d+):(\d+)$/, admin: KICK_ADMIN, handler: removePickedPlayer },
  { pattern: /^sb:kick:(\d+)$/, admin: KICK_ADMIN, handler: openRemovePicker },
  { pattern: /^sb:cap:(\d+)$/, admin: 'Only group admins can open extra slots.', handler: raiseSlotCount },
];

// The one dispatch both route tables share. Returns true when a route claimed
// the tap, whether its handler ran or its admin guard refused it.
async function dispatchCallback(env, callback, routes) {
  const data = String(callback.data || '');
  for (const route of routes) {
    const match = data.match(route.pattern);
    if (!match) continue;
    if (route.admin
      && !(await isChatAdmin(env, callback.message.chat.id, callback.from))) {
      await answerCallback(env, callback.id, route.admin, true);
      return true;
    }
    await route.handler(env, callback, match);
    return true;
  }
  return false;
}

function handleBoardCallback(env, callback) {
  if (!String(callback.data || '').startsWith('sb:') || !callback.message) {
    return false;
  }
  return dispatchCallback(env, callback, boardRoutes);
}

async function beginBoardBooking(env, callback) {
  await beginBooking(env, {
    chat: callback.message.chat,
    from: callback.from,
    message_id: callback.message.message_id,
  }, '', { forceIntent: true, callbackQueryId: callback.id });
  await answerCallback(env, callback.id, 'Booking form opened');
}

async function openManager(env, callback) {
  await showPanel(env, callback, await managerView(env, callback.message.chat.id));
  await answerCallback(env, callback.id);
}

async function restoreBoard(env, callback) {
  await restoreBoardButtons(
    env, callback.message.chat.id, callback.message.message_id
  );
  await answerCallback(env, callback.id);
}

async function openBookingPanel(env, callback, match) {
  const chatId = callback.message.chat.id;
  const view = await bookingPanelView(env, chatId, Number(match[1]));
  if (view) await showPanel(env, callback, view);
  await answerCallback(env, callback.id, view ? '' : 'That booking has already gone.', !view);
  if (!view) await updateBoard(env, chatId);
}

async function openEditForm(env, callback, match) {
  const chatId = callback.message.chat.id;
  const messageId = callback.message.message_id;
  const permitted = await authorizeBookingChange(
    env, chatId, Number(match[1]), callback.from, 'edit'
  );
  if (!permitted.allowed) {
    await answerCallback(env, callback.id, permitted.message, true);
    return;
  }
  const field = { d: 'date', c: 'court', t: 'time' }[match[2]];
  const found = await beginEditBooking(env, callback, Number(match[1]), field);
  // The toast answers first — the wizard is already on its way, and the
  // board restore below is bookkeeping the tapper should not wait on.
  await answerCallback(env, callback.id,
    found ? `Change ${field} form opened` : 'That booking has already gone.', !found);
  // Restoring the board's buttons only means anything when the tap came off
  // the pinned board itself. From a private panel the message id is the
  // ephemeral one's 0, and the edit was a doomed request on every tap.
  if (found && !callback.message.ephemeral_message_id && messageId) {
    await restoreBoardButtons(env, chatId, messageId);
  }
}

async function openDeleteConfirmation(env, callback, match) {
  const chatId = callback.message.chat.id;
  const permitted = await authorizeBookingChange(
    env, chatId, Number(match[1]), callback.from, 'delete'
  );
  if (!permitted.allowed) {
    await answerCallback(env, callback.id, permitted.message, true);
    return;
  }
  const view = await deletePanelView(env, chatId, Number(match[1]));
  if (view) await showPanel(env, callback, view);
  await answerCallback(env, callback.id, view ? '' : 'That booking has already gone.', !view);
  if (!view) await updateBoard(env, chatId);
}

async function cancelFromPanel(env, callback, match) {
  const result = await cancelBooking(
    env, callback.message.chat.id, Number(match[1]), callback.from,
    'Deleted from pinned booking manager'
  );
  const removed = result.status === 'cancelled';
  await answerCallback(env, callback.id,
    removed ? 'Booking cancelled' : result.message, !removed);
}

async function openJoinPicker(env, callback) {
  const chatId = callback.message.chat.id;
  // Started, not awaited: the admin lookup is a Telegram round trip that
  // can overlap the picker's own D1 reads. isChatAdmin never rejects, so
  // handing the promise down is safe; the view awaits it when needed.
  const view = await joinPickerView(
    env, chatId, callback.from, isChatAdmin(env, chatId, callback.from)
  );
  if (!view) {
    await answerCallback(env, callback.id, 'There is nothing to join yet.', true);
    return;
  }
  const delivery = await sendPrivatePanel(env, callback, view);
  // A refused send used to be ignored, which read as a dead button — for a
  // brand-new member most of all, the one person Telegram is likeliest to
  // refuse an ephemeral message for. The tap is the only channel left, so
  // the failure is said there, as an alert rather than a toast.
  if (delivery.status === 'failed') {
    await answerCallback(env, callback.id,
      'I could not open your court list. Please tap 🙋 Join again.', true);
    return;
  }
  // Telegram falls back to an ordinary group message when it cannot deliver
  // an ephemeral one, which would publish "Only you can see this list" — and
  // the rosters on it — to the whole group. Same rule as sendPrivately: the
  // public copy goes, and the tapper is told rather than left guessing.
  if (delivery.status === 'public-fallback') {
    await answerCallback(env, callback.id,
      'Telegram would not deliver your private court list. Please tap 🙋 Join again.', true);
    return;
  }
  // An ephemeral message arrives without a notification, so the chat does
  // not always scroll to it; the toast says where to look.
  await answerCallback(env, callback.id, '🎾 Your court list is below ⬇️');
}

async function dismissTapped(env, callback) {
  await dismissMessage(env, callback);
  await answerCallback(env, callback.id);
}

async function fullCourtToast(env, callback) {
  await answerCallback(env, callback.id,
    'That court is full. A group admin can open another slot.', true);
}

async function moveSlot(env, callback, match) {
  const chatId = callback.message.chat.id;
  const action = match[1];
  const bookingId = Number(match[2]);
  let result;
  if (action === 'tap') result = await toggleBooking(env, chatId, bookingId, callback.from);
  else if (action === 'join') result = await joinBooking(env, chatId, bookingId, callback.from);
  else result = await leaveBooking(env, chatId, bookingId, callback.from);
  const replies = {
    already: ['You are already on that court.', true],
    'identity-conflict': [
      'That username is already tied to another player on this court. Ask an admin to update the roster.',
      true,
    ],
    absent: ['You were not on that court.', true],
    full: ['That court is full. A group admin can open another slot.', true],
    started: ['That court has already started, so the roster is locked.', true],
    gone: ['That booking has already gone.', true],
  };
  if (result.status === 'joined' || result.status === 'left') {
    // The slot changed hands the moment the insert or delete ran, so the
    // toast goes out first: it is the one piece of feedback that expires,
    // and it used to wait behind the notification burst, the board edit,
    // and the picker refresh — long enough for Telegram to discard it,
    // which read as a tap that did nothing. The roster's private notices
    // carry the fuller story; the toast only confirms the slot moved.
    await answerCallback(env, callback.id, result.status === 'left'
      ? 'You are out. Your slot is free again.' : 'You are in.');
    // Telling the court still comes before the board: updateBoard throws
    // when the pinned message cannot be edited or re-pinned, and the catch
    // around this handler would then swallow the notification along with it
    // — the people on the court would never hear, for a reason that has
    // nothing to do with them.
    await notifyRosterOfChange(
      env, chatId, result.booking, callback.from, result.status, 1,
      { callbackQueryId: callback.id }
    );
    await updateBoard(env, chatId);
    await refreshJoinPicker(env, callback);
    return;
  }
  await answerCallback(env, callback.id, ...replies[result.status]);
}

async function seatPickedPlayer(env, callback, match) {
  const chatId = callback.message.chat.id;
  const bookingId = Number(match[1]);
  const heads = Number(match[2]);
  // Resolved fresh rather than trusted from the button, so a stale panel
  // cannot seat somebody under an outdated name or id.
  const candidate = (await knownPlayers(env, chatId))
    .find((player) => player.slug === match[3]);
  if (!candidate) {
    await answerCallback(env, callback.id, 'That player is no longer known.', true);
    return;
  }
  const result = await adminAddPlayer(
    env, chatId, bookingId, candidate, callback.from.id, heads
  );
  let allTold = false;
  if (result.status === 'added') {
    // The seated player is the subject of the notice, not the admin tapping.
    ({ allTold } = await notifyRosterOfChange(env, chatId, result.booking, {
      id: candidate.user_id || null,
      username: candidate.slug.startsWith('@') ? candidate.slug.slice(1) : null,
      first_name: candidate.name,
    }, 'added', heads));
    await updateBoard(env, chatId);
    const view = await bookingPanelView(env, chatId, bookingId);
    if (view) await showPanel(env, callback, view);
  }
  const delivery = allTold
    ? 'Everyone on it has been told.' : 'Some players could not be notified.';
  const replies = {
    added: [heads > 1
      ? `${candidate.name} +1 are on this court — two shares on the tab. `
        + delivery
      : `${candidate.name} is on this court. ${delivery}`, false],
    already: ['They are already on that court.', true],
    full: [heads > 1
      ? 'A +1 needs two free slots. Open another one first.'
      : 'That court is full. Open another slot first.', true],
    gone: ['That booking has already gone.', true],
  };
  await answerCallback(env, callback.id, ...replies[result.status]);
}

// Opening the picker and flipping its friend toggle are the same view drawn
// for one head or two, so they are one route: the toggle only re-renders.
async function openSeatPicker(env, callback, match) {
  const chatId = callback.message.chat.id;
  const heads = Number(match[2] || 1);
  const view = await addPlayerView(env, chatId, Number(match[1]), heads);
  if (view) await showPanel(env, callback, view);
  await answerCallback(env, callback.id,
    view ? '' : (heads > 1
      ? 'A +1 needs two free slots, and this court has not got them.'
      : 'Nobody to seat — the court is full, gone, or everyone known is on it.'),
    !view);
}

async function flipPlusOne(env, callback, match) {
  const chatId = callback.message.chat.id;
  const bookingId = Number(match[1]);
  const result = await togglePlusOne(env, chatId, bookingId, Number(match[2]));
  let allTold = false;
  if (result.status === 'plus' || result.status === 'minus') {
    // The member whose share changed is the subject, not the tapping admin.
    ({ allTold } = await notifyRosterOfChange(env, chatId, result.booking, {
      id: result.player.user_id || null,
      username: result.player.slug.startsWith('@') ? result.player.slug.slice(1) : null,
      first_name: result.player.name,
    }, result.status));
    await updateBoard(env, chatId);
    const view = await plusOneView(env, chatId, bookingId);
    if (view) await showPanel(env, callback, view);
  }
  const delivery = allTold
    ? 'Everyone has been told.' : 'Some players could not be notified.';
  const replies = {
    plus: [`${result.player && result.player.name} now brings a +1 — two shares. `
      + delivery, false],
    minus: [`${result.player && result.player.name}'s +1 is off — one share again. `
      + delivery, false],
    full: ['No free slot for a +1. Open another slot first.', true],
    gone: ['That player or booking has already gone.', true],
  };
  await answerCallback(env, callback.id, ...replies[result.status]);
}

async function openPlusOnePicker(env, callback, match) {
  const view = await plusOneView(env, callback.message.chat.id, Number(match[1]));
  if (view) await showPanel(env, callback, view);
  await answerCallback(env, callback.id,
    view ? '' : 'Nobody is on that booking.', !view);
}

async function removePickedPlayer(env, callback, match) {
  const chatId = callback.message.chat.id;
  const removed = await removeBookingPlayer(
    env, chatId, Number(match[1]), Number(match[2])
  );
  if (removed) {
    await updateBoard(env, chatId);
    await notifyRemovedPlayer(env, chatId, removed.player, removed.booking);
    const view = await bookingPanelView(env, chatId, Number(match[1]));
    if (view) await showPanel(env, callback, view);
  }
  await answerCallback(env, callback.id,
    removed ? `${removed.player.name} is off this booking.`
      : 'That player has already gone.', !removed);
}

async function openRemovePicker(env, callback, match) {
  const shown = await removePlayerView(env, callback.message.chat.id, Number(match[1]));
  if (shown) await showPanel(env, callback, shown);
  await answerCallback(env, callback.id,
    shown ? '' : 'Nobody is on that booking.', !shown);
}

async function raiseSlotCount(env, callback, match) {
  const chatId = callback.message.chat.id;
  const raised = await raiseCapacity(env, chatId, Number(match[1]));
  if (raised) {
    await updateBoard(env, chatId);
    const view = await bookingPanelView(env, chatId, Number(match[1]));
    if (view) await showPanel(env, callback, view);
  }
  await answerCallback(env, callback.id,
    raised ? `This court now holds ${raised} players.`
      : `That booking has gone, or it is already at the ${MAX_CAPACITY} player limit.`,
    !raised);
}

// A private send can come back as an ordinary group message. Everything
// addressed to one person — a panel, a receipt, a reply to a command — goes
// through this one gate, so a roster, a balance, or a reason somebody was
// charged is never left where everyone can read it: the public copy is
// deleted and the caller is told which happened, and owns the wording.
async function deliverPrivately(env, chatId, userId, html, options = {}) {
  const sent = await sendMessage(env, chatId, html, { ...options, receiverUserId: userId });
  if (!sent.ok || !sent.result) return { status: 'failed', sent };
  if (sent.result.ephemeral_message_id) return { status: 'private', sent };
  if (sent.result.message_id) {
    const removed = await deleteMessage(env, chatId, sent.result.message_id);
    return { status: 'public-fallback', sent, removed };
  }
  return { status: 'failed', sent };
}

function sendPrivatePanel(env, callback, view) {
  return deliverPrivately(env, callback.message.chat.id, callback.from.id, view.html, {
    callbackQueryId: callback.id,
    replyMarkup: view.replyMarkup,
  });
}

function editSucceeded(result) {
  return result.ok
    || String(result.description || '').includes('message is not modified');
}

// Panels are private to one person. The first tap comes off the shared pinned
// board and has to open a new ephemeral message; every tap after that arrives
// from inside the panel and edits it in place. Nothing here ever writes to the
// pinned message, which is what used to publish hidden bookings to the group.
async function showPanel(env, callback, view) {
  const chatId = callback.message.chat.id;
  const ephemeralId = callback.message.ephemeral_message_id;
  if (ephemeralId) {
    const edited = await editEphemeralMessage(
      env, chatId, callback.from.id, ephemeralId, view.html, view.replyMarkup
    );
    if (!editSucceeded(edited)) {
      throw new Error(`Could not update private panel: ${edited.description || 'unknown Telegram error'}`);
    }
    return edited;
  }
  const delivery = await sendPrivatePanel(env, callback, view);
  if (delivery.status !== 'private') {
    const removal = delivery.status === 'public-fallback' && delivery.removed && !delivery.removed.ok
      ? `; public fallback could not be removed: ${delivery.removed.description || 'unknown error'}`
      : '';
    throw new Error(`Could not deliver private panel (${delivery.status})${removal}`);
  }
  return delivery.sent;
}

// The court list is a private message to one person, so it is edited in place
// through the ephemeral API. Taps that arrive from anywhere else are left alone.
async function refreshJoinPicker(env, callback) {
  const ephemeralId = callback.message && callback.message.ephemeral_message_id;
  if (!ephemeralId) return;
  const chatId = callback.message.chat.id;
  // The promise overlaps the picker's reads, exactly as the sb:join open does.
  const view = await joinPickerView(
    env, chatId, callback.from, isChatAdmin(env, chatId, callback.from)
  );
  const edited = await editEphemeralMessage(
    env, chatId, callback.from.id, ephemeralId,
    view ? view.html : '🎾 <i>Nothing left to join.</i>',
    view ? view.replyMarkup : { inline_keyboard: [] }
  );
  if (!editSucceeded(edited)) {
    throw new Error(`Could not refresh private court list: ${edited.description || 'unknown Telegram error'}`);
  }
}

async function dismissMessage(env, callback) {
  const ephemeralId = callback.message && callback.message.ephemeral_message_id;
  if (ephemeralId) {
    await deleteEphemeralMessage(env, callback.message.chat.id, callback.from.id, ephemeralId);
    return;
  }
  const messageId = callback.message && callback.message.message_id;
  if (!messageId) return;
  const chatId = callback.message.chat.id;
  // The pinned board, the pinned tab, and the availability announcement wear
  // no dismiss button, but Telegram never checks callback data against the
  // keyboard it drew, so anyone can send sb:ok naming one of them and have the
  // group's own record deleted. Their ids are read back and refused; every
  // other non-ephemeral message this button lands on is a receipt the tapper
  // is entitled to clear.
  const [pinned, notice] = await Promise.all([
    env.DB.prepare(
      'SELECT board_message_id, tab_message_id FROM settings WHERE chat_id = ?'
    ).bind(chatId).first(),
    env.DB.prepare(
      'SELECT message_id FROM availability_notices WHERE chat_id = ?'
    ).bind(chatId).first(),
  ]);
  const shared = [
    pinned && pinned.board_message_id, pinned && pinned.tab_message_id,
    notice && notice.message_id,
  ].filter(Boolean).map(Number);
  if (shared.includes(Number(messageId))) return;
  await deleteMessage(env, chatId, messageId);
}

// tb:mine carries no guard on purpose: anyone may read their own breakdown.
// Everything under it settles money or reads somebody else's, which is admin
// work — the same table shape as the board's, gated the same way.
const SETTLE_ADMIN = 'Only group admins can settle the tab.';
const tabRoutes = [
  { pattern: /^tb:mine$/, handler: openMyTab },
  { pattern: /^tb:mine:(.+)$/, admin: 'Only group admins can read another tab.', handler: openTheirTab },
  { pattern: /^tb:back$/, admin: SETTLE_ADMIN, handler: closeSettlePicker },
  { pattern: /^tb:pay$/, admin: SETTLE_ADMIN, handler: openSettlePicker },
  { pattern: /^tb:paid:(.+)$/, admin: SETTLE_ADMIN, handler: settleTapped },
  { pattern: /^tb:pay:(.+)$/, admin: SETTLE_ADMIN, handler: confirmSettle },
];

function handleTabCallback(env, callback) {
  if (!String(callback.data || '').startsWith('tb:') || !callback.message) {
    return false;
  }
  return dispatchCallback(env, callback, tabRoutes);
}

// The first tap comes off the pinned tab and opens a new private message; a
// Back tap from inside a panel edits it in place, which showPanel tells apart
// by itself.
async function openMyTab(env, callback) {
  const chatId = callback.message.chat.id;
  // The admin lookup overlaps the ledger reads; myTabView awaits it late.
  const view = await myTabView(
    env, chatId, callback.from, isChatAdmin(env, chatId, callback.from)
  );
  await showPanel(env, callback, view);
  // A first open comes off the pinned tab and lands as a new message below
  // it, which nothing announces — an ephemeral message arrives without a
  // notification, so the chat does not always scroll to it. The toast says
  // where to look, exactly as the join picker's does. A tap from inside a
  // panel edits it in place, where a pointer would only mislead.
  await answerCallback(env, callback.id,
    callback.message.ephemeral_message_id ? '' : '🧾 Your tab is below ⬇️');
}

async function openTheirTab(env, callback, match) {
  const view = await theirTabView(env, callback.message.chat.id, match[1]);
  if (view) await showPanel(env, callback, view);
  await answerCallback(env, callback.id,
    view ? '' : 'Nothing on that tab any more.', !view);
}

async function closeSettlePicker(env, callback) {
  await updateTab(env, callback.message.chat.id);
  await answerCallback(env, callback.id);
}

async function openSettlePicker(env, callback) {
  const chatId = callback.message.chat.id;
  await editReplyMarkup(env, chatId, callback.message.message_id,
    await settleMarkup(env, chatId));
  await answerCallback(env, callback.id, 'Choose whose debt to clear');
}

async function settleTapped(env, callback, match) {
  const chatId = callback.message.chat.id;
  const settled = await settleUser(env, chatId, match[1], callback.from);
  // The ledger went quiet for the one person it is about: close the loop
  // with a private receipt, if they have an id to send it to. Through the
  // same gate as every panel: a receipt naming a balance must not fall back
  // to the group, and the admin hears when it did not land.
  let told = '';
  if (settled && settled.user_id) {
    const receipt = await deliverPrivately(env, chatId, settled.user_id,
      `✅ <b>Payment received</b> — your ${formatMoney(settled.balance)} ` +
      'squash tab is settled. Thank you!',
      { replyMarkup: OK_MARKUP });
    if (receipt.status !== 'private') told = ' · they could not be told privately';
  }
  await answerCallback(env, callback.id,
    settled ? `${settled.name} cleared · ${formatMoney(settled.balance)}${told}`
      : 'That balance is already clear.', !settled);
}

async function confirmSettle(env, callback, match) {
  const chatId = callback.message.chat.id;
  const confirmation = await confirmSettleMarkup(env, chatId, match[1]);
  if (!confirmation) {
    await updateTab(env, chatId);
    await answerCallback(env, callback.id, 'That balance is already clear.', true);
    return;
  }
  await editReplyMarkup(env, chatId, callback.message.message_id, confirmation.markup);
  await answerCallback(env, callback.id);
}

// Every command answers whoever sent it and nobody else, which is the whole
// point of the bot: the group keeps the pinned board and tab, not the traffic.
function privateReply(env, msg, html, replyMarkup = OK_MARKUP) {
  return deliverPrivately(env, msg.chat.id, msg.from.id, html, {
    replyToEphemeral: msg.ephemeral_message_id || null,
    replyMarkup,
  });
}

// Reads the same to the debtor and about them. A balance is only ever one of
// three things, and saying which is what closes the loop a /debt entry opens:
// the amount moved means little without where it left the person.
function standingLine(subject, balance, secondPerson = false) {
  const [owe, be] = secondPerson ? ['owe', 'are'] : ['owes', 'is'];
  if (balance > 0) return `${subject} now ${owe} <b>${formatMoney(balance)}</b>.`;
  if (balance < 0) return `${subject} ${be} <b>${formatMoney(-balance)}</b> in credit.`;
  return `${subject} ${be} all settled.`;
}

const DEBT_USAGE = 'Use <code>/debt +AMOUNT player reason</code>.\n\n'
  + '<code>/debt +2 jared mcdonalds ice cream</code> — adds $2 to what Jared owes\n'
  + '<code>/debt -1 jared played only 30 mins</code> — takes $1 off\n\n'
  + 'The reason is required — it is what they read on their own tab.';
const DEBT_ERRORS = {
  usage: DEBT_USAGE,
  amount: `That is not an amount I can read.\n\n${DEBT_USAGE}`,
  huge: 'That is over $1,000, which is a typo more often than not. '
    + 'Send it as smaller entries if you meant it.',
  long: 'That reason is too long for a tab line — keep it under 120 characters.',
};

// Clearing the message needs the Delete Messages admin right. Failing quietly
// would leave the booking in the group while the bot behaves as though it had
// been cleared, so whoever sent it is told to fix the permission.
async function clearSentMessage(env, msg, kind = 'booking message') {
  const deleted = await deleteMessage(env, msg.chat.id, msg.message_id);
  if (deleted.ok) return;
  await sendMessage(env, msg.chat.id,
    `⚠️ Your ${kind} is still in the group — I need the ` +
    '<b>Delete Messages</b> admin right to clear it.',
    { receiverUserId: msg.from.id, replyMarkup: OK_MARKUP });
}

export async function handleUpdate(env, update) {
  const callback = update.callback_query;
  if (callback && callback.message) {
    if (!chatAllowed(env, callback.message.chat)) return;
    try {
      await rememberPlayer(env, callback.from);
      await rememberLedgerIdentity(env, callback.message.chat.id, callback.from);
      if (await handleBoardCallback(env, callback)) return;
      if (await handleTabCallback(env, callback)) return;
      await handleBookingCallback(env, callback);
    } catch (error) {
      console.log(`Callback failed: ${error.stack || error}`);
      // A tap must never die silently: an unanswered callback leaves the
      // button spinning, which reads as a dead bot — even when the change
      // itself committed before the failure. Answering twice is harmless;
      // Telegram ignores the second answer.
      await answerCallback(env, callback.id,
        '⚠️ Something went wrong. Please try again.', true);
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
    await rememberLedgerIdentity(env, msg.chat.id, msg.from);
    if (await handleBookingReply(env, msg)) return;
    if (!text.startsWith('/')) {
      // The booking form repeats the text back, and the pinned board is the
      // record, so the original message is cleared out of the group. The intent
      // is read up front and the delete runs in a finally, because a form that
      // fails to open would otherwise leave the booking sitting in the chat.
      const isBooking = looksLikeBooking(text);
      // The gate is deliberately loose — "I booked 2 tickets" reads as a
      // booking — and it is the delete that makes that expensive: ordinary
      // chat from a member was being cleared out of the group for looking
      // like a court. The operator books every court and is a group admin,
      // so anyone else's booking-shaped text is left exactly as it is: no
      // form, nothing deleted, nothing said. The admin lookup is a Telegram
      // round trip, which is why it hangs off isBooking rather than running
      // on every message in the chat. /book stays open to everyone.
      if (isBooking && !(await isChatAdmin(env, msg.chat.id, msg.from))) return;
      try {
        await beginBooking(env, msg, text);
      } finally {
        if (isBooking && msg.message_id) {
          clearedText = text;
          await clearSentMessage(env, msg);
        }
      }
      return;
    }

    // People punctuate commands the way they punctuate sentences — "/book,
    // tmr c4 9pm" — and the strict shape used to drop exactly that on the
    // floor without a word, which reads as a broken bot. One trailing
    // punctuation mark after the command (or its @mention) is forgiven, and
    // the args begin wherever they begin.
    const match = text.match(/^\/(\w+)(@\w+)?[,.:;!]?\s*([\s\S]*)$/);
    if (!match) return;
    const command = match[1].toLowerCase();
    const mention = match[2] || null;
    const args = match[3].trim();
    const knownCommands = new Set([
      'start', 'help', 'book', 'courts', 'cancel', 'tab', 'debt',
    ]);
    // A command addressed @another_bot is theirs, not this bot's — including
    // a /cancel or a /debt that happens to share a name. The username is one
    // getMe per isolate, asked for only when a mention is present; when the
    // lookup fails the command is answered as before, since a bot ignoring
    // its own commands reads as dead and answering a stranger's is only noise.
    if (mention) {
      const me = await botUsername(env);
      if (me && mention.slice(1).toLowerCase() !== me) return;
    }
    // A command the bot does not know used to get silence, which reads exactly
    // like a broken bot.
    if (!knownCommands.has(command)) {
      if (mention) return;
      await sendMessage(env, msg.chat.id,
        `I don't know <code>/${escapeHtml(command)}</code>. ` +
        'Try /book, /courts, /tab, /cancel, or /help.',
        {
          receiverUserId: msg.from.id,
          replyToEphemeral: msg.ephemeral_message_id || null,
          replyMarkup: OK_MARKUP,
        });
      return;
    }
    // Only a public copy can be cleared. A command Telegram delivered
    // ephemerally is already private to whoever sent it, and the bot cannot
    // remove it: deleteEphemeralMessage takes the id of a user who *received* a
    // message from the bot, so it only reaches the bot's own ephemeral
    // messages. Aimed at an incoming command it answers MESSAGE_NOT_FOUND.
    // clearSentMessage reports Telegram failures itself and resolves, so it is
    // safe to start here and await alongside the command's useful work.
    const clearCommand = knownCommands.has(command) && msg.message_id && !msg.ephemeral_message_id
      ? clearSentMessage(env, msg, 'command')
      : Promise.resolve();

    if (command === 'start' || command === 'help') {
      const [replyMarkup] = await Promise.all([
        helpBoardMarkup(env, msg.chat.id), clearCommand,
      ]);
      await sendMessage(env, msg.chat.id, helpHtml(env), {
        receiverUserId: msg.from.id,
        replyToEphemeral: msg.ephemeral_message_id || null,
        replyMarkup,
      });
      return;
    }
    if (command === 'book') {
      await Promise.all([
        beginBooking(env, msg, args, { forceIntent: true }), clearCommand,
      ]);
      return;
    }
    // Both refresh commands answer even when nothing changed: a command whose
    // success looks identical to silence cannot be told apart from a broken
    // bot, which is exactly how one outage went unnoticed.
    if (command === 'courts') {
      const [pinned] = await Promise.all([
        updateBoard(env, msg.chat.id), clearCommand,
      ]);
      await sendMessage(env, msg.chat.id,
        pinned ? '🎾 Board refreshed — it is the pinned message.'
          : '🎾 Nothing is booked right now, so there is no board. It returns with the next booking.', {
          receiverUserId: msg.from.id,
          replyToEphemeral: msg.ephemeral_message_id || null,
          replyMarkup: OK_MARKUP,
        });
      return;
    }
    if (command === 'tab') {
      const [pinned] = await Promise.all([
        updateTab(env, msg.chat.id), clearCommand,
      ]);
      if (pinned) {
        await sendMessage(env, msg.chat.id,
          '💰 Tab refreshed — it is the pinned message.', {
            receiverUserId: msg.from.id,
            replyToEphemeral: msg.ephemeral_message_id || null,
            replyMarkup: OK_MARKUP,
          });
        return;
      }
      // With everyone settled there is no pinned tab and so no 🧾 button —
      // which left no way at all to read your own history. The command is the
      // only door left, so it opens the same private breakdown the button does.
      // It carries their own charges, so it goes through the gate that keeps
      // a private breakdown out of the group.
      const view = await myTabView(
        env, msg.chat.id, msg.from, isChatAdmin(env, msg.chat.id, msg.from)
      );
      await privateReply(env, msg,
        `💰 Nothing outstanding on the group tab.\n\n${view.html}`, view.replyMarkup);
      return;
    }
    // Money the courts did not produce: a ball somebody replaced, cash handed
    // over outside the tab, half an hour of a court somebody missed. It moves
    // money, so it is admin-gated like every other route that does, and it
    // lands as an ordinary ledger row — which is what puts it in that
    // person's own breakdown, reason and all, beside the courts they played.
    if (command === 'debt') {
      const [admin] = await Promise.all([
        isChatAdmin(env, msg.chat.id, msg.from), clearCommand,
      ]);
      if (!admin) {
        await privateReply(env, msg, 'Only group admins can change what someone owes.');
        return;
      }
      const parsed = parseDebtAdjustment(args);
      if (parsed.error) {
        await privateReply(env, msg, DEBT_ERRORS[parsed.error]);
        return;
      }
      const matched = matchAccount(await knownPlayers(env, msg.chat.id), parsed.target);
      if (matched.error) {
        const who = `<b>${escapeHtml(parsed.target)}</b>`;
        await privateReply(env, msg, matched.error === 'ambiguous'
          ? `More than one player answers to ${who} — name them by @handle.`
          : `I don't know ${who}. Only somebody already on a court or on the tab `
            + 'can be charged, so that a typo never opens an account of its own.');
        return;
      }
      // The organiser pays the courts and the household plays on them for
      // free: none of them has a tab, and a row for one would put the
      // organiser on their own tab as a debtor.
      if (isHouseholdPlayer(env, matched.player)) {
        await privateReply(env, msg,
          `<b>${escapeHtml(matched.player.name)}</b> plays for free and is never on the tab.`);
        return;
      }
      const entry = await adjustBalance(
        env, msg.chat.id, matched.player, parsed.cents, parsed.reason, msg.from
      );
      const moved = `${formatMoney(Math.abs(entry.cents))} `
        + `${entry.cents > 0 ? 'added to' : 'taken off'}`;
      // The ledger just moved for somebody who was not in the conversation, so
      // they hear it from the bot with the reason attached — the same receipt
      // a settlement sends, and for the same reason. Reachable only once they
      // have posted at least once, which is what gives them a numeric id. The
      // receipt names a balance and a reason, so it goes through the gate
      // that keeps it out of the group, and the admin is told when it did not
      // land: an unprompted ephemeral is the kind Telegram is likeliest to
      // drop, and the entry is only fair once the person knows about it.
      let told = '';
      if (entry.userId) {
        const receipt = await deliverPrivately(env, msg.chat.id, entry.userId,
          `🧾 <b>${moved} your squash tab</b>\n\n${escapeHtml(parsed.reason)}\n\n`
          + standingLine('You', entry.balance, true),
          { replyMarkup: OK_MARKUP });
        if (receipt.status !== 'private') {
          told = '\n\nThey could not be told privately, so let them know yourself.';
        }
      } else {
        told = '\n\nThey have never posted here, so they were not told.';
      }
      await privateReply(env, msg,
        `✅ <b>${moved} ${escapeHtml(entry.name)}'s tab</b> — `
        + `${escapeHtml(parsed.reason)}.\n\n`
        + standingLine(escapeHtml(entry.name), entry.balance) + told);
      return;
    }
    if (command === 'cancel') {
      if (!/^\d+$/.test(args)) {
        await Promise.all([clearCommand, sendMessage(env, msg.chat.id,
          'Use <code>/cancel ID</code>, for example <code>/cancel 3</code>.', {
            receiverUserId: msg.from.id,
            replyToEphemeral: msg.ephemeral_message_id || null,
            replyMarkup: OK_MARKUP,
          })]);
        return;
      }
      const [result] = await Promise.all([
        cancelBooking(env, msg.chat.id, Number(args), msg.from, `/cancel ${args}`),
        clearCommand,
      ]);
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
          replyMarkup: OK_MARKUP,
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
        replyMarkup: OK_MARKUP,
      });
  }
}

// How long the webhook response may wait for the first toast. The slowest
// pre-answer path — opening the court list, one ephemeral send to Amsterdam —
// sits well under a second, so anything past this bound is Telegram misbehaving,
// where a plain ok and an HTTPS answer is the safer shape.
const WEBHOOK_ANSWER_WAIT_MS = 2000;

// How stale the maintenance heartbeat may read before the root URL answers
// 500. Five minutes of missed every-minute ticks is an outage, not a blip.
const HEARTBEAT_STALE_S = 5 * 60;

function adminAuthorized(request, env) {
  if (!env.ADMIN_SECRET) return false;
  return request.headers.get('Authorization') === `Bearer ${env.ADMIN_SECRET}`
    || request.headers.get('X-Admin-Secret') === env.ADMIN_SECRET;
}

// How long an update id is remembered. Telegram gives up redelivering long
// before this, and the table is pruned on every arrival so it never grows
// past a day of traffic.
const PROCESSED_UPDATE_TTL_MS = 24 * 60 * 60 * 1000;

// Telegram redelivers an update until the webhook answers 2xx, and nothing
// else here tells a redelivery from a new tap or command. Charges are unique
// per booking and player, and a settlement is conditional on the balance it
// read — but a /debt entry is a plain append, so a redelivered one is a second
// row on somebody's tab. Every update is recorded by id before it is handled;
// a repeat is answered ok and dropped. An update with no id (tests, hand-sent
// requests) is handled as before. The bookkeeping must not cost the update
// itself, so a failure here is logged and the update goes through.
async function firstSighting(env, update) {
  const updateId = update && update.update_id;
  if (!Number.isInteger(updateId)) return true;
  const now = Date.now();
  const record = env.DB.prepare(
    'INSERT OR IGNORE INTO processed_updates (update_id, seen_at) VALUES (?, ?)'
  ).bind(updateId, now);
  const prune = env.DB.prepare('DELETE FROM processed_updates WHERE seen_at < ?')
    .bind(now - PROCESSED_UPDATE_TTL_MS);
  try {
    let inserted;
    if (typeof env.DB.batch === 'function') {
      [inserted] = await env.DB.batch([record, prune]);
    } else {
      inserted = await record.run();
      await prune.run();
    }
    // A double that reports no change count is read as a first sighting: the
    // only safe misreading is the one that handles an update.
    return !(inserted && inserted.meta && inserted.meta.changes === 0);
  } catch (error) {
    console.log(`Update dedup failed: ${error.stack || error}`);
    return true;
  }
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
      if (!(await firstSighting(env, update))) {
        console.log(`Update ${update.update_id} redelivered by Telegram; already handled`);
        return new Response('ok');
      }
      const callback = update && update.callback_query;
      if (callback && callback.id) {
        const started = Date.now();
        // The first toast rides back on this very response when it is ready in
        // time, sparing the tapper the round trip to Amsterdam that a separate
        // answerCallbackQuery costs. The wait is bounded: past it the arm is
        // dropped, the answer falls back to HTTPS, and Telegram is not left
        // holding the webhook long enough to redeliver the whole update.
        const reply = armWebhookAnswer(callback.id);
        ctx.waitUntil(handleUpdate(env, update).finally(() => reply.disarm()));
        const answer = await Promise.race([
          reply.promise,
          new Promise((resolve) => setTimeout(() => resolve(null), WEBHOOK_ANSWER_WAIT_MS)),
        ]);
        if (!answer) reply.disarm();
        // One line per tap for `npx wrangler tail`: the colo names which side
        // of the world this ran on — next to Telegram (EU colos) or next to
        // the D1 primary (SIN) — and the duration is what the tapper waited
        // for their toast. Slowness blames whichever backend is far away.
        console.log(
          `Webhook callback handled at ${(request.cf && request.cf.colo) || 'unknown colo'}: `
          + `${answer ? 'toast rode the response' : 'no toast in time'} `
          + `after ${Date.now() - started}ms`
        );
        return answer
          ? new Response(JSON.stringify(answer), {
            headers: { 'Content-Type': 'application/json' },
          })
          : new Response('ok');
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
      // is_ephemeral, so a command is never a group message even for the moment
      // before it would be deleted. The cost is that it cannot be cleared at
      // all: deleteEphemeralMessage reaches only messages the bot itself sent,
      // and answers MESSAGE_NOT_FOUND for an incoming command, which therefore
      // stays in the sender's own chat. Nobody else ever sees it, and that is
      // the trade this bot makes — it exists to keep booking out of the group.
      // The menu is scoped: members see the everyday commands, group admins
      // additionally see /cancel — parameterised and rarely theirs to run, so
      // it only earns menu space for the people managing bookings. Typing a
      // command still works for anyone the handler allows; scope only changes
      // the menu.
      const memberCommands = [
        { command: 'book', description: 'Add a court booking', is_ephemeral: true },
        { command: 'courts', description: 'Show or refresh the pinned court board', is_ephemeral: true },
        { command: 'tab', description: 'Show or refresh the pinned money tab', is_ephemeral: true },
        { command: 'help', description: 'Show examples', is_ephemeral: true },
      ];
      const adminCommands = [
        ...memberCommands,
        { command: 'cancel', description: 'Cancel a booking by ID', is_ephemeral: true },
        { command: 'debt', description: "Add to or take off a player's tab", is_ephemeral: true },
      ];
      const commands = await telegram(env, 'setMyCommands', { commands: adminCommands });
      const groupMenu = await telegram(env, 'setMyCommands', {
        commands: memberCommands, scope: { type: 'all_group_chats' },
      });
      const adminMenu = await telegram(env, 'setMyCommands', {
        commands: adminCommands, scope: { type: 'all_chat_administrators' },
      });
      const profile = await telegram(env, 'setMyName', { name: 'SquashBot' });
      const allowedChatIds = String(env.ALLOWED_CHATS || '').split(',').map((id) => id.trim()).filter(Boolean);
      const chats = await Promise.all(allowedChatIds.map((chatId) => telegram(env, 'getChat', { chat_id: chatId })));
      const ok = webhook.ok && commands.ok && groupMenu.ok && adminMenu.ok
        && profile.ok && chats.every((chat) => chat.ok);
      const chatNames = chats.filter((chat) => chat.ok).map((chat) => chat.result.title || chat.result.id).join(', ');
      return new Response(ok
        ? `SquashBot webhook, commands, and profile are ready. Allowed chats: ${chatNames}.`
        : JSON.stringify({ webhook, commands, groupMenu, adminMenu, profile, chats }), {
        status: ok ? 200 : 500,
      });
    }

    if (url.pathname === '/refresh') {
      if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });
      if (!adminAuthorized(request, env)) return new Response('forbidden', { status: 403 });
      const chatIds = String(env.ALLOWED_CHATS || '').split(',').map((id) => id.trim()).filter(Boolean);
      const outcomes = await Promise.all(chatIds.map(async (chatId) => {
        try {
          await updateBoard(env, Number(chatId));
          await updateTab(env, Number(chatId));
          return `${chatId}: ok`;
        } catch (error) {
          console.log(`Refresh for chat ${chatId} failed: ${error.stack || error}`);
          return `${chatId}: failed (${error.message})`;
        }
      }));
      return new Response(`Refreshed board and tab — ${outcomes.join('; ')}`);
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

    // The root is a health check, not a greeting: the maintenance heartbeat
    // is the one signal that proves the cron and the database both work, so
    // a dumb uptime pinger watching this URL catches a dead bot in minutes.
    // Fresh is generous — the cron fires every minute.
    try {
      const row = await env.DB.prepare('SELECT beat_at FROM heartbeat WHERE id = 1').first();
      if (!row) {
        return new Response('squashbot is running, but no maintenance tick is recorded yet',
          { status: 500 });
      }
      const staleSeconds = Math.round((Date.now() - row.beat_at) / 1000);
      if (staleSeconds > HEARTBEAT_STALE_S) {
        return new Response(
          `squashbot maintenance is stale — last tick ${staleSeconds}s ago`, { status: 500 }
        );
      }
      return new Response(`squashbot is running — last maintenance tick ${staleSeconds}s ago`);
    } catch (error) {
      // The root is public and unauthenticated, so the detail stays in the
      // log: a database error message can name tables, bindings, or SQL.
      console.log(`Health check database read failed: ${error.stack || error}`);
      return new Response('squashbot database check failed', { status: 500 });
    }
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil((async () => {
      const maintenance = await runScheduledMaintenance(env, runMaintenance, pruneBookingDrafts);
      if (!maintenance.ok) {
        console.log(`Maintenance heartbeat withheld: ${maintenance.failures.join('; ')}`);
        return;
      }
      // Stamped only after a full pass, so staleness at the root measures the
      // whole cron path — a sweep that hangs holds the beat back with it.
      await env.DB.prepare(
        `INSERT INTO heartbeat (id, beat_at) VALUES (1, ?)
         ON CONFLICT(id) DO UPDATE SET beat_at = excluded.beat_at`
      ).bind(Date.now()).run();
    })());
  },
};

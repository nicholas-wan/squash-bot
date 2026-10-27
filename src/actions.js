import { notifyRemovedPlayer, notifyRosterOfChange, updateBoard } from './bookings.js';
import {
  adminAddPlayer, isHouseholdPlayer, joinBooking, knownPlayers, leaveBooking, MAX_CAPACITY,
  ownerName, raiseCapacity, removeBookingPlayer, toggleBooking, toggleOwnerGuest, togglePlusOne,
} from './players.js';

// The roster changes an admin makes from the Manage panels. Each one used to
// live inside its callback handler, which left the Mini App two choices: call
// the handler with a fake tap, or copy the notices and board refresh and let
// them drift. Both surfaces now call these, and each answers with the words
// its own toast shows: `changed` says the roster moved, `alert` that the
// message is a refusal worth an alert rather than a passing toast.

function subject(player, name = player.name) {
  return {
    id: player.user_id || null,
    username: player.slug.startsWith('@') ? player.slug.slice(1) : null,
    first_name: name,
  };
}

// The organiser and household are never billed, so their +1 costs nobody
// anything, and talk of two shares would be wrong for them.
function plusOneCost(env, player) {
  return isHouseholdPlayer(env, player) ? 'the +1 plays free' : 'two shares on the tab';
}

function told(allTold, everyone = 'Everyone has been told.') {
  return allTold ? everyone : 'Some players could not be notified.';
}

export async function seatPlayer(env, chatId, bookingId, slug, heads, actorId) {
  // Resolved fresh rather than trusted from the caller, so a stale panel
  // cannot seat somebody under an outdated name or id.
  const candidate = (await knownPlayers(env, chatId)).find((player) => player.slug === slug);
  if (!candidate) {
    return { status: 'unknown', changed: false, alert: true, message: 'That player is no longer known.' };
  }
  const result = await adminAddPlayer(env, chatId, bookingId, candidate, actorId, heads);
  if (result.status !== 'added') {
    const refusals = {
      already: 'They are already on that court.',
      full: heads > 1
        ? 'A +1 needs two free slots. Open another one first.'
        : 'That court is full. Open another slot first.',
      gone: 'That booking has already gone.',
    };
    return { status: result.status, changed: false, alert: true, message: refusals[result.status] };
  }
  // The seated player is the subject of the notice, not the admin tapping.
  const { allTold } = await notifyRosterOfChange(
    env, chatId, result.booking, subject(candidate), 'added', heads
  );
  await updateBoard(env, chatId);
  const delivery = told(allTold, 'Everyone on it has been told.');
  return {
    status: 'added', changed: true, alert: false,
    message: heads > 1
      ? `${candidate.name} +1 are on this court — ${plusOneCost(env, candidate)}. ${delivery}`
      : `${candidate.name} is on this court. ${delivery}`,
  };
}

export async function flipPlusOne(env, chatId, bookingId, playerRowId) {
  const result = await togglePlusOne(env, chatId, bookingId, playerRowId);
  if (result.status !== 'plus' && result.status !== 'minus') {
    const refusals = {
      full: 'No free slot for a +1. Open another slot first.',
      gone: 'That player or booking has already gone.',
    };
    return { status: result.status, changed: false, alert: true, message: refusals[result.status] };
  }
  // The member whose share changed is the subject, not the tapping admin.
  const { allTold } = await notifyRosterOfChange(
    env, chatId, result.booking, subject(result.player), result.status
  );
  await updateBoard(env, chatId);
  const name = result.player.name;
  return {
    status: result.status, changed: true, alert: false,
    message: result.status === 'plus'
      ? `${name} now brings a +1 — ${plusOneCost(env, result.player)}. ${told(allTold)}`
      : `${name}'s +1 is off — one share again. ${told(allTold)}`,
  };
}

// The organiser's free guest: somebody seated on the organiser's +1 is charged
// to nobody.
export async function flipOwnerGuest(env, chatId, bookingId, actorId) {
  const result = await toggleOwnerGuest(env, chatId, bookingId, actorId);
  const host = ownerName(env);
  if (result.status !== 'plus' && result.status !== 'minus') {
    const refusals = {
      full: 'No free slot for a guest. Open another slot first.',
      already: 'That court has changed — open the picker again.',
      gone: 'That booking has already gone.',
    };
    return { status: result.status, changed: false, alert: true, message: refusals[result.status] };
  }
  const { allTold } = await notifyRosterOfChange(
    env, chatId, result.booking, subject(result.player, host), result.status
  );
  await updateBoard(env, chatId);
  return {
    status: result.status, changed: true, alert: false,
    message: result.status === 'plus'
      ? `${host} +1 is on — the guest is not charged. ${told(allTold)}`
      : `${host}'s guest is off. ${told(allTold)}`,
  };
}

export async function kickPlayer(env, chatId, bookingId, playerRowId) {
  const removed = await removeBookingPlayer(env, chatId, bookingId, playerRowId);
  if (!removed) {
    return { status: 'gone', changed: false, alert: true, message: 'That player has already gone.' };
  }
  await updateBoard(env, chatId);
  await notifyRemovedPlayer(env, chatId, removed.player, removed.booking);
  return {
    status: 'removed', changed: true, alert: false,
    message: `${removed.player.name} is off this booking.`,
  };
}

export async function addSlot(env, chatId, bookingId) {
  const raised = await raiseCapacity(env, chatId, bookingId);
  if (!raised) {
    return {
      status: 'refused', changed: false, alert: true,
      message: `That booking has gone, or it is already at the ${MAX_CAPACITY} player limit.`,
    };
  }
  await updateBoard(env, chatId);
  return {
    status: 'raised', changed: true, alert: false,
    message: `This court now holds ${raised} players.`,
  };
}

// A member taking or giving up their own slot. The chat button answers its tap
// between the move and the notices, so the two halves are separate: the move,
// then whatever the caller does first, then settleSlotMove.
const SLOT_REFUSALS = {
  already: 'You are already on that court.',
  'identity-conflict': 'That username is already tied to another player on this court. '
    + 'Ask an admin to update the roster.',
  absent: 'You were not on that court.',
  full: 'That court is full. A group admin can open another slot.',
  started: 'That court has already started, so the roster is locked.',
  gone: 'That booking has already gone.',
};

export async function moveOwnSlot(env, chatId, bookingId, from, action) {
  const move = { tap: toggleBooking, join: joinBooking, leave: leaveBooking }[action];
  const result = await move(env, chatId, bookingId, from);
  const moved = result.status === 'joined' || result.status === 'left';
  return {
    ...result,
    changed: moved,
    alert: !moved,
    message: moved
      ? (result.status === 'left' ? 'You are out. Your slot is free again.' : 'You are in.')
      : SLOT_REFUSALS[result.status],
  };
}

// Telling the court comes before the board: updateBoard throws when the pinned
// message cannot be edited or re-pinned, and that must not swallow the one
// notice the people on the court are waiting on.
export async function settleSlotMove(env, chatId, result, from, options = {}) {
  await notifyRosterOfChange(env, chatId, result.booking, from, result.status, 1, options);
  await updateBoard(env, chatId);
}

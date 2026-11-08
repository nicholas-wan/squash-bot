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

// The board is a drawing of what is already saved, so it never decides what a
// tap answers. A failed redraw used to throw out of these actions after the
// change had committed, which said "try again" about a change that had
// happened, and trying again undid a +1. updateBoard has queued its own retry
// by then, so the failure is only logged. With `defer` (the Mini App's
// waitUntil, or a list the chat handler drains after answering) the caller
// replies first and the board, and any notice behind it, follows.
// Work an action hands back to run once the tap is answered: the board, and
// for a member's own move the roster's notices. Chat updates already run
// inside waitUntil, so draining this at the end keeps the worker alive for it.
export function afterAnswer() {
  const jobs = [];
  return { defer: (work) => { jobs.push(work); }, drain: () => Promise.all(jobs) };
}

const noticeFailed = (error) => console.log(`Roster notice failed: ${error.stack || error}`);

function afterwards(work, defer) {
  const settled = work().catch((error) => {
    console.log(`Board refresh after a roster change failed: ${error.stack || error}`);
  });
  if (defer) {
    defer(settled);
    return undefined;
  }
  return settled;
}

export async function seatPlayer(env, chatId, bookingId, slug, heads, actorId, { defer } = {}) {
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
  // The notices are awaited: the answer says whether everyone was told.
  const { allTold } = await notifyRosterOfChange(
    env, chatId, result.booking, subject(candidate), 'added', heads
  );
  await afterwards(() => updateBoard(env, chatId), defer);
  const delivery = told(allTold, 'Everyone on it has been told.');
  return {
    status: 'added', changed: true, alert: false,
    message: heads > 1
      ? `${candidate.name} +1 are on this court — ${plusOneCost(env, candidate)}. ${delivery}`
      : `${candidate.name} is on this court. ${delivery}`,
  };
}

// A tap that finds the court already as the tapper wanted it is no change
// and no refusal: the caller redraws the court and says where it stands.
const unchanged = (message) => ({ status: 'same', changed: false, same: true, alert: false, message });

export async function flipPlusOne(env, chatId, bookingId, playerRowId, { want, defer } = {}) {
  const result = await togglePlusOne(env, chatId, bookingId, playerRowId, want);
  if (result.status === 'same') {
    return unchanged(want ? `${result.player.name} already brings a +1.`
      : `${result.player.name} has no +1.`);
  }
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
  await afterwards(() => updateBoard(env, chatId), defer);
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
export async function flipOwnerGuest(env, chatId, bookingId, actorId, { want, defer } = {}) {
  const result = await toggleOwnerGuest(env, chatId, bookingId, actorId, want);
  const host = ownerName(env);
  if (result.status === 'same') {
    return unchanged(want ? `${host} +1 is already on.` : `${host} has no guest on this court.`);
  }
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
  await afterwards(() => updateBoard(env, chatId), defer);
  return {
    status: result.status, changed: true, alert: false,
    message: result.status === 'plus'
      ? `${host} +1 is on — the guest is not charged. ${told(allTold)}`
      : `${host}'s guest is off. ${told(allTold)}`,
  };
}

// The removed player is told before the board is touched, by the same rule as
// settleSlotMove below: a board failure must not swallow their notice. The
// answer does not depend on it, so with `defer` both follow the reply.
export async function kickPlayer(env, chatId, bookingId, playerRowId, { defer } = {}) {
  const removed = await removeBookingPlayer(env, chatId, bookingId, playerRowId);
  if (!removed) {
    return { status: 'gone', changed: false, alert: true, message: 'That player has already gone.' };
  }
  await afterwards(async () => {
    await notifyRemovedPlayer(env, chatId, removed.player, removed.booking).catch(noticeFailed);
    await updateBoard(env, chatId);
  }, defer);
  return {
    status: 'removed', changed: true, alert: false,
    message: `${removed.player.name} is off this booking.`,
  };
}

export async function addSlot(env, chatId, bookingId, { expected, defer } = {}) {
  const raised = await raiseCapacity(env, chatId, bookingId, expected);
  if (!raised && Number.isInteger(expected)) {
    // The guard missed: somebody else raised it first, or it is gone.
    const now = await env.DB.prepare('SELECT capacity FROM bookings WHERE id = ?')
      .bind(bookingId).first();
    if (now && now.capacity > expected) {
      return unchanged(`This court already holds ${now.capacity} players.`);
    }
  }
  if (!raised) {
    return {
      status: 'refused', changed: false, alert: true,
      message: `That booking has gone, or it is already at the ${MAX_CAPACITY} player limit.`,
    };
  }
  await afterwards(() => updateBoard(env, chatId), defer);
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

// updateBoard throws when the pinned message cannot be edited or re-pinned,
// and that must not swallow the one notice the people on the court are
// waiting on. Each has its own catch, so the two run side by side: they are
// private messages and a pinned edit, and neither reads what the other wrote.
export async function settleSlotMove(env, chatId, result, from, options = {}) {
  const { defer, ...notice } = options;
  await afterwards(async () => {
    const [, board] = await Promise.allSettled([
      notifyRosterOfChange(env, chatId, result.booking, from, result.status, 1, notice)
        .catch(noticeFailed),
      updateBoard(env, chatId),
    ]);
    if (board.status === 'rejected') throw board.reason;
  }, defer);
}

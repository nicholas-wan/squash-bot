import {
  addSlot, flipOwnerGuest, flipPlusOne, kickPlayer, moveOwnSlot, seatPlayer, settleSlotMove,
} from './actions.js';
import {
  addBooking, authorizeBookingChange, BookingConflictError, BOOKING_CHANGED, BOOKING_STARTED,
  cancelBooking,
  courtDetail, courtList, getTimezone, updateBooking,
} from './bookings.js';
import { courtName, compactTimeRange, shortDate } from './format.js';
import { verifyInitData } from './miniapp-auth.js';
import { BookingParseError, bookingFromDraft, extractCourt } from './parser.js';
import { rememberLedgerIdentity } from './ledger-identity.js';
import { isChatAdmin, knownPlayers, rememberPlayer, RosterCapacityError } from './players.js';
import { allowedChats } from './scope.js';

// The Mini App's API. The page is only a drawing of these answers: who is
// asking comes from Telegram's signature, which group from the launch link's
// startapp value, and every call asks Telegram whether that person is an
// admin there. Members get the court list and their own Join and Leave, as
// the private 🙋 Join list gives them; everything else — reads included, since
// the rosters are what the shared board deliberately leaves out — is for
// admins. Refusals the chat panels show as alerts come back
// as { ok: false, message } with a 200, so the page has one way to show them;
// HTTP errors are kept for requests that should never have been made.

export const MANAGE_ADMIN = 'Only group admins can manage bookings.';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

// "g-1001234567890", optionally "_b42" for a link straight to one court.
function chatFromStartParam(env, startParam) {
  const match = String(startParam).match(/^g(-?\d+)(?:_b\d+)?$/);
  if (!match) return null;
  const chatId = Number(match[1]);
  return allowedChats(env).includes(chatId) ? chatId : null;
}

const parseDate = (value) => {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? { y: Number(match[1]), mo: Number(match[2]), d: Number(match[3]) } : null;
};
const parseClock = (value) => {
  const match = String(value || '').match(/^(\d{2}):(\d{2})$/);
  return match ? { h: Number(match[1]), mi: Number(match[2]) } : null;
};

// The form's fields go through the same rules as a typed booking: opening
// hours, a finish after the start, and the reminder times all come from
// bookingFromDraft. The court is read the way the parser reads "court 4".
function bookingFromForm(body, now, tz) {
  const court = extractCourt(`court ${String(body.court || '').replace(/^\s*court\s*/i, '')}`).value;
  if (!court) throw new BookingParseError('Type a court number or letter.');
  const draft = {
    date: parseDate(body.date), start: parseClock(body.start), end: parseClock(body.end), court,
  };
  if (!draft.date) throw new BookingParseError('Choose a date.');
  if (!draft.start) throw new BookingParseError('Choose a start time.');
  return bookingFromDraft(draft, now, tz);
}

async function conflictReply(env, chatId, error) {
  const tz = await getTimezone(env, chatId);
  return json({
    ok: false,
    conflict: true,
    message: 'This overlaps another booking. Save anyway?',
    conflicts: error.conflicts.map((booking) => `${courtName(booking)} · `
      + `${shortDate(booking.starts_at, tz)} · `
      + `${compactTimeRange(booking.starts_at, booking.ends_at, tz)}`),
  }, 409);
}

async function readBody(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

// After a change the court is drawn again from the database, so the page
// never has to guess what its own tap did.
async function actionReply(env, chatId, bookingId, result, user) {
  return json({
    ok: result.changed, message: result.message,
    court: await courtDetail(env, chatId, bookingId, user),
  });
}

// After a booking is added or changed an admin lands on its court screen; a
// member, who has no court screen, lands back on the list.
async function savedReply(env, chatId, bookingId, user, admin, message) {
  return json(admin
    ? { ok: true, message, court: await courtDetail(env, chatId, bookingId, user) }
    : { ok: true, message, ...(await courtList(env, chatId, { viewer: user, admin })) });
}

// A member's own slot. The reply is the whole list again, since that is the
// screen it was tapped on. The roster hears it as from the chat button; the
// member's own copy is skipped, because the app has just said it on screen.
async function slotReply(env, chatId, bookingId, user, admin, action) {
  const result = await moveOwnSlot(env, chatId, bookingId, user, action);
  if (result.changed) await settleSlotMove(env, chatId, result, user, { tellActor: false });
  return json({
    ok: result.changed, message: result.message,
    ...(await courtList(env, chatId, { viewer: user, admin })),
  });
}

// A route marked member is open to anyone in the group, as the private 🙋 Join
// list is; every other one is refused to a member before its handler runs.
const routes = [
  ['GET', /^courts$/, async ({ env, chatId, user, admin }) => json({
    ok: true, ...(await courtList(env, chatId, { viewer: user, admin })),
  }), { member: true }],
  ['POST', /^court\/(\d+)\/(join|leave)$/, async ({ env, chatId, match, user, admin }) =>
    slotReply(env, chatId, Number(match[1]), user, admin, match[2]), { member: true }],
  ['GET', /^court\/(\d+)$/, async ({ env, chatId, match, user }) => {
    const court = await courtDetail(env, chatId, Number(match[1]), user);
    return court
      ? json({ ok: true, court })
      : json({ ok: false, message: 'That booking has already gone.' });
  }],
  ['POST', /^court\/(\d+)\/seat$/, async ({ env, chatId, match, body, user }) => {
    const heads = Number(body.heads) === 2 ? 2 : 1;
    const result = await seatPlayer(
      env, chatId, Number(match[1]), String(body.slug || ''), heads, user.id
    );
    return actionReply(env, chatId, Number(match[1]), result, user);
  }],
  ['POST', /^court\/(\d+)\/plus$/, async ({ env, chatId, match, body, user }) => actionReply(
    env, chatId, Number(match[1]),
    await flipPlusOne(env, chatId, Number(match[1]), Number(body.player)), user
  )],
  ['POST', /^court\/(\d+)\/guest$/, async ({ env, chatId, match, user }) => actionReply(
    env, chatId, Number(match[1]),
    await flipOwnerGuest(env, chatId, Number(match[1]), user.id), user
  )],
  ['POST', /^court\/(\d+)\/kick$/, async ({ env, chatId, match, body, user }) => actionReply(
    env, chatId, Number(match[1]),
    await kickPlayer(env, chatId, Number(match[1]), Number(body.player)), user
  )],
  ['POST', /^court\/(\d+)\/capacity$/, async ({ env, chatId, match, user }) => actionReply(
    env, chatId, Number(match[1]), await addSlot(env, chatId, Number(match[1])), user
  )],
  // Changing, cancelling and adding are open to members on the same terms as
  // the chat: anyone may book, and whoever booked a court — or an admin — may
  // change or cancel it until it starts. authorizeBookingChange is that rule,
  // and cancelBooking applies it itself.
  ['POST', /^court\/(\d+)\/edit$/, async ({ env, chatId, match, body, user, admin, now }) => {
    const bookingId = Number(match[1]);
    const permitted = await authorizeBookingChange(env, chatId, bookingId, user, 'edit');
    if (!permitted.allowed) return json({ ok: false, message: permitted.message });
    const parsed = bookingFromForm(body, now, await getTimezone(env, chatId));
    let saved;
    try {
      saved = await updateBooking(
        env, chatId, bookingId, parsed, user, 'Edited in the Mini App',
        { allowConflict: Boolean(body.force), expected: body.expected || null }
      );
    } catch (error) {
      if (error instanceof BookingConflictError) return conflictReply(env, chatId, error);
      throw error;
    }
    const refusals = {
      started: BOOKING_STARTED,
      played: 'That court has already finished, so it can no longer be edited.',
      changed: BOOKING_CHANGED,
      false: 'That booking no longer exists.',
    };
    if (saved !== true) return json({ ok: false, message: refusals[String(saved)] });
    return savedReply(env, chatId, bookingId, user, admin, '✅ Booking updated');
  }, { member: true }],
  ['POST', /^court\/(\d+)\/delete$/, async ({ env, chatId, match, user, admin }) => {
    const result = await cancelBooking(
      env, chatId, Number(match[1]), user, 'Deleted in the Mini App'
    );
    if (result.status !== 'cancelled') return json({ ok: false, message: result.message });
    return json({
      ok: true, message: 'Booking cancelled',
      ...(await courtList(env, chatId, { viewer: user, admin })),
    });
  }, { member: true }],
  ['POST', /^courts$/, async ({ env, chatId, body, user, admin, now }) => {
    const parsed = bookingFromForm(body, now, await getTimezone(env, chatId));
    // Naming somebody else as the booker, and marking a court free, change who
    // is billed: admin-only, as in the chat wizard. A member's form never
    // shows them, and a hand-made request carrying them is not believed.
    // The booker is resolved fresh, as the wizard's picker does, so the page
    // cannot record somebody under a name or id the bot does not hold.
    let bookedFor = null;
    if (admin && body.booker) {
      const player = (await knownPlayers(env, chatId))
        .find((candidate) => candidate.slug === body.booker);
      if (!player) return json({ ok: false, message: 'That player is no longer known.' });
      bookedFor = { userId: player.user_id || null, slug: player.slug, name: player.name };
    }
    let bookingId;
    try {
      bookingId = await addBooking(env, chatId, parsed, user, 'Added in the Mini App', {
        allowConflict: Boolean(body.force), bookedFor, free: admin && Boolean(body.free),
        receipt: false,
      });
    } catch (error) {
      if (error instanceof BookingConflictError) return conflictReply(env, chatId, error);
      if (error instanceof RosterCapacityError) return json({ ok: false, message: error.message });
      throw error;
    }
    return savedReply(env, chatId, bookingId, user, admin, '✅ Booking added');
  }, { member: true }],
];

export async function handleMiniAppApi(request, env, path, now = Date.now()) {
  const header = request.headers.get('Authorization') || '';
  const session = header.startsWith('tma ')
    ? await verifyInitData(env, header.slice(4), now) : null;
  if (!session) return json({ ok: false, message: 'Open this from the pinned court board.' }, 401);
  const chatId = chatFromStartParam(env, session.startParam);
  if (!chatId) return json({ ok: false, message: 'This link is not for a SquashBot group.' }, 403);
  const { user } = session;
  for (const [method, pattern, handler, { member = false } = {}] of routes) {
    const match = path.match(pattern);
    if (!match || request.method !== method) continue;
    const admin = await isChatAdmin(env, chatId, user);
    if (!member && !admin) return json({ ok: false, admin: false, message: MANAGE_ADMIN }, 403);
    try {
      if (method === 'POST') {
        // What a tap in the chat does before anything else: tie this account
        // to the handle it was seeded under, so a write keys them as one person.
        await rememberPlayer(env, user);
        await rememberLedgerIdentity(env, chatId, user);
      }
      const body = method === 'POST' ? await readBody(request) : {};
      return await handler({ env, chatId, match, body, user, admin, now });
    } catch (error) {
      if (error instanceof BookingParseError) return json({ ok: false, message: error.message });
      console.log(`Mini App ${method} ${path} failed: ${error.stack || error}`);
      return json({ ok: false, message: 'Something went wrong. Please try again.' }, 500);
    }
  }
  return json({ ok: false, message: 'Not found.' }, 404);
}

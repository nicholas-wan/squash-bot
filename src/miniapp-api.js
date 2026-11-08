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
import {
  chatRole, knownPlayers, ownerName, rememberPlayer, RosterCapacityError,
} from './players.js';
import { formatMoney } from './pricing.js';
import {
  accountRows, adminTabEntries, ledgerRowsFor, paymentReceiptHtml, recordPayment,
  sendPrivateNote, tabStory, undoEntry,
} from './tab.js';
import { allowedChats } from './scope.js';

// The Mini App's API. The page is only a drawing of these answers: who is
// asking comes from Telegram's signature, which group from the launch link's
// startapp value, and every call asks Telegram what that person is there:
// somebody not in the group is turned away, and a lookup Telegram could not
// answer comes back as a 503 the page retries. Members get the court list
// and their own Join and Leave, as
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
  const match = String(startParam).match(/^g(-?\d+)(?:_b\d+|_tab)?$/);
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
// A tap that found the court already as the screen showed it is no failure:
// the court is redrawn and the message says where it stands.
async function actionReply(env, chatId, bookingId, result, user) {
  return json({
    ok: result.changed || Boolean(result.same), message: result.message,
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
// The notices and the board follow the reply when the runtime lets them.
async function slotReply(env, chatId, bookingId, user, admin, action, defer) {
  const result = await moveOwnSlot(env, chatId, bookingId, user, action);
  if (result.changed) await settleSlotMove(env, chatId, result, user, { tellActor: false, defer });
  return json({
    ok: result.changed, message: result.message,
    ...(await courtList(env, chatId, { viewer: user, admin })),
  });
}

const wanted = (body) => (typeof body.on === 'boolean' ? body.on : undefined);

// A route marked member is open to anyone in the group, as the private 🙋 Join
// list is; every other one is refused to a member before its handler runs.
const routes = [
  ['GET', /^courts$/, async ({ env, chatId, user, admin }) => json({
    ok: true, ...(await courtList(env, chatId, { viewer: user, admin })),
  }), { member: true, early: true }],
  ['POST', /^court\/(\d+)\/(join|leave)$/, async ({ env, chatId, match, user, admin, defer }) =>
    slotReply(env, chatId, Number(match[1]), user, admin, match[2], defer), { member: true }],
  ['GET', /^court\/(\d+)$/, async ({ env, chatId, match, user }) => {
    const court = await courtDetail(env, chatId, Number(match[1]), user);
    return court
      ? json({ ok: true, court })
      : json({ ok: false, message: 'That booking has already gone.' });
  }],
  ['POST', /^court\/(\d+)\/seat$/, async ({ env, chatId, match, body, user, defer }) => {
    const heads = Number(body.heads) === 2 ? 2 : 1;
    const result = await seatPlayer(
      env, chatId, Number(match[1]), String(body.slug || ''), heads, user.id, { defer }
    );
    return actionReply(env, chatId, Number(match[1]), result, user);
  }],
  // +1, guest and "room for N" carry the state the screen showed, so a retry
  // or a second admin's stale screen lands as no change rather than undoing
  // the first tap. A page from before this sent none, and still toggles.
  ['POST', /^court\/(\d+)\/plus$/, async ({ env, chatId, match, body, user, defer }) => actionReply(
    env, chatId, Number(match[1]),
    await flipPlusOne(env, chatId, Number(match[1]), Number(body.player),
      { want: wanted(body), defer }), user
  )],
  ['POST', /^court\/(\d+)\/guest$/, async ({ env, chatId, match, body, user, defer }) => actionReply(
    env, chatId, Number(match[1]),
    await flipOwnerGuest(env, chatId, Number(match[1]), user.id, { want: wanted(body), defer }), user
  )],
  ['POST', /^court\/(\d+)\/kick$/, async ({ env, chatId, match, body, user, defer }) => actionReply(
    env, chatId, Number(match[1]),
    await kickPlayer(env, chatId, Number(match[1]), Number(body.player), { defer }), user
  )],
  ['POST', /^court\/(\d+)\/capacity$/, async ({ env, chatId, match, body, user, defer }) => actionReply(
    env, chatId, Number(match[1]),
    await addSlot(env, chatId, Number(match[1]), {
      expected: Number.isInteger(body.expected) ? body.expected : undefined, defer,
    }), user
  )],
  // Changing, cancelling and adding are open to members on the same terms as
  // the chat: anyone may book, and whoever booked a court — or an admin — may
  // change or cancel it until it starts. authorizeBookingChange is that rule,
  // and cancelBooking applies it itself.
  ['POST', /^court\/(\d+)\/edit$/, async ({ env, chatId, match, body, user, admin, now, defer }) => {
    const bookingId = Number(match[1]);
    const permitted = await authorizeBookingChange(env, chatId, bookingId, user, 'edit');
    if (!permitted.allowed) return json({ ok: false, message: permitted.message });
    const parsed = bookingFromForm(body, now, await getTimezone(env, chatId));
    let saved;
    try {
      saved = await updateBooking(
        env, chatId, bookingId, parsed, user, 'Edited in the Mini App',
        { allowConflict: Boolean(body.force), expected: body.expected || null, defer }
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
  ['POST', /^court\/(\d+)\/delete$/, async ({ env, chatId, match, user, admin, defer }) => {
    const result = await cancelBooking(
      env, chatId, Number(match[1]), user, 'Deleted in the Mini App', { defer }
    );
    if (result.status !== 'cancelled') return json({ ok: false, message: result.message });
    return json({
      ok: true, message: 'Booking cancelled',
      ...(await courtList(env, chatId, { viewer: user, admin })),
    });
  }, { member: true }],
  ['POST', /^courts$/, async ({ env, chatId, body, user, admin, now, defer }) => {
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
        receipt: false, defer,
      });
    } catch (error) {
      if (error instanceof BookingConflictError) return conflictReply(env, chatId, error);
      if (error instanceof RosterCapacityError) return json({ ok: false, message: error.message });
      throw error;
    }
    return savedReply(env, chatId, bookingId, user, admin, '✅ Booking added');
  }, { member: true }],

  // The tab. Everyone reads their own; an admin also reads everybody's,
  // records payments of any size, and takes back a /debt entry or a payment
  // recorded by mistake. Slugs travel URL-encoded: a handle starts with @.
  ['GET', /^tab$/, async ({ env, chatId, user, admin: role }) => {
    const [tz, mine, admin, people] = await Promise.all([
      getTimezone(env, chatId), ledgerRowsFor(env, chatId, user), role,
      Promise.resolve(role).then((yes) => (yes ? adminTabEntries(env, chatId) : [])),
    ]);
    return json({
      ok: true, admin, owner: ownerName(env),
      me: tabStory(mine, tz),
      people: people.map((entry) => ({ slug: entry.slug, name: entry.name, balance: entry.balance })),
    });
  }, { member: true, early: true }],
  ['GET', /^tab\/person\/([^/]+)$/, async ({ env, chatId, match }) =>
    personReply(env, chatId, decodeURIComponent(match[1]))],
  ['POST', /^tab\/person\/([^/]+)\/pay$/, async ({ env, chatId, match, body, user, defer }) => {
    const slug = decodeURIComponent(match[1]);
    const cents = Math.round(Number(body.cents));
    const result = await recordPayment(env, chatId, slug, cents, user, Number(body.expected),
      { defer });
    if (result.status === 'amount') {
      return json({ ok: false, message: 'Enter an amount between $0.01 and $1,000.' });
    }
    if (result.status === 'stale') {
      return personReply(env, chatId, slug, {
        ok: false,
        message: `Their balance changed to ${formatMoney(result.balance)} while this was open. `
          + 'Check the amount and record it again.',
      });
    }
    if (result.status !== 'paid') return json({ ok: false, message: 'Nothing on that tab any more.' });
    // The receipt and the redrawn person are independent, so they go
    // together; the reply's wording waits for the receipt's outcome.
    const receipt = result.userId
      ? sendPrivateNote(env, chatId, result.userId, paymentReceiptHtml(result.paid, result.balance))
      : Promise.resolve('failed');
    const [told, reply] = await Promise.all([receipt, personReply(env, chatId, slug, {
      ok: true,
      message: `${formatMoney(result.paid)} from ${result.name} recorded.`,
    })]);
    return withReceiptNote(reply, told === 'private' ? ' They have a receipt.'
      : ' They could not be sent a receipt.');
  }],
  ['POST', /^tab\/entry\/(\d+)\/undo$/, async ({ env, chatId, match, defer }) => {
    const undone = await undoEntry(env, chatId, Number(match[1]), { defer });
    if (!undone) {
      return json({ ok: false, message: 'That entry has already gone, or is too old to undo.' });
    }
    const amount = formatMoney(Math.abs(undone.cents));
    const what = undone.payment ? `The ${amount} payment` : `The ${amount} entry`;
    const standing = undone.balance > 0 ? `You now owe <b>${formatMoney(undone.balance)}</b>.`
      : undone.balance < 0 ? `You are <b>${formatMoney(-undone.balance)}</b> in credit.`
        : 'You are all settled.';
    const told = undone.userId
      ? await sendPrivateNote(env, chatId, undone.userId,
        `↩️ <b>${what} on your squash tab was undone</b> — it was recorded by mistake.\n\n${standing}`)
      : 'failed';
    return personReply(env, chatId, undone.slug, {
      ok: true,
      message: `Undone: ${what.toLowerCase()} on ${undone.name}'s tab.`
        + (told === 'private' ? ' They have been told.' : ' They could not be told privately.'),
    });
  }],
];

// A sentence added to a reply's message once something running beside it,
// such as a receipt, has said how it went.
async function withReceiptNote(reply, note) {
  const body = await reply.clone().json();
  return body.ok ? json({ ...body, message: `${body.message}${note}` }) : reply;
}

// One person's tab for an admin, with whatever the action before it has to say.
async function personReply(env, chatId, slug, extra = { ok: true }) {
  const [rows, tz] = await Promise.all([accountRows(env, chatId, slug), getTimezone(env, chatId)]);
  if (!rows.length) return json({ ok: false, message: 'Nothing on that tab any more.' });
  return json({
    ...extra,
    person: { slug, name: rows[rows.length - 1].name, ...tabStory(rows, tz) },
  });
}

// Told apart from a refusal, so the page offers a retry instead of locking
// an admin out because one Telegram call timed out.
const ROLE_UNKNOWN = 'Telegram did not answer just now. Please try again.';
const NOT_A_MEMBER = 'Only members of the group can use this.';

export async function handleMiniAppApi(request, env, path, now = Date.now(), ctx = null) {
  // With the runtime's waitUntil the board and notices follow the reply;
  // without it (tests, a direct call) they are awaited as before.
  const defer = ctx && typeof ctx.waitUntil === 'function'
    ? (work) => ctx.waitUntil(work) : undefined;
  const header = request.headers.get('Authorization') || '';
  const session = header.startsWith('tma ')
    ? await verifyInitData(env, header.slice(4), now) : null;
  if (!session) return json({ ok: false, message: 'Open this from the pinned court board.' }, 401);
  const chatId = chatFromStartParam(env, session.startParam);
  if (!chatId) return json({ ok: false, message: 'This link is not for a SquashBot group.' }, 403);
  const { user } = session;
  for (const [method, pattern, handler, { member = false, early = false } = {}] of routes) {
    const match = path.match(pattern);
    if (!match || request.method !== method) continue;
    // Membership is checked, not assumed: the launch link is signed, but
    // anybody who has seen it, somebody since removed from the group say,
    // could open it. The same cached getChatMember that answers "admin"
    // answers this, so it costs nothing extra. It is a Telegram round trip
    // whenever the isolate has not asked lately, so it runs alongside the
    // request's own first reads rather than in front of them: a POST's body,
    // and for the two screens a member opens first (an `early` route, which
    // only reads) the screen itself, which takes the admin answer as a
    // promise. Nothing is written, and nothing read goes out, before it.
    const role = chatRole(env, chatId, user);
    const admin = role.then((answer) => answer === 'admin');
    let body = {};
    let started = null;
    try {
      if (method === 'POST') {
        [body] = await Promise.all([readBody(request), role]);
      } else if (early) {
        started = handler({ env, chatId, match, body, user, admin, now, defer });
        started.catch(() => {});
      }
    } catch (error) {
      console.log(`Mini App ${method} ${path} failed: ${error.stack || error}`);
      return json({ ok: false, message: 'Something went wrong. Please try again.' }, 500);
    }
    const answer = await role;
    if (answer === 'unknown') return json({ ok: false, retry: true, message: ROLE_UNKNOWN }, 503);
    if (answer === 'none') return json({ ok: false, admin: false, message: NOT_A_MEMBER }, 403);
    const isAdmin = answer === 'admin';
    if (!member && !isAdmin) return json({ ok: false, admin: false, message: MANAGE_ADMIN }, 403);
    try {
      if (method === 'POST') {
        // What a tap in the chat does before anything else: tie this account
        // to the handle it was seeded under, so a write keys them as one
        // person. Separate tables, so the two writes run together.
        await Promise.all([rememberPlayer(env, user), rememberLedgerIdentity(env, chatId, user)]);
      }
      return await (started
        || handler({ env, chatId, match, body, user, admin: isAdmin, now, defer }));
    } catch (error) {
      if (error instanceof BookingParseError) return json({ ok: false, message: error.message });
      console.log(`Mini App ${method} ${path} failed: ${error.stack || error}`);
      return json({ ok: false, message: 'Something went wrong. Please try again.' }, 500);
    }
  }
  return json({ ok: false, message: 'Not found.' }, 404);
}

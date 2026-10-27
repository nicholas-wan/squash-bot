import { syncAnnouncements } from './announcements.js';
import { courtName, shortClock } from './format.js';
import { courtCostCents, formatMoney, publicHolidays, shareCents } from './pricing.js';
import { identity, isHouseholdPlayer, ownerName } from './players.js';
import { boardChats, dataChatId } from './scope.js';
import { getTimezone, updatePinnedMessage } from './settings.js';
import { deleteMessage, escapeHtml, OK_MARKUP, sendMessage } from './telegram.js';
import { queuePinnedRefresh } from './refresh-queue.js';
import { miniAppLink } from './miniapp-link.js';

function shortDay(epochMs, tz) {
  return new Intl.DateTimeFormat('en-SG', {
    timeZone: tz, day: 'numeric', month: 'short',
  }).format(new Date(epochMs));
}

// Where a new ledger row lands. Telegram's immutable numeric id is the account
// key whenever one is known — a mutable username would merge unrelated people
// once a renamed handle is claimed by somebody else — and an alias row supplies
// that id for a player first seen without one. The reserved ambiguous alias is
// user_id 0, which is falsy and so deliberately falls back to the slug.
export async function ledgerAccount(env, dataChat, player) {
  const linked = !player.user_id ? await env.DB.prepare(
    'SELECT user_id FROM ledger_identity_aliases WHERE chat_id = ? AND slug = ?'
  ).bind(dataChat, player.slug).first() : null;
  const userId = player.user_id || linked?.user_id || null;
  return { userId, slug: userId ? `u${userId}` : player.slug };
}

// Charges land only after a booking has been played, so cancelled slots and
// people who left in time are never billed. The unique index on
// (booking_id, slug) keeps a retried cron run from double charging.
export async function chargeBooking(env, booking, roster) {
  if (!roster.length || booking.charged) return 0;
  // A free court was paid by somebody who is not passing the bill on, so
  // nobody on it owes the organiser anything. Marked charged all the same, so
  // the cron does not come back to it.
  if (booking.free) {
    await env.DB.prepare('UPDATE bookings SET charged = 1 WHERE id = ?').bind(booking.id).run();
    return 0;
  }
  const tz = await getTimezone(env, booking.chat_id);
  const totalCents = courtCostCents(
    booking.starts_at, booking.ends_at, tz, publicHolidays(env)
  );
  // Divided by heads rather than rows: a member an admin seated with a friend
  // holds two of the court's slots, so the court splits two ways for them.
  const heads = roster.reduce((total, player) => total + (player.heads || 1), 0);
  const share = shareCents(totalCents, heads);
  // The time and the sum make a line checkable on its own: "Court 4 · 27 Oct"
  // twice read as a double charge when it was two courts, and nothing said how
  // a share was reached.
  const reason = `${courtName(booking)} · ${shortDay(booking.starts_at, tz)} · `
    + `${shortClock(booking.starts_at, tz)}–${shortClock(booking.ends_at, tz)} · `
    + `${formatMoney(totalCents)} ÷ ${heads}`;

  let charged = 0;
  if (share > 0) {
    for (const player of roster) {
      // By slug or by numeric id: the organiser changing their handle re-keys
      // their roster rows, and only the id still says the court is theirs.
      if (isHouseholdPlayer(env, player)) continue;
      // One row per person however many heads they brought — the unique index
      // allows only one per booking anyway — so the reason carries the count,
      // which is the only place a doubled charge can explain itself.
      const brought = player.heads || 1;
      const account = await ledgerAccount(env, booking.chat_id, player);
      const inserted = await env.DB.prepare(
        `INSERT OR IGNORE INTO ledger
          (chat_id, slug, user_id, name, amount_cents, booking_id, reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        booking.chat_id, account.slug, account.userId, player.name,
        share * brought, booking.id, brought > 1 ? `${reason} · for ${brought}` : reason,
        Date.now()
      ).run();
      charged += inserted.meta.changes ? 1 : 0;
    }
  }
  await env.DB.prepare('UPDATE bookings SET charged = 1 WHERE id = ?').bind(booking.id).run();
  return charged;
}

export async function tabBalances(env, chatId) {
  const { results } = await env.DB.prepare(
    `SELECT l.slug AS slug,
            SUM(l.amount_cents) AS balance,
            MAX(l.user_id) AS user_id,
            (SELECT name FROM ledger
              WHERE chat_id = l.chat_id AND slug = l.slug
              ORDER BY created_at DESC, id DESC LIMIT 1) AS name
     FROM ledger AS l
     WHERE l.chat_id = ?
     GROUP BY l.slug
     HAVING SUM(l.amount_cents) != 0
     ORDER BY balance DESC, name`
  ).bind(dataChatId(env, chatId)).all();
  return results;
}

// Telegram caps callback_data at 64 bytes. A slug is a username or a numeric
// id, so this only ever excludes an absurdly long free-text name. Measured
// against the longest button that carries it: the confirm button, which also
// names the amount being cleared.
const MAX_SETTLE_CENTS = '99999999';
export function settleKey(slug) {
  const key = String(slug);
  return new TextEncoder().encode(`tb:paid:${MAX_SETTLE_CENTS}:${key}`).length <= 64 ? key : null;
}

export function settleable(balances) {
  return balances.filter((entry) => entry.balance > 0 && settleKey(entry.slug));
}

// My tab is for everyone, so it comes first; Manage only appears when there is
// a balance an admin could clear. The keyboard is never omitted — editing a
// message without reply_markup keeps its previous keyboard, so a settle button
// that should disappear must be overwritten, not left out.
//
// With the Mini App registered the pinned tab gets one button into it instead,
// which opens over the chat wherever the tapper is: the breakdown it replaces
// could only land at the bottom of the chat. Admins settle from inside it.
export function tabMarkup(balances, appLink = null) {
  if (appLink) return { inline_keyboard: [[{ text: '🧾 My tab · 💵 Settle', url: appLink }]] };
  const rows = [[{ text: '🧾 My tab', callback_data: 'tb:mine' }]];
  if (settleable(balances).length) {
    rows.push([{ text: '⚙️ Manage tab', callback_data: 'tb:pay' }]);
  }
  return { inline_keyboard: rows };
}

// The ledger is append-only, so a breakdown of every row ever would grow past
// Telegram's message limit within a year and start failing exactly where the
// money is justified. The last time the running balance hit zero is the natural
// cut: everything before it is a settled story, everything after it is why the
// current balance is what it is — but the tab is also the record of who played
// what, so the last two weeks stay visible even once they are settled. Two
// weeks of one group's squash is bounded; a lifetime of it is not.
const HISTORY_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
// A balance only returns to exactly zero when somebody pays to the cent; cash
// paid in round dollars never does, and the story since the last zero grew
// without end. Past this many lines the oldest are folded into one.
const MAX_SHOWN_ROWS = 25;

// Whatever is cut off is carried as one line, so the lines shown always add
// up to the balance above them — reaching back two weeks past a zero used to
// show a payment without the charges it paid.
function currentRows(rows, now = Date.now()) {
  let sum = 0;
  let lastZero = -1;
  rows.forEach((row, index) => {
    sum += row.amount_cents;
    if (sum === 0) lastZero = index;
  });
  let start = lastZero + 1;
  while (start > 0 && rows[start - 1].created_at > now - HISTORY_WINDOW_MS) start -= 1;
  start = Math.max(start, rows.length - MAX_SHOWN_ROWS);
  const carried = rows.slice(0, start).reduce((total, row) => total + row.amount_cents, 0);
  return { shown: rows.slice(start), settled: start, carried };
}

// The balance line and the story behind it, shared by every breakdown view.
// The pricing footer is optional: the monthly notice skips it, because an
// unprompted message should carry the ask and its reasons, not a rate card.
export function breakdownLines(env, rows, tz, { pricing = true } = {}) {
  const lines = [];
  const balance = rows.reduce((sum, row) => sum + row.amount_cents, 0);
  if (balance > 0) {
    lines.push(`Owed to ${escapeHtml(ownerName(env))}: <b>${formatMoney(balance)}</b>`);
  } else {
    lines.push(balance < 0 ? `In credit: <b>${formatMoney(-balance)}</b>` : 'All settled.');
  }
  lines.push('');
  const { shown, settled, carried } = currentRows(rows);
  const entries = `${settled} ${settled === 1 ? 'entry' : 'entries'}`;
  if (settled && !carried) {
    lines.push(`Earlier history — ${settled} settled ${settled === 1 ? 'entry' : 'entries'} not shown.`);
    if (shown.length) lines.push('');
  } else if (settled) {
    lines.push(`• Carried from ${entries} before these — `
      + `${carried < 0 ? '−' : ''}${formatMoney(Math.abs(carried))}`);
  }
  for (const row of shown) {
    // Charges carry their date in the reason; a payment's reason only names
    // who cleared it, so its date is read off the row instead.
    lines.push(row.amount_cents < 0
      ? `• ${escapeHtml(row.reason || 'Payment')} · ${shortDay(row.created_at, tz)}`
        + ` — −${formatMoney(-row.amount_cents)}`
      : `• ${escapeHtml(row.reason || 'Squash')} — ${formatMoney(row.amount_cents)}`);
  }
  if (pricing) {
    lines.push('', 'Courts are $6/hour from 6pm, on weekends, and on public '
      + 'holidays, $3/hour otherwise, split across everyone who played.');
  }
  return lines;
}

// Who an admin can open from their own tab: every open balance, plus anyone
// the ledger touched inside the history window — settling up must not make a
// player unfindable while their recent story is still worth reading.
export async function adminTabEntries(env, chatId) {
  const balances = await tabBalances(env, chatId);
  const known = new Set(balances.map((entry) => entry.slug));
  const { results: recent } = await env.DB.prepare(
    `SELECT l.slug AS slug, MAX(l.user_id) AS user_id,
            (SELECT name FROM ledger
              WHERE chat_id = l.chat_id AND slug = l.slug
              ORDER BY created_at DESC, id DESC LIMIT 1) AS name
     FROM ledger AS l WHERE l.chat_id = ? AND l.created_at > ?
     GROUP BY l.slug ORDER BY l.slug`
  ).bind(dataChatId(env, chatId), Date.now() - HISTORY_WINDOW_MS).all();
  for (const row of recent) {
    if (!known.has(row.slug)) balances.push({ ...row, balance: 0 });
  }
  return balances;
}

// Why a balance is what it is: every ledger row for one person, charges and
// payments alike, in the order they happened. The pinned tab is shared and can
// only name totals; this is sent privately to whoever tapped 🧾, which is the
// one place the full story fits.
// Matched by slug or by numeric id: a username change re-keys roster rows but
// not ledger history, so the id is the only thread tying an old entry to the
// person asking now — and showing both halves is what makes a total split
// across two spellings explainable.
export async function ledgerRowsFor(env, chatId, from) {
  const who = identity(from);
  const { results } = await env.DB.prepare(
    `SELECT * FROM ledger
     WHERE chat_id = ? AND (
       (user_id IS NOT NULL AND user_id = ?)
       OR (user_id IS NULL AND slug = ? AND NOT EXISTS (
         SELECT 1 FROM ledger_identity_aliases a
         WHERE a.chat_id = ledger.chat_id AND a.slug = ledger.slug
       ))
     )
     ORDER BY created_at, id`
  ).bind(dataChatId(env, chatId), who.userId || 0, who.slug).all();
  return results;
}

// One account's rows, by the key the pinned tab and payments use.
export async function accountRows(env, chatId, slug) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM ledger WHERE chat_id = ? AND slug = ?
     ORDER BY created_at, id`
  ).bind(dataChatId(env, chatId), String(slug)).all();
  return results;
}

// The breakdown as data, for the Mini App: the same cut and the same carried
// total as the chat's, so both always agree, with each line marked when an
// admin may still take it back.
export function tabStory(rows, tz, now = Date.now()) {
  const balance = rows.reduce((sum, row) => sum + row.amount_cents, 0);
  const { shown, settled, carried } = currentRows(rows, now);
  return {
    balance,
    earlier: settled ? { entries: settled, cents: carried } : null,
    lines: shown.map((row) => ({
      id: row.id,
      label: row.reason || (row.amount_cents < 0 ? 'Payment' : 'Squash'),
      date: shortDay(row.created_at, tz),
      cents: row.amount_cents,
      undoable: undoable(row, now),
    })),
  };
}

export async function myTabView(env, chatId, from, isAdmin = false) {
  const results = await ledgerRowsFor(env, chatId, from);

  const lines = ['🧾 <b>Your squash tab</b>'];
  if (!results.length) {
    lines.push('', 'Nothing here — you have never been charged.');
  } else {
    lines.push(...breakdownLines(env, results, await getTimezone(env, chatId)));
  }
  lines.push('', 'Only you can see this.');

  // Everyone taps the same shared button; what it opens is private, so it can
  // differ. Group admins get a row per open balance — reading why somebody
  // owes is part of keeping the household straight, the same reason Manage
  // shows them every roster.
  let replyMarkup = OK_MARKUP;
  // May be a promise started alongside the ledger read; awaited only here,
  // where the answer is first needed. isChatAdmin never rejects.
  isAdmin = await isAdmin;
  if (isAdmin) {
    const others = (await adminTabEntries(env, chatId))
      .filter((entry) => settleKey(entry.slug));
    if (others.length) {
      replyMarkup = { inline_keyboard: [
        ...others.map((entry) => [{
          text: `🧾 ${entry.name} · ${formatMoney(Math.abs(entry.balance))}`,
          callback_data: `tb:mine:${settleKey(entry.slug)}`,
        }]),
        ...OK_MARKUP.inline_keyboard,
      ] };
    }
  }
  return { html: lines.join('\n'), replyMarkup };
}

// The admin breakdown uses the same canonical account key as the pinned tab,
// payment controls and monthly notices. Unlinked legacy accounts retain a slug.
export async function theirTabView(env, chatId, slug) {
  const results = await accountRows(env, chatId, slug);
  if (!results.length) return null;
  const name = results[results.length - 1].name || String(slug);
  const lines = [`🧾 <b>${escapeHtml(name)}</b>`];
  lines.push(...breakdownLines(env, results, await getTimezone(env, chatId)));
  lines.push('', 'Only you can see this.');
  return {
    html: lines.join('\n'),
    replyMarkup: { inline_keyboard: [
      [{ text: '← Back to your tab', callback_data: 'tb:mine' }],
      ...OK_MARKUP.inline_keyboard,
    ] },
  };
}

export function tabHtml(env, balances) {
  const owing = balances.filter((entry) => entry.balance > 0);
  const credit = balances.filter((entry) => entry.balance < 0);
  if (!owing.length && !credit.length) return null;

  const lines = ['💰 <b>Squash tab</b>', '', `Owed to ${escapeHtml(ownerName(env))}`];
  if (!owing.length) lines.push('• Nobody — all settled');
  for (const entry of owing) {
    lines.push(`• ${escapeHtml(entry.name)} — <b>${formatMoney(entry.balance)}</b>`);
  }
  if (credit.length) {
    lines.push('', 'In credit');
    for (const entry of credit) {
      lines.push(`• ${escapeHtml(entry.name)} — ${formatMoney(-entry.balance)}`);
    }
  }
  return lines.join('\n');
}

// Every group sharing the ledger gets the same pinned tab. As with the board,
// a sibling chat's failure is logged and skipped rather than thrown — only the
// chat the request came from may fail loudly.
export async function updateTab(env, chatId) {
  const balances = await tabBalances(env, chatId);
  const html = tabHtml(env, balances);
  // Shared tabs are independent Telegram calls, just like shared boards. A
  // slow or kicked sibling should not add its full round trip to every /tab.
  const outcomes = await Promise.all(boardChats(env, chatId).map(async (chat) => {
    let outcome;
    try {
      const markup = html ? tabMarkup(balances, miniAppLink(env, chat, 'tab')) : null;
      const id = await updatePinnedMessage(env, chat, 'tab_message_id', html, markup, 'squash tab');
      outcome = { chat, id };
    } catch (error) {
      outcome = { chat, error };
    }
    // A tab posted afresh lands below the announcement; the sync sees that
    // and moves the announcement back to the bottom. Its errors are retried
    // by maintenance and never fail the tab.
    try { await syncAnnouncements(env, chat); }
    catch (error) { console.log(`Announcement refresh failed: ${error.message || error}`); }
    return outcome;
  }));
  for (const outcome of outcomes.filter((item) => item.error)) {
    try {
      await queuePinnedRefresh(env, outcome.chat, 'tab');
    } catch (queueError) {
      console.log(`Could not queue tab refresh for chat ${outcome.chat}: ${queueError.stack || queueError}`);
    }
  }
  for (const outcome of outcomes) {
    if (!outcome.error || outcome.chat === chatId) continue;
    console.log(
      `Tab update for sibling chat ${outcome.chat} failed: `
      + `${outcome.error.stack || outcome.error}`
    );
  }
  const acting = outcomes.find((outcome) => outcome.chat === chatId);
  if (acting && acting.error) throw acting.error;
  return acting ? acting.id : null;
}

export async function settleMarkup(env, chatId) {
  const balances = await tabBalances(env, chatId);
  const rows = settleable(balances).map((entry) => [{
    // 💵 rather than ✅: a tick next to a name read as "already paid".
    text: `💵 ${entry.name} · ${formatMoney(entry.balance)}`,
    callback_data: `tb:pay:${settleKey(entry.slug)}`,
  }]);
  rows.push([{ text: '← Done', callback_data: 'tb:back' }]);
  return { inline_keyboard: rows };
}

function findOwing(balances, slug) {
  return balances.find((row) => row.slug === String(slug) && row.balance > 0) || null;
}

export async function confirmSettleMarkup(env, chatId, slug) {
  const entry = findOwing(await tabBalances(env, chatId), slug);
  if (!entry) return null;
  return { entry, markup: { inline_keyboard: [
    [{
      text: `✅ Clear ${entry.name} · ${formatMoney(entry.balance)}`,
      callback_data: `tb:paid:${entry.balance}:${settleKey(entry.slug)}`,
    }],
    [{ text: '← Back', callback_data: 'tb:pay' }],
  ] } };
}

// The confirm button sits on a shared pinned message, so two admins can tap it
// at the same time. The payment is only written if the balance is still exactly
// what was read, which makes a second tap a no-op instead of a double credit.
//
// The button also names the amount the admin was shown. A court charged after
// the confirmation was drawn would otherwise be cleared along with it — money
// nobody confirmed — so a balance that has moved since is not settled: it comes
// back marked stale, with the amount it stands at now, for a fresh confirmation.
// Null means there is nothing left to clear.
export async function settleUser(env, chatId, slug, actor, expectedCents = null) {
  const dataChat = dataChatId(env, chatId);
  const entry = findOwing(await tabBalances(env, chatId), slug);
  if (!entry) return null;
  if (expectedCents !== null && entry.balance !== expectedCents) {
    return { ...entry, stale: true };
  }
  const who = identity(actor);
  const result = await env.DB.prepare(
    `INSERT INTO ledger
      (chat_id, slug, user_id, name, amount_cents, booking_id, reason, created_at)
     SELECT ?, ?, ?, ?, ?, NULL, ?, ?
     WHERE (
       SELECT COALESCE(SUM(amount_cents), 0) FROM ledger
       WHERE chat_id = ? AND slug = ?
     ) = ?`
  ).bind(
    dataChat, entry.slug, entry.user_id, entry.name, -entry.balance,
    `Cleared by ${who.name}`, Date.now(),
    dataChat, entry.slug, entry.balance
  ).run();
  if (!result.meta.changes) {
    // The balance moved between the read and the write. Either another admin
    // cleared it first, or a charge landed — and "already clear" would be a
    // lie about a debt that is still open.
    const fresh = findOwing(await tabBalances(env, chatId), slug);
    return fresh ? { ...fresh, stale: true } : null;
  }
  // The payment is written; the pinned tab is only a rendering of it. Same
  // rule as adjustBalance: a throw here would report a failure after the money
  // moved, and skip the debtor's receipt.
  try {
    await updateTab(env, chatId);
  } catch (error) {
    console.log(`Tab refresh after a settlement failed: ${error.stack || error}`);
  }
  return entry;
}

// A payment of any size, for the Mini App's amount box. Cash rarely matches a
// balance to the cent, and the only way to record $20 against $17.35 used to
// be a /debt line that read like an adjustment rather than money received.
// The whole balance is written exactly as settleUser writes it; anything else
// is a part payment, or an overpayment that leaves them in credit. Guarded the
// same way: the balance the admin was looking at must still be the balance,
// so a court charged in between is never paid off unseen.
const MAX_PAYMENT_CENTS = 100000;
const PART_PAYMENT = 'Paid · recorded by ';

export async function recordPayment(env, chatId, slug, cents, actor, expectedBalance) {
  if (!Number.isInteger(cents) || cents <= 0 || cents > MAX_PAYMENT_CENTS) {
    return { status: 'amount' };
  }
  const dataChat = dataChatId(env, chatId);
  const rows = await accountRows(env, chatId, slug);
  if (!rows.length) return { status: 'unknown' };
  const balance = rows.reduce((sum, row) => sum + row.amount_cents, 0);
  if (balance !== expectedBalance) return { status: 'stale', balance };
  const latest = rows[rows.length - 1];
  const who = identity(actor);
  const result = await env.DB.prepare(
    `INSERT INTO ledger
      (chat_id, slug, user_id, name, amount_cents, booking_id, reason, created_at)
     SELECT ?, ?, ?, ?, ?, NULL, ?, ?
     WHERE (
       SELECT COALESCE(SUM(amount_cents), 0) FROM ledger
       WHERE chat_id = ? AND slug = ?
     ) = ?`
  ).bind(
    dataChat, String(slug), rows.find((row) => row.user_id)?.user_id || null, latest.name,
    -cents, cents === balance ? `Cleared by ${who.name}` : `${PART_PAYMENT}${who.name}`,
    Date.now(), dataChat, String(slug), balance
  ).run();
  if (!result.meta.changes) {
    const fresh = await accountRows(env, chatId, slug);
    return { status: 'stale', balance: fresh.reduce((sum, row) => sum + row.amount_cents, 0) };
  }
  try {
    await updateTab(env, chatId);
  } catch (error) {
    console.log(`Tab refresh after a payment failed: ${error.stack || error}`);
  }
  return {
    status: 'paid',
    name: latest.name,
    userId: rows.find((row) => row.user_id)?.user_id || null,
    paid: cents,
    balance: balance - cents,
  };
}

// What a receipt says, in the order the player reads it: what came in, then
// where that leaves them.
export function paymentReceiptHtml(paid, balance) {
  const standing = balance > 0 ? `You now owe <b>${formatMoney(balance)}</b>.`
    : balance < 0 ? `You are <b>${formatMoney(-balance)}</b> in credit.`
      : 'Your squash tab is settled.';
  return `✅ <b>Payment received</b> — ${formatMoney(paid)}. ${standing} Thank you!`;
}

// A private note to one player with nothing tapped behind it, such as a
// receipt for a payment an admin recorded in the Mini App. Telegram turns
// such a message into a public one when it cannot deliver it privately; a
// public copy would name somebody's balance to the group, so it is deleted
// and the caller hears it did not land.
export async function sendPrivateNote(env, chatId, userId, html) {
  const sent = await sendMessage(env, chatId, html, {
    receiverUserId: userId, replyMarkup: OK_MARKUP,
  });
  if (sent.ok && sent.result && sent.result.ephemeral_message_id) return 'private';
  if (sent.ok && sent.result && sent.result.message_id) {
    await deleteMessage(env, chatId, sent.result.message_id);
  }
  return 'failed';
}

// A charge or a credit the courts did not produce: a ball somebody replaced,
// cash handed over outside the tab, half an hour of a court somebody missed.
// Every other entry on the tab is calculated and can be re-derived; this is the
// one that can only ever explain itself, which is why the reason is mandatory
// and why the row carries the name of whoever typed it.
const MAX_REASON_LENGTH = 120;
// A court is a few dollars, so a four-figure entry is a typo far more often
// than a decision. Refusing costs a retype; writing it costs a second entry to
// undo it and an argument in between.
const MAX_ADJUSTMENT_CENTS = 100000;
const MONEY = /^([+-]?)\$?(\d+(?:\.\d{1,2})?)$/;

// "+2 jared ice cream". A plus adds to what they owe and a minus takes it off,
// which is the direction the ledger already counts in: a debt is stored
// positive, so the sign someone types is the sign that gets written. An
// unsigned number reads as a charge, the only kind of entry a court ever makes.
//
// "jared +2 ice cream" is the same sentence with the same words in the other
// order, and refusing it would cost a retype to no purpose, so whichever of the
// first two words reads as money is the amount and the other is the player.
export function parseDebtAdjustment(args) {
  const parts = String(args || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length < 3) return { error: 'usage' };
  const at = parts.findIndex((part, index) => index < 2 && MONEY.test(part));
  if (at === -1) return { error: 'amount' };
  const [, sign, amount] = parts[at].match(MONEY);
  const cents = Math.round(Number(amount) * 100) * (sign === '-' ? -1 : 1);
  // Zero is a line on somebody's tab that moves nothing, which is noise in the
  // one place noise is expensive.
  if (!cents) return { error: 'amount' };
  if (Math.abs(cents) > MAX_ADJUSTMENT_CENTS) return { error: 'huge' };
  const reason = parts.slice(2).join(' ');
  return reason.length > MAX_REASON_LENGTH
    ? { error: 'long' }
    : { target: parts[at === 0 ? 1 : 0], cents, reason };
}

// Who may be charged: only somebody the bot already knows, from config, from
// the ledger, or from a current roster. Admin-entered free text must never mint
// a ledger account — the same rule that keeps a display name from claiming
// financial history — so an unrecognised word is refused rather than billed.
//
// Tried in order, because the group types first names: an account key, then a
// display name, then a name or handle only one person's begins with. A word
// two people answer to is refused at every step rather than guessed at, since
// guessing here bills the wrong person and the bot cannot know it did. Two
// people means two accounts, not two rows: knownPlayers lists a config
// `id:@handle` player under the handle and again under the numeric key their
// charges are filed by, and those resolve to the same ledger account.
//
// The prefix step reads handles and names only, never the synthetic `u123`
// and `nname` keys: those all begin with the same letter, so a stray "u"
// would otherwise bill whoever happens to be the one account keyed by id.
export function matchAccount(players, target) {
  const wanted = String(target).replace(/^@/, '').toLowerCase();
  if (!wanted) return { error: 'unknown' };
  const key = /^\d+$/.test(wanted) ? `u${wanted}` : `@${wanted}`;
  const slugOf = (player) => String(player.slug).toLowerCase();
  const handleOf = (player) => (slugOf(player).startsWith('@') ? slugOf(player).slice(1) : null);
  const nameOf = (player) => String(player.name).replace(/^@/, '').toLowerCase();
  // An account key is unique by construction, so the first hit is the only one.
  const keyed = players.find((player) => [wanted, key].includes(slugOf(player)));
  if (keyed) return { player: keyed };
  const accounts = (found) => new Set(
    found.map((player) => (player.user_id ? `u${player.user_id}` : player.slug))
  ).size;
  for (const found of [
    players.filter((player) => nameOf(player) === wanted),
    players.filter((player) => [handleOf(player), nameOf(player)]
      .some((spelling) => spelling && spelling.startsWith(wanted))),
  ]) {
    if (!found.length) continue;
    return accounts(found) === 1 ? { player: found[0] } : { error: 'ambiguous' };
  }
  return { error: 'unknown' };
}

// Appended, never edited: the tab is the record of what happened. The one
// exception is undoAdjustment below, for an entry that should never have been
// written at all. The breakdown stamps a date on payments only — a court
// charge already carries its own in the reason — so a charge written here
// carries one too, and both kinds of row end up reading the same way.
export async function adjustBalance(env, chatId, player, cents, reason, actor) {
  const dataChat = dataChatId(env, chatId);
  const [account, tz] = await Promise.all([
    ledgerAccount(env, dataChat, player), getTimezone(env, chatId),
  ]);
  const now = Date.now();
  const note = `${reason} · by ${identity(actor).name}`;
  const inserted = await env.DB.prepare(
    `INSERT INTO ledger
      (chat_id, slug, user_id, name, amount_cents, booking_id, reason, created_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`
  ).bind(
    dataChat, account.slug, account.userId, player.name, cents,
    cents > 0 ? `${note} · ${shortDay(now, tz)}` : note, now
  ).run();
  // Read back rather than added to a balance fetched earlier: the point of the
  // reply is to say where the person stands now, and a court that expired
  // mid-command would make an arithmetic answer quietly wrong.
  const total = await env.DB.prepare(
    'SELECT COALESCE(SUM(amount_cents), 0) AS balance FROM ledger WHERE chat_id = ? AND slug = ?'
  ).bind(dataChat, account.slug).first();
  // The row is written and the pinned tab is only a rendering of it. Throwing
  // past this point would tell the admin something went wrong after the money
  // had moved, and the natural response — typing it again — is a second
  // entry. updateTab has already queued a refresh for any chat it could not
  // reach, so the failure is logged and the reply still says what happened.
  try {
    await updateTab(env, chatId);
  } catch (error) {
    console.log(`Tab refresh after a /debt entry failed: ${error.stack || error}`);
  }
  return {
    id: inserted.meta.last_row_id || null,
    name: player.name,
    userId: account.userId,
    cents,
    balance: (total && total.balance) || 0,
  };
}

// "+5" and "-5" are one keystroke apart and mean opposite things, and the sign
// is the one part of an entry nobody rereads. So /debt writes nothing at
// first: it parks the entry here and shows the admin what it means in words,
// and only their Confirm turns it into a ledger row. The reason is too long
// for callback data, which is why the draft lives in a table at all.
const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;

// Returns the draft's id and the balance as it stands now, which the preview
// needs to say where the entry would leave them.
export async function draftAdjustment(env, chatId, player, cents, reason, actor) {
  const dataChat = dataChatId(env, chatId);
  const now = Date.now();
  const account = await ledgerAccount(env, dataChat, player);
  const [inserted, total] = await Promise.all([
    env.DB.prepare(
      `INSERT INTO debt_drafts
        (chat_id, actor_id, slug, user_id, name, amount_cents, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      dataChat, actor.id, player.slug, player.user_id || null, player.name, cents, reason, now
    ).run(),
    env.DB.prepare(
      'SELECT COALESCE(SUM(amount_cents), 0) AS balance FROM ledger WHERE chat_id = ? AND slug = ?'
    ).bind(dataChat, account.slug).first(),
    // Abandoned drafts are swept as new ones arrive; nothing else reads them.
    env.DB.prepare('DELETE FROM debt_drafts WHERE created_at < ?').bind(now - DRAFT_TTL_MS).run(),
  ]);
  return { id: inserted.meta.last_row_id, balance: (total && total.balance) || 0 };
}

// Taken, not read: the delete is what makes a second Confirm tap find nothing
// rather than write the entry twice. Only the admin who typed it may confirm
// it, since the preview was shown to them alone. Null means it has gone.
export async function takeDraft(env, chatId, id, actor) {
  return env.DB.prepare(
    `DELETE FROM debt_drafts WHERE id = ? AND chat_id = ? AND actor_id = ? AND created_at > ?
     RETURNING *`
  ).bind(Number(id), dataChatId(env, chatId), actor.id, Date.now() - DRAFT_TTL_MS).first();
}

// A typo'd /debt used to be fixable only by typing its opposite, which left
// the player reading a charge and a refund that between them meant nothing —
// and an admin who mistyped the fix as well had three lines to explain. Undo
// takes the mistaken row out instead, so the tab reads as though it was never
// written. Only rows /debt wrote can go: a court charge is derived from a
// booking and a settlement from a balance, and deleting either would rewrite
// money that really moved. The " · by " stamp is what marks a /debt row — a
// settlement reads "Cleared by", a court "Court · day". The window is there
// because a week-old line is history the player has already read and acted on.
export const UNDO_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const ADJUSTMENT_ROW = "booking_id IS NULL AND reason LIKE '% · by %'";
// A recorded payment can be taken back too, within the same week: a clear
// tapped against the wrong name could otherwise only be answered with a
// /debt charge, which read as a new debt rather than a mistake undone.
const PAYMENT_ROW = "booking_id IS NULL AND amount_cents < 0 AND "
  + `(reason LIKE 'Cleared by %' OR reason LIKE '${PART_PAYMENT}%')`;

function isPaymentRow(row) {
  return !row.booking_id && row.amount_cents < 0
    && /^(Cleared by |Paid · recorded by )/.test(String(row.reason || ''));
}

function undoable(row, now = Date.now()) {
  if (row.booking_id || row.created_at <= now - UNDO_WINDOW_MS) return false;
  return isPaymentRow(row) || String(row.reason || '').includes(' · by ');
}

// Takes back one /debt entry or one recorded payment, for the Mini App. One
// statement, as undoAdjustment's, so two admins cannot remove it twice.
export async function undoEntry(env, chatId, id) {
  const dataChat = dataChatId(env, chatId);
  const row = await env.DB.prepare(
    `DELETE FROM ledger
     WHERE id = ? AND chat_id = ? AND ((${ADJUSTMENT_ROW}) OR (${PAYMENT_ROW})) AND created_at > ?
     RETURNING *`
  ).bind(Number(id), dataChat, Date.now() - UNDO_WINDOW_MS).first();
  if (!row) return null;
  const total = await env.DB.prepare(
    'SELECT COALESCE(SUM(amount_cents), 0) AS balance FROM ledger WHERE chat_id = ? AND slug = ?'
  ).bind(dataChat, row.slug).first();
  try {
    await updateTab(env, chatId);
  } catch (error) {
    console.log(`Tab refresh after an undo failed: ${error.stack || error}`);
  }
  return {
    slug: row.slug,
    name: row.name,
    userId: row.user_id,
    cents: row.amount_cents,
    payment: isPaymentRow(row),
    note: isPaymentRow(row) ? 'A payment' : adjustmentNote(row),
    balance: (total && total.balance) || 0,
  };
}

// The note an admin wrote, without the stamp adjustBalance added to it.
export function adjustmentNote(row) {
  return String(row.reason || '').split(' · by ')[0];
}

export async function recentAdjustments(env, chatId, limit = 5) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM ledger WHERE chat_id = ? AND ${ADJUSTMENT_ROW} AND created_at > ?
     ORDER BY created_at DESC, id DESC LIMIT ?`
  ).bind(dataChatId(env, chatId), Date.now() - UNDO_WINDOW_MS, limit).all();
  return results;
}

// One statement, so two admins tapping the same Undo remove one row between
// them and the second is told it has already gone. Null means nothing was
// removed: undone already, out of the window, or never a /debt row.
export async function undoAdjustment(env, chatId, id) {
  const dataChat = dataChatId(env, chatId);
  const row = await env.DB.prepare(
    `DELETE FROM ledger WHERE id = ? AND chat_id = ? AND ${ADJUSTMENT_ROW} AND created_at > ?
     RETURNING *`
  ).bind(Number(id), dataChat, Date.now() - UNDO_WINDOW_MS).first();
  if (!row) return null;
  const total = await env.DB.prepare(
    'SELECT COALESCE(SUM(amount_cents), 0) AS balance FROM ledger WHERE chat_id = ? AND slug = ?'
  ).bind(dataChat, row.slug).first();
  // Same rule as adjustBalance: the row is gone, so a refresh failure is
  // logged rather than reported as though the undo had not happened.
  try {
    await updateTab(env, chatId);
  } catch (error) {
    console.log(`Tab refresh after a /debt undo failed: ${error.stack || error}`);
  }
  return {
    name: row.name,
    userId: row.user_id,
    cents: row.amount_cents,
    note: adjustmentNote(row),
    balance: (total && total.balance) || 0,
  };
}

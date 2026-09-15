import { courtName } from './format.js';
import { courtCostCents, formatMoney, publicHolidays, shareCents } from './pricing.js';
import { identity, isHouseholdPlayer, ownerName } from './players.js';
import { boardChats, dataChatId } from './scope.js';
import { getTimezone, updatePinnedMessage } from './settings.js';
import { escapeHtml, OK_MARKUP } from './telegram.js';
import { queuePinnedRefresh } from './refresh-queue.js';

function shortDay(epochMs, tz) {
  return new Intl.DateTimeFormat('en-SG', {
    timeZone: tz, day: 'numeric', month: 'short',
  }).format(new Date(epochMs));
}

// Charges land only after a booking has been played, so cancelled slots and
// people who left in time are never billed. The unique index on
// (booking_id, slug) keeps a retried cron run from double charging.
export async function chargeBooking(env, booking, roster) {
  if (!roster.length || booking.charged) return 0;
  const tz = await getTimezone(env, booking.chat_id);
  const totalCents = courtCostCents(
    booking.starts_at, booking.ends_at, tz, publicHolidays(env)
  );
  // Divided by heads rather than rows: a member an admin seated with a friend
  // holds two of the court's slots, so the court splits two ways for them.
  const share = shareCents(
    totalCents, roster.reduce((total, player) => total + (player.heads || 1), 0)
  );
  const reason = `${courtName(booking)} · ${shortDay(booking.starts_at, tz)}`;

  let charged = 0;
  if (share > 0) {
    for (const player of roster) {
      // By slug or by numeric id: the organiser changing their handle re-keys
      // their roster rows, and only the id still says the court is theirs.
      if (isHouseholdPlayer(env, player)) continue;
      // One row per person however many heads they brought — the unique index
      // allows only one per booking anyway — so the reason carries the count,
      // which is the only place a doubled charge can explain itself.
      const heads = player.heads || 1;
      // New ledger rows are keyed on Telegram's immutable numeric id whenever
      // one is known. A mutable username here would merge unrelated people when
      // a renamed handle is claimed by somebody else.
      const linked = !player.user_id ? await env.DB.prepare(
        'SELECT user_id FROM ledger_identity_aliases WHERE chat_id = ? AND slug = ?'
      ).bind(booking.chat_id, player.slug).first() : null;
      const ledgerUserId = player.user_id || linked?.user_id || null;
      const ledgerSlug = ledgerUserId ? `u${ledgerUserId}` : player.slug;
      const inserted = await env.DB.prepare(
        `INSERT OR IGNORE INTO ledger
          (chat_id, slug, user_id, name, amount_cents, booking_id, reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        booking.chat_id, ledgerSlug, ledgerUserId, player.name,
        share * heads, booking.id, heads > 1 ? `${reason} · for ${heads}` : reason, Date.now()
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
// id, so this only ever excludes an absurdly long free-text name.
export function settleKey(slug) {
  const key = String(slug);
  return new TextEncoder().encode(`tb:paid:${key}`).length <= 64 ? key : null;
}

export function settleable(balances) {
  return balances.filter((entry) => entry.balance > 0 && settleKey(entry.slug));
}

// My tab is for everyone, so it comes first; Manage only appears when there is
// a balance an admin could clear. The keyboard is never omitted — editing a
// message without reply_markup keeps its previous keyboard, so a settle button
// that should disappear must be overwritten, not left out.
export function tabMarkup(balances) {
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

function currentRows(rows, now = Date.now()) {
  let sum = 0;
  let lastZero = -1;
  rows.forEach((row, index) => {
    sum += row.amount_cents;
    if (sum === 0) lastZero = index;
  });
  let start = lastZero + 1;
  while (start > 0 && rows[start - 1].created_at > now - HISTORY_WINDOW_MS) start -= 1;
  return { shown: rows.slice(start), settled: start };
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
  const { shown, settled } = currentRows(rows);
  if (settled) {
    lines.push(`Earlier history — ${settled} settled ${settled === 1 ? 'entry' : 'entries'} not shown.`);
    if (shown.length) lines.push('');
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
async function adminTabEntries(env, chatId) {
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
export async function myTabView(env, chatId, from, isAdmin = false) {
  const who = identity(from);
  // Matched by slug or by numeric id: a username change re-keys roster rows
  // but not ledger history, so the id is the only thread tying an old entry to
  // the person tapping now — and showing both halves is what makes a total
  // split across two spellings explainable.
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
  const { results } = await env.DB.prepare(
    `SELECT * FROM ledger WHERE chat_id = ? AND slug = ?
     ORDER BY created_at, id`
  ).bind(dataChatId(env, chatId), String(slug)).all();
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
  const markup = html ? tabMarkup(balances) : null;
  // Shared tabs are independent Telegram calls, just like shared boards. A
  // slow or kicked sibling should not add its full round trip to every /tab.
  const outcomes = await Promise.all(boardChats(env, chatId).map(async (chat) => {
    try {
      const id = await updatePinnedMessage(env, chat, 'tab_message_id', html, markup, 'squash tab');
      return { chat, id };
    } catch (error) {
      return { chat, error };
    }
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
    text: `✅ ${entry.name} · ${formatMoney(entry.balance)}`,
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
      callback_data: `tb:paid:${settleKey(entry.slug)}`,
    }],
    [{ text: '← Back', callback_data: 'tb:pay' }],
  ] } };
}

// The confirm button sits on a shared pinned message, so two admins can tap it
// at the same time. The payment is only written if the balance is still exactly
// what was read, which makes a second tap a no-op instead of a double credit.
export async function settleUser(env, chatId, slug, actor) {
  const dataChat = dataChatId(env, chatId);
  const entry = findOwing(await tabBalances(env, chatId), slug);
  if (!entry) return null;
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
  if (!result.meta.changes) return null;
  await updateTab(env, chatId);
  return entry;
}

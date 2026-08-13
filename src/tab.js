import { courtCostCents, formatMoney, publicHolidays, shareCents } from './pricing.js';
import { householdSlugs, identity, ownerName } from './players.js';
import { boardChats, dataChatId } from './scope.js';
import { getTimezone, updatePinnedMessage } from './settings.js';
import { escapeHtml } from './telegram.js';

const NO_KEYBOARD = { inline_keyboard: [] };

// Charges land only after a booking has been played, so cancelled slots and
// people who left in time are never billed. The unique index on
// (booking_id, slug) keeps a retried cron run from double charging.
export async function chargeBooking(env, booking, roster) {
  if (!roster.length || booking.charged) return 0;
  const tz = await getTimezone(env, booking.chat_id);
  const totalCents = courtCostCents(
    booking.starts_at, booking.ends_at, tz, publicHolidays(env)
  );
  const share = shareCents(totalCents, roster.length);
  const household = householdSlugs(env);
  const court = booking.court.startsWith('Court ') ? booking.court : `Court ${booking.court}`;
  const reason = `${court} · ${new Intl.DateTimeFormat('en-SG', {
    timeZone: tz, day: 'numeric', month: 'short',
  }).format(new Date(booking.starts_at))}`;

  let charged = 0;
  if (share > 0) {
    for (const player of roster) {
      if (household.has(player.slug)) continue;
      const inserted = await env.DB.prepare(
        `INSERT OR IGNORE INTO ledger
          (chat_id, slug, user_id, name, amount_cents, booking_id, reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        booking.chat_id, player.slug, player.user_id || null, player.name,
        share, booking.id, reason, Date.now()
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

export function tabMarkup(balances) {
  if (!balances.some((entry) => entry.balance > 0 && entry.user_id)) return NO_KEYBOARD;
  return { inline_keyboard: [[{ text: '✅ Mark someone settled', callback_data: 'tb:pay' }]] };
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
  const total = owing.reduce((sum, entry) => sum + entry.balance, 0);
  if (owing.length > 1) lines.push('', `Total outstanding <b>${formatMoney(total)}</b>`);
  if (credit.length) {
    lines.push('', 'In credit');
    for (const entry of credit) {
      lines.push(`• ${escapeHtml(entry.name)} — ${formatMoney(-entry.balance)}`);
    }
  }
  return lines.join('\n');
}

// Every group sharing the ledger gets the same pinned tab.
export async function updateTab(env, chatId) {
  const balances = await tabBalances(env, chatId);
  const html = tabHtml(env, balances);
  const markup = html ? tabMarkup(balances) : null;
  let pinned = null;
  for (const chat of boardChats(env, chatId)) {
    const id = await updatePinnedMessage(env, chat, 'tab_message_id', html, markup, 'squash tab');
    if (chat === chatId) pinned = id;
  }
  return pinned;
}

export async function settleMarkup(env, chatId) {
  const balances = await tabBalances(env, chatId);
  const rows = balances
    .filter((entry) => entry.balance > 0 && entry.user_id)
    .map((entry) => [{
      text: `✅ ${entry.name} · ${formatMoney(entry.balance)}`,
      callback_data: `tb:pay:${entry.user_id}`,
    }]);
  rows.push([{ text: '← Done', callback_data: 'tb:back' }]);
  return { inline_keyboard: rows };
}

export async function confirmSettleMarkup(env, chatId, userId) {
  const balances = await tabBalances(env, chatId);
  const entry = balances.find((row) => row.user_id === Number(userId) && row.balance > 0);
  if (!entry) return null;
  return { entry, markup: { inline_keyboard: [
    [{
      text: `✅ Confirm ${entry.name} paid ${formatMoney(entry.balance)}`,
      callback_data: `tb:paid:${entry.user_id}`,
    }],
    [{ text: '← Back', callback_data: 'tb:pay' }],
  ] } };
}

// The confirm button sits on a shared pinned message, so two admins can tap it
// at the same time. The payment is only written if the balance is still exactly
// what was read, which makes a second tap a no-op instead of a double credit.
export async function settleUser(env, chatId, userId, actor) {
  const dataChat = dataChatId(env, chatId);
  const balances = await tabBalances(env, chatId);
  const entry = balances.find((row) => row.user_id === Number(userId) && row.balance > 0);
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
    `Marked settled by ${who.name}`, Date.now(),
    dataChat, entry.slug, entry.balance
  ).run();
  if (!result.meta.changes) return null;
  await updateTab(env, chatId);
  return entry;
}

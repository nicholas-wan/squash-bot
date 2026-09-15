import { allowedChats, sharingData } from './scope.js';
import { getTimezone } from './settings.js';
import { localParts, zonedEpoch } from './time.js';

const MINUTE = 60000;
const nextTick = now => (Math.floor(now / MINUTE) + 1) * MINUTE;

export async function nextMaintenanceDue(env, now) {
  const chats = allowedChats(env);
  const scope = chats.length ? [...new Set([...chats, ...(sharingData(env) ? [sharingData(env)] : [])])] : [];
  const ids = scope.length ? scope.map(() => '?').join(',') : 'NULL';
  const deadlines = [];
  const monthlyScopes = [];
  const monthlyArgs = [];
  for (const chat of scope) {
    const tz = await getTimezone(env, chat);
    const p = localParts(now, tz);
    if (chats.includes(chat)) deadlines.push(zonedEpoch(p.y, p.mo, p.d + 1, 0, 0, tz));
    deadlines.push(zonedEpoch(p.y, p.mo, p.d + (p.h >= 9 ? 1 : 0), 9, 0, tz));
    if (p.h >= 9) {
      monthlyScopes.push('(chat_id = ? AND month = ?)');
      monthlyArgs.push(chat, `${p.y}-${p.mo}`);
    }
  }
  // One aggregate over the existing deadlines, only when a sweep was needed.
  // A spent reminder is excluded even if its original deadline is in the past.
  const row = await env.DB.prepare(`WITH scoped AS (
      SELECT * FROM bookings WHERE chat_id IN (${ids})
    ) SELECT
      (SELECT MIN(ends_at) FROM scoped) AS ends_due,
      (SELECT MIN(starts_at) FROM scoped WHERE starts_at > ?) AS starts_due,
      (SELECT MIN(reminder_at) FROM scoped b WHERE starts_at > ? AND reminder_sent = 0
        AND (NOT EXISTS (SELECT 1 FROM booking_players p WHERE p.booking_id = b.id)
          OR EXISTS (SELECT 1 FROM booking_players p WHERE p.booking_id = b.id AND p.reminder_sent = 0))) AS reminder_due,
      (SELECT MIN(pre_reminder_at) FROM scoped b WHERE starts_at > ? AND pre_reminder_sent = 0
        AND (NOT EXISTS (SELECT 1 FROM booking_players p WHERE p.booking_id = b.id)
          OR EXISTS (SELECT 1 FROM booking_players p WHERE p.booking_id = b.id AND p.pre_reminder_sent = 0))) AS pre_due,
      (SELECT MIN(delete_after) FROM sent_messages WHERE chat_id IN (${ids})) AS cleanup_due,
      (SELECT MIN(created_at) + 86400000 FROM booking_drafts) AS draft_due,
      (SELECT MIN(?) FROM pending_refreshes WHERE chat_id IN (${ids})) AS refresh_due,
      (SELECT MIN(last_attempt_at) + 300000 FROM monthly_notice_deliveries
        WHERE (${monthlyScopes.join(' OR ') || '0'}) AND status NOT IN ('delivered', 'refused')) AS monthly_due,
      (SELECT MIN(lease_until) FROM availability_notices
        WHERE chat_id IN (${ids}) AND lease_until > ?) AS lease_due`)
    .bind(...scope, now, now, now, ...scope, nextTick(now), ...scope,
      ...monthlyArgs, ...scope, now).first();
  deadlines.push(...Object.values(row || {}).filter(value => value != null));
  // Preserve future deadlines even if less than a minute away. Only overdue
  // work gets a retry boundary; cron jitter must not add a whole extra minute.
  return Math.min(...deadlines.map(due => due <= now ? nextTick(now) : due), now + 86400000);
}

export async function runScheduledMaintenance(env, maintain, prune, now = Date.now()) {
  const configKey = JSON.stringify(['v2', env.ALLOWED_CHATS, env.DATA_CHAT_ID, env.DEFAULT_TIMEZONE]);
  const state = await env.DB.prepare('SELECT * FROM maintenance_schedule WHERE id = ?').bind(1).first();
  if (state?.config_key === configKey && state.next_due > now) {
    return { ok: true, failures: [], skipped: true, nextDue: state.next_due };
  }
  // The state is seeded by migration. INSERT also supports an intentionally
  // cleared scheduler without missing future trigger invalidations.
  await env.DB.prepare('INSERT OR IGNORE INTO maintenance_schedule (id) VALUES (?)').bind(1).run();
  const [maintenance, drafts] = await Promise.allSettled([maintain(env, now), prune(env, now)]);
  const failures = maintenance.status === 'fulfilled' ? [...maintenance.value.failures]
    : [String(maintenance.reason)];
  if (drafts.status === 'rejected') failures.push(`draft cleanup: ${drafts.reason}`);
  // Read revision after our own mutations. A concurrent webhook during deadline
  // calculation increments it; the conditional write cannot hide its earlier work.
  const revision = await env.DB.prepare('SELECT revision FROM maintenance_schedule WHERE id = ?').bind(1).first();
  // Domain changes during a sweep (including its own cleanup) get one follow-up
  // pass. This also covers a webhook racing the sweep before this snapshot.
  const changedDuringSweep = (revision?.revision ?? 0) !== (state?.revision ?? 0);
  const nextDue = failures.length || changedDuringSweep ? nextTick(now) : await nextMaintenanceDue(env, now);
  await env.DB.prepare(`UPDATE maintenance_schedule SET next_due = ?, config_key = ?
    WHERE id = 1 AND revision = ?`).bind(nextDue, configKey, revision?.revision ?? 0).run();
  return { ok: failures.length === 0, failures, skipped: false, nextDue };
}

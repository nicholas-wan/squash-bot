-- Reminders are claimed per player rather than per booking, so someone who joins
-- late still gets their own and one failed send is retried only for them.
--
-- ALTER statements only, by contract. `wrangler d1 execute --file` is atomic:
-- one failed statement rolls the whole file back, so anything else in here
-- would be silently skipped on a re-run rather than applied. The index this
-- file used to create now comes from schema.sql, which is fully IF NOT EXISTS,
-- so run `npm run db:init` before this file.
--
-- Re-running this file reports "duplicate column name". Nothing else is in the
-- file to lose, so that error means it is already applied and is safe to ignore.
ALTER TABLE booking_players ADD COLUMN reminder_sent INTEGER NOT NULL DEFAULT 0;
ALTER TABLE booking_players ADD COLUMN pre_reminder_sent INTEGER NOT NULL DEFAULT 0;

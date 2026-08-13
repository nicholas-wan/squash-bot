-- Upgrades a database created before shared bookings and the money tab.
--
-- ALTER statements only, by contract. `wrangler d1 execute --file` is atomic:
-- one failed statement rolls the whole file back, so anything else in here
-- would be silently skipped on a re-run rather than applied. Every table and
-- index this file used to create now comes from schema.sql, which is fully
-- IF NOT EXISTS, so run `npm run db:init` before this file.
--
-- SQLite has no ADD COLUMN IF NOT EXISTS, so re-running this file reports
-- "duplicate column name". Nothing else is in the file to lose, so that error
-- means the migration is already applied and is safe to ignore.
ALTER TABLE settings ADD COLUMN tab_message_id INTEGER;
ALTER TABLE bookings ADD COLUMN capacity INTEGER NOT NULL DEFAULT 3;
ALTER TABLE bookings ADD COLUMN charged INTEGER NOT NULL DEFAULT 0;

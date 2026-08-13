-- Upgrades a database created before shared bookings and the money tab.
-- SQLite has no ADD COLUMN IF NOT EXISTS, so re-running this file reports
-- "duplicate column name" for the ALTER statements. That error is harmless and
-- means the migration is already applied.
ALTER TABLE settings ADD COLUMN tab_message_id INTEGER;
ALTER TABLE bookings ADD COLUMN capacity INTEGER NOT NULL DEFAULT 3;
ALTER TABLE bookings ADD COLUMN charged INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS booking_players (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id INTEGER NOT NULL,
  chat_id INTEGER NOT NULL,
  user_id INTEGER,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  added_by_user_id INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE (booking_id, slug)
);

CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  slug TEXT NOT NULL,
  user_id INTEGER,
  name TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  booking_id INTEGER,
  reason TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_booking_players_chat
  ON booking_players (chat_id, booking_id, id);

CREATE INDEX IF NOT EXISTS idx_ledger_chat
  ON ledger (chat_id, slug);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_booking_slug
  ON ledger (booking_id, slug)
  WHERE booking_id IS NOT NULL;

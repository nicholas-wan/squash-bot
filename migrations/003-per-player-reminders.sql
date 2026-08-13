-- Reminders are claimed per player rather than per booking, so someone who joins
-- late still gets their own and one failed send is retried only for them.
-- Re-running this file reports "duplicate column name", which is harmless and
-- means it is already applied.
ALTER TABLE booking_players ADD COLUMN reminder_sent INTEGER NOT NULL DEFAULT 0;
ALTER TABLE booking_players ADD COLUMN pre_reminder_sent INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_booking_players_reminder
  ON booking_players (booking_id, reminder_sent, pre_reminder_sent);

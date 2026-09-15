-- One availability message per group replaces the per-booking announcements
-- and end-of-court follow-ups. Messages the old tables still track are handed
-- to the regular cleanup sweep so they leave the chat rather than linger
-- untracked; the new message for the next open court is posted by maintenance
-- on its first pass.
CREATE TABLE IF NOT EXISTS availability_notices (
  chat_id INTEGER PRIMARY KEY,
  booking_id INTEGER,
  message_id INTEGER,
  html TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0
);

CREATE TRIGGER IF NOT EXISTS schedule_availability_notices_insert
AFTER INSERT ON availability_notices BEGIN
  UPDATE maintenance_schedule SET next_due = 0, revision = revision + 1 WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS schedule_availability_notices_update
AFTER UPDATE OF booking_id, message_id, html ON availability_notices
WHEN NEW.booking_id IS NOT OLD.booking_id OR NEW.message_id IS NOT OLD.message_id OR NEW.html IS NOT OLD.html BEGIN
  UPDATE maintenance_schedule SET next_due = 0, revision = revision + 1 WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS schedule_availability_notices_delete
AFTER DELETE ON availability_notices BEGIN
  UPDATE maintenance_schedule SET next_due = 0, revision = revision + 1 WHERE id = 1;
END;

-- A database installed from schema.sql never had the old table; give the
-- hand-over something to read so this file runs cleanly there as well.
CREATE TABLE IF NOT EXISTS booking_announcements (
  booking_id INTEGER NOT NULL,
  chat_id INTEGER NOT NULL,
  message_id INTEGER
);
INSERT INTO sent_messages (chat_id, message_id, is_ephemeral, delete_after, created_at)
  SELECT chat_id, message_id, 0, 0, strftime('%s', 'now') * 1000
  FROM booking_announcements WHERE message_id IS NOT NULL;

DROP TABLE IF EXISTS booking_followups;
DROP TABLE IF EXISTS booking_announcements;

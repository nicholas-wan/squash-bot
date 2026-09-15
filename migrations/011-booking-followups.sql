-- Survives expiry of the source booking so cron retries cannot repost it.
CREATE TABLE IF NOT EXISTS booking_followups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ended_booking_id INTEGER NOT NULL,
  chat_id INTEGER NOT NULL,
  data_chat_id INTEGER NOT NULL,
  booking_id INTEGER,
  status TEXT NOT NULL DEFAULT 'pending',
  roster_json TEXT,
  UNIQUE (ended_booking_id, chat_id)
);
CREATE INDEX IF NOT EXISTS idx_followups_target
  ON booking_followups (chat_id, booking_id, id);

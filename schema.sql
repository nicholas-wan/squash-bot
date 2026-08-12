CREATE TABLE IF NOT EXISTS settings (
  chat_id INTEGER PRIMARY KEY,
  tz TEXT NOT NULL DEFAULT 'Asia/Singapore',
  board_message_id INTEGER
);

CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  court TEXT NOT NULL,
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  reminder_at INTEGER NOT NULL,
  reminder_sent INTEGER NOT NULL DEFAULT 0,
  created_by_user_id INTEGER,
  created_by_name TEXT,
  created_at INTEGER NOT NULL
);

-- Partial bookings waiting for inline-button or ForceReply input. Payload is
-- validated again before a confirmed booking is inserted.
CREATE TABLE IF NOT EXISTS booking_drafts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  user_name TEXT,
  source_text TEXT,
  payload TEXT NOT NULL,
  source_message_id INTEGER,
  wizard_message_id INTEGER,
  wizard_ephemeral INTEGER NOT NULL DEFAULT 0,
  reply_prompt_message_id INTEGER,
  pending_field TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bookings_board
  ON bookings (chat_id, starts_at);

CREATE INDEX IF NOT EXISTS idx_bookings_reminder
  ON bookings (reminder_sent, reminder_at)
  WHERE reminder_sent = 0;

CREATE INDEX IF NOT EXISTS idx_bookings_cleanup
  ON bookings (ends_at);

CREATE INDEX IF NOT EXISTS idx_booking_drafts_user
  ON booking_drafts (chat_id, user_id, created_at);

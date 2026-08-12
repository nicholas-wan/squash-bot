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
  pre_reminder_at INTEGER NOT NULL,
  pre_reminder_sent INTEGER NOT NULL DEFAULT 0,
  created_by_user_id INTEGER,
  created_by_name TEXT,
  source_text TEXT,
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
  booking_id INTEGER,
  payload TEXT NOT NULL,
  source_message_id INTEGER,
  wizard_message_id INTEGER,
  wizard_ephemeral INTEGER NOT NULL DEFAULT 0,
  reply_prompt_message_id INTEGER,
  pending_field TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS booking_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id INTEGER NOT NULL,
  chat_id INTEGER NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('added', 'edited', 'deleted', 'imported')),
  actor_user_id INTEGER,
  actor_name TEXT,
  source_text TEXT,
  before_json TEXT,
  after_json TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bookings_board
  ON bookings (chat_id, starts_at);

CREATE INDEX IF NOT EXISTS idx_bookings_reminder
  ON bookings (reminder_sent, reminder_at)
  WHERE reminder_sent = 0;

CREATE INDEX IF NOT EXISTS idx_bookings_pre_reminder
  ON bookings (pre_reminder_sent, pre_reminder_at)
  WHERE pre_reminder_sent = 0;

CREATE INDEX IF NOT EXISTS idx_bookings_cleanup
  ON bookings (ends_at);

CREATE INDEX IF NOT EXISTS idx_booking_drafts_user
  ON booking_drafts (chat_id, user_id, created_at);

CREATE INDEX IF NOT EXISTS idx_booking_audit_chat
  ON booking_audit (chat_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_booking_conflicts
  ON bookings (chat_id, court, starts_at, ends_at);

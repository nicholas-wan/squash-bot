-- Reminders are tidied away once their day is over. Telegram cannot list a
-- bot's own messages, so each one is recorded here when it is sent.
CREATE TABLE IF NOT EXISTS sent_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  receiver_user_id INTEGER,
  message_id INTEGER NOT NULL,
  is_ephemeral INTEGER NOT NULL DEFAULT 0,
  delete_after INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sent_messages_due
  ON sent_messages (delete_after);

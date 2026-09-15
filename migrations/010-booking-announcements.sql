CREATE TABLE IF NOT EXISTS booking_announcements (
  booking_id INTEGER NOT NULL,
  chat_id INTEGER NOT NULL,
  data_chat_id INTEGER NOT NULL,
  message_id INTEGER,
  html TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (booking_id, chat_id)
);

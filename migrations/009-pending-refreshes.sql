-- Retry board/tab updates after the underlying mutation has committed instead
-- of making users repeat an action which already succeeded.
CREATE TABLE IF NOT EXISTS pending_refreshes (
  chat_id INTEGER PRIMARY KEY,
  board INTEGER NOT NULL DEFAULT 0,
  tab INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

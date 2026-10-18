-- A /debt waiting for the admin who typed it to confirm what it means. The
-- reason is too long for callback data, so the button carries only this id.
CREATE TABLE IF NOT EXISTS debt_drafts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  actor_id INTEGER NOT NULL,
  slug TEXT NOT NULL,
  user_id INTEGER,
  name TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

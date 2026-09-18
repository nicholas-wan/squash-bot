-- Telegram redelivers an update until the webhook answers 2xx, and a
-- redelivered /debt would be a second ledger row: it is the one money write
-- with no natural idempotency. Every update id is recorded once and kept for
-- a day; a repeat is answered ok and otherwise ignored.
CREATE TABLE IF NOT EXISTS processed_updates (
  update_id INTEGER PRIMARY KEY,
  seen_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_processed_updates_seen
  ON processed_updates (seen_at);

-- Monthly balance notices are tracked per debtor so a transient failure can be
-- retried without duplicating notices which already arrived.
CREATE TABLE IF NOT EXISTS monthly_notice_deliveries (
  chat_id INTEGER NOT NULL,
  month TEXT NOT NULL,
  slug TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('sending', 'pending', 'delivered', 'refused')),
  last_attempt_at INTEGER NOT NULL,
  delivered_at INTEGER,
  last_error TEXT,
  PRIMARY KEY (chat_id, month, slug)
);

CREATE INDEX IF NOT EXISTS idx_monthly_notice_pending
  ON monthly_notice_deliveries (chat_id, month, status, last_attempt_at);

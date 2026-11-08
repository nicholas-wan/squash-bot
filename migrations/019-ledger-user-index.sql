-- Your own tab is found by numeric id, which the (chat_id, slug) index
-- cannot serve, so every 🧾 open read the group's whole ledger. Idempotent:
-- schema.sql creates the same index, and re-running this changes nothing.
CREATE INDEX IF NOT EXISTS idx_ledger_user
  ON ledger (chat_id, user_id, created_at);

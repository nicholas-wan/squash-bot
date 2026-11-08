-- Indexes for reads that ran as full scans on every update.
--
-- rememberPlayer runs on every tap and message and finds the sender's roster
-- rows by slug and by numeric id; booking_players had neither index, so each
-- statement scanned the whole table.
CREATE INDEX IF NOT EXISTS idx_booking_players_slug
  ON booking_players (slug);
CREATE INDEX IF NOT EXISTS idx_booking_players_user
  ON booking_players (user_id);

-- The ledger is append-only and read on every tab view, settle and admin
-- panel. The latest-name lookup sorts one account's rows by time, which
-- (chat_id, slug) could not serve. The new account index starts with
-- (chat_id, slug), so it replaces the old. Finding a person's own rows by id
-- is 019's idx_ledger_user.
CREATE INDEX IF NOT EXISTS idx_ledger_account
  ON ledger (chat_id, slug, created_at, id);
DROP INDEX IF EXISTS idx_ledger_chat;

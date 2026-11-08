-- Claiming an alias re-keys a handle's provisional ledger rows onto the
-- verified id. When one booking already held a charge under both spellings,
-- the move hit the one-charge-per-booking index and the claim's INSERT OR
-- IGNORE skipped that row, leaving a stray @handle balance. Clearing it then
-- wrote the payment onto the id (the insert trigger re-keys it), reported
-- zero changes, and came back "stale", so every confirm credited the id again.
-- The claim now frees the handle's row from its booking before moving it, so
-- both billed heads survive under the id.
DROP TRIGGER IF EXISTS ledger_alias_claim;
CREATE TRIGGER ledger_alias_claim
AFTER INSERT ON ledger_identity_aliases
WHEN NEW.user_id > 0
BEGIN
  UPDATE ledger SET booking_id = NULL
  WHERE chat_id = NEW.chat_id AND slug = NEW.slug AND user_id IS NULL
    AND booking_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM ledger AS claimed
      WHERE claimed.booking_id = ledger.booking_id AND claimed.slug = 'u' || NEW.user_id);
  UPDATE ledger SET user_id = NEW.user_id, slug = 'u' || NEW.user_id
  WHERE chat_id = NEW.chat_id AND slug = NEW.slug AND user_id IS NULL;
END;

-- The tab-notice check after every update looks a debtor up by slug, which
-- the primary key (chat_id, month, slug) cannot serve.
CREATE INDEX IF NOT EXISTS idx_monthly_notice_slug
  ON monthly_notice_deliveries (chat_id, slug, status);

-- Rows the old trigger left behind: still keyed by a handle whose alias has
-- since been claimed. Left in place, clearing one writes the payment onto the
-- id (the insert trigger re-keys it) while the handle's debt stays, so every
-- Clear credits the id again. This moves them the way the fixed trigger
-- would have, keeping every amount. Checked before it was added: the live
-- ledger had none on 8 Nov 2026, so on it this changes nothing; it runs here
-- so a copy restored from an older backup is repaired too. Safe to run twice.
--
-- To look first (read-only):
--   SELECT l.* FROM ledger l
--   JOIN ledger_identity_aliases a
--     ON a.chat_id = l.chat_id AND a.slug = l.slug AND a.user_id > 0
--   WHERE l.user_id IS NULL;
UPDATE ledger SET booking_id = NULL
WHERE user_id IS NULL AND booking_id IS NOT NULL
  AND EXISTS (SELECT 1 FROM ledger_identity_aliases a
    WHERE a.chat_id = ledger.chat_id AND a.slug = ledger.slug AND a.user_id > 0
      AND EXISTS (SELECT 1 FROM ledger AS claimed
        WHERE claimed.booking_id = ledger.booking_id AND claimed.slug = 'u' || a.user_id));
UPDATE ledger SET
  user_id = (SELECT a.user_id FROM ledger_identity_aliases a
    WHERE a.chat_id = ledger.chat_id AND a.slug = ledger.slug AND a.user_id > 0),
  slug = 'u' || (SELECT a.user_id FROM ledger_identity_aliases a
    WHERE a.chat_id = ledger.chat_id AND a.slug = ledger.slug AND a.user_id > 0)
WHERE user_id IS NULL AND EXISTS (SELECT 1 FROM ledger_identity_aliases a
  WHERE a.chat_id = ledger.chat_id AND a.slug = ledger.slug AND a.user_id > 0);

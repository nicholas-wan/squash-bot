-- Usernames are aliases; known Telegram ids are the only canonical ledger keys.
-- An alias is claimed once, never silently reassigned when a username changes.
CREATE TABLE IF NOT EXISTS ledger_identity_aliases (
  chat_id INTEGER NOT NULL,
  slug TEXT NOT NULL,
  -- Zero reserves an ambiguous legacy alias; it must never claim history.
  user_id INTEGER NOT NULL,
  PRIMARY KEY (chat_id, slug)
);

INSERT OR IGNORE INTO ledger_identity_aliases (chat_id, slug, user_id)
SELECT chat_id, slug, CASE WHEN COUNT(DISTINCT user_id) = 1 THEN MIN(user_id) ELSE 0 END FROM ledger
WHERE slug LIKE '@%' AND user_id IS NOT NULL
GROUP BY chat_id, slug;

CREATE TRIGGER IF NOT EXISTS ledger_alias_immutable
BEFORE UPDATE ON ledger_identity_aliases
WHEN NEW.chat_id != OLD.chat_id OR NEW.slug != OLD.slug OR NEW.user_id != OLD.user_id
BEGIN
  SELECT RAISE(ABORT, 'Ledger identity aliases cannot be reassigned');
END;

CREATE TRIGGER IF NOT EXISTS ledger_alias_claim
AFTER INSERT ON ledger_identity_aliases
WHEN NEW.user_id > 0
BEGIN
  UPDATE ledger SET user_id = NEW.user_id, slug = 'u' || NEW.user_id
  WHERE chat_id = NEW.chat_id AND slug = NEW.slug AND user_id IS NULL;
END;

CREATE TRIGGER IF NOT EXISTS ledger_identity_insert
BEFORE INSERT ON ledger
WHEN (NEW.user_id IS NOT NULL AND NEW.slug != 'u' || NEW.user_id)
  OR (NEW.user_id IS NULL AND EXISTS (
    SELECT 1 FROM ledger_identity_aliases WHERE chat_id = NEW.chat_id AND slug = NEW.slug AND user_id > 0
  ))
BEGIN
  INSERT OR IGNORE INTO ledger_identity_aliases (chat_id, slug, user_id)
  SELECT NEW.chat_id, NEW.slug, NEW.user_id WHERE NEW.user_id IS NOT NULL AND NEW.slug LIKE '@%';
  INSERT OR IGNORE INTO ledger
    (chat_id,slug,user_id,name,amount_cents,booking_id,reason,created_at)
  VALUES (NEW.chat_id,
    'u' || COALESCE(NEW.user_id, (SELECT user_id FROM ledger_identity_aliases
      WHERE chat_id = NEW.chat_id AND slug = NEW.slug AND user_id > 0)),
    COALESCE(NEW.user_id, (SELECT user_id FROM ledger_identity_aliases
      WHERE chat_id = NEW.chat_id AND slug = NEW.slug AND user_id > 0)),
    NEW.name,NEW.amount_cents,NEW.booking_id,NEW.reason,NEW.created_at);
  SELECT RAISE(IGNORE);
END;

CREATE TRIGGER IF NOT EXISTS ledger_identity_update
AFTER UPDATE OF user_id, slug ON ledger
WHEN (NEW.user_id IS NOT NULL AND NEW.slug != 'u' || NEW.user_id)
  OR (NEW.user_id IS NULL AND EXISTS (
    SELECT 1 FROM ledger_identity_aliases WHERE chat_id = NEW.chat_id AND slug = NEW.slug AND user_id > 0
  ))
BEGIN
  UPDATE ledger SET
    user_id = COALESCE(NEW.user_id, (SELECT user_id FROM ledger_identity_aliases
      WHERE chat_id = NEW.chat_id AND slug = NEW.slug AND user_id > 0)),
    slug = 'u' || COALESCE(NEW.user_id, (SELECT user_id FROM ledger_identity_aliases
      WHERE chat_id = NEW.chat_id AND slug = NEW.slug AND user_id > 0))
  WHERE id = NEW.id;
END;

-- Normalize existing rows without changing their financial contents. A unique
-- booking/slug collision aborts the migration for review rather than dropping money.
UPDATE ledger SET slug = 'u' || user_id
WHERE user_id IS NOT NULL AND slug != 'u' || user_id;
UPDATE ledger SET
  user_id = (SELECT user_id FROM ledger_identity_aliases a
    WHERE a.chat_id = ledger.chat_id AND a.slug = ledger.slug AND a.user_id > 0),
  slug = 'u' || (SELECT user_id FROM ledger_identity_aliases a
    WHERE a.chat_id = ledger.chat_id AND a.slug = ledger.slug AND a.user_id > 0)
WHERE user_id IS NULL AND EXISTS (SELECT 1 FROM ledger_identity_aliases a
  WHERE a.chat_id = ledger.chat_id AND a.slug = ledger.slug AND a.user_id > 0);

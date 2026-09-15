CREATE TABLE IF NOT EXISTS settings (
  chat_id INTEGER PRIMARY KEY,
  tz TEXT NOT NULL DEFAULT 'Asia/Singapore',
  board_message_id INTEGER,
  tab_message_id INTEGER,
  -- Local day the board was last redrawn, so relative labels stay true.
  board_day TEXT,
  -- Local month the last balance notice went out.
  nudged_month TEXT
);

CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  court TEXT NOT NULL,
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  reminder_at INTEGER NOT NULL,
  reminder_sent INTEGER NOT NULL DEFAULT 0,
  pre_reminder_at INTEGER NOT NULL,
  pre_reminder_sent INTEGER NOT NULL DEFAULT 0,
  capacity INTEGER NOT NULL DEFAULT 3,
  charged INTEGER NOT NULL DEFAULT 0,
  created_by_user_id INTEGER,
  created_by_name TEXT,
  source_text TEXT,
  created_at INTEGER NOT NULL
);

-- Who is playing. slug is the stable identity: "u<telegram id>" for anyone who
-- taps a button, "n<name>" for a default player who never does.
CREATE TABLE IF NOT EXISTS booking_players (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id INTEGER NOT NULL,
  chat_id INTEGER NOT NULL,
  user_id INTEGER,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  added_by_user_id INTEGER,
  -- Seats this row holds: 2 when an admin seated them with an untracked friend,
  -- who costs a slot and a share but has no identity to key a row on.
  heads INTEGER NOT NULL DEFAULT 1,
  reminder_sent INTEGER NOT NULL DEFAULT 0,
  pre_reminder_sent INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE (booking_id, slug)
);

-- Append-only money trail. Positive cents are owed to the organiser, negative
-- cents are payments received.
CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  slug TEXT NOT NULL,
  user_id INTEGER,
  name TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  booking_id INTEGER,
  reason TEXT,
  created_at INTEGER NOT NULL
);

-- Partial bookings waiting for inline-button or ForceReply input. Payload is
-- validated again before a confirmed booking is inserted.
CREATE TABLE IF NOT EXISTS booking_drafts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  user_name TEXT,
  source_text TEXT,
  booking_id INTEGER,
  payload TEXT NOT NULL,
  source_message_id INTEGER,
  wizard_message_id INTEGER,
  wizard_ephemeral INTEGER NOT NULL DEFAULT 0,
  reply_prompt_message_id INTEGER,
  pending_field TEXT,
  created_at INTEGER NOT NULL
);

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

-- One row, stamped after each full maintenance pass. The root URL reports its
-- staleness, so any dumb uptime pinger can tell a dead cron from a live bot.
CREATE TABLE IF NOT EXISTS heartbeat (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  beat_at INTEGER NOT NULL
);

-- Per-debtor delivery state makes monthly notices retryable without sending a
-- second copy to people whose first copy already arrived.
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

CREATE TABLE IF NOT EXISTS pending_refreshes (
  chat_id INTEGER PRIMARY KEY,
  board INTEGER NOT NULL DEFAULT 0,
  tab INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS booking_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id INTEGER NOT NULL,
  chat_id INTEGER NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('added', 'edited', 'deleted', 'imported')),
  actor_user_id INTEGER,
  actor_name TEXT,
  source_text TEXT,
  before_json TEXT,
  after_json TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bookings_board
  ON bookings (chat_id, starts_at);

CREATE INDEX IF NOT EXISTS idx_bookings_reminder
  ON bookings (reminder_sent, reminder_at)
  WHERE reminder_sent = 0;

CREATE INDEX IF NOT EXISTS idx_bookings_pre_reminder
  ON bookings (pre_reminder_sent, pre_reminder_at)
  WHERE pre_reminder_sent = 0;

CREATE INDEX IF NOT EXISTS idx_bookings_cleanup
  ON bookings (ends_at);

CREATE INDEX IF NOT EXISTS idx_booking_drafts_user
  ON booking_drafts (chat_id, user_id, created_at);

CREATE INDEX IF NOT EXISTS idx_booking_audit_chat
  ON booking_audit (chat_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_booking_conflicts
  ON bookings (chat_id, court, starts_at, ends_at);

CREATE INDEX IF NOT EXISTS idx_booking_players_chat
  ON booking_players (chat_id, booking_id, id);

CREATE INDEX IF NOT EXISTS idx_booking_players_reminder
  ON booking_players (booking_id, reminder_sent, pre_reminder_sent);

CREATE INDEX IF NOT EXISTS idx_ledger_chat
  ON ledger (chat_id, slug);

CREATE INDEX IF NOT EXISTS idx_sent_messages_due
  ON sent_messages (delete_after);

CREATE INDEX IF NOT EXISTS idx_monthly_notice_pending
  ON monthly_notice_deliveries (chat_id, month, status, last_attempt_at);

-- One charge per player per booking, so a retried cleanup cannot double bill.
CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_booking_slug
  ON ledger (booking_id, slug)
  WHERE booking_id IS NOT NULL;

-- One availability message per group: the earliest upcoming court with a free
-- slot. No foreign key: a cancelled court must leave the message id for cleanup.
CREATE TABLE IF NOT EXISTS availability_notices (
  chat_id INTEGER PRIMARY KEY,
  booking_id INTEGER,
  message_id INTEGER,
  html TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0
);

CREATE TRIGGER IF NOT EXISTS trg_bookings_delete_dependants
AFTER DELETE ON bookings
BEGIN
  DELETE FROM booking_players WHERE booking_id = OLD.id;
  DELETE FROM booking_drafts WHERE booking_id = OLD.id;
END;

CREATE TABLE IF NOT EXISTS maintenance_schedule (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  next_due INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 0,
  config_key TEXT
);
INSERT OR IGNORE INTO maintenance_schedule (id) VALUES (1);
CREATE TRIGGER IF NOT EXISTS schedule_bookings_insert
AFTER INSERT ON bookings BEGIN
  UPDATE maintenance_schedule SET next_due = 0, revision = revision + 1 WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS schedule_bookings_update
AFTER UPDATE ON bookings BEGIN
  UPDATE maintenance_schedule SET next_due = 0, revision = revision + 1 WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS schedule_bookings_delete
AFTER DELETE ON bookings BEGIN
  UPDATE maintenance_schedule SET next_due = 0, revision = revision + 1 WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS schedule_booking_players_insert
AFTER INSERT ON booking_players BEGIN
  UPDATE maintenance_schedule SET next_due = 0, revision = revision + 1 WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS schedule_booking_players_update
AFTER UPDATE ON booking_players BEGIN
  UPDATE maintenance_schedule SET next_due = 0, revision = revision + 1 WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS schedule_booking_players_delete
AFTER DELETE ON booking_players BEGIN
  UPDATE maintenance_schedule SET next_due = 0, revision = revision + 1 WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS schedule_booking_drafts_insert
AFTER INSERT ON booking_drafts BEGIN
  UPDATE maintenance_schedule SET next_due = 0, revision = revision + 1 WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS schedule_booking_drafts_update
AFTER UPDATE ON booking_drafts BEGIN
  UPDATE maintenance_schedule SET next_due = 0, revision = revision + 1 WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS schedule_booking_drafts_delete
AFTER DELETE ON booking_drafts BEGIN
  UPDATE maintenance_schedule SET next_due = 0, revision = revision + 1 WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS schedule_sent_messages_insert
AFTER INSERT ON sent_messages BEGIN
  UPDATE maintenance_schedule SET next_due = 0, revision = revision + 1 WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS schedule_sent_messages_update
AFTER UPDATE ON sent_messages BEGIN
  UPDATE maintenance_schedule SET next_due = 0, revision = revision + 1 WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS schedule_sent_messages_delete
AFTER DELETE ON sent_messages BEGIN
  UPDATE maintenance_schedule SET next_due = 0, revision = revision + 1 WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS schedule_pending_refreshes_insert
AFTER INSERT ON pending_refreshes BEGIN
  UPDATE maintenance_schedule SET next_due = 0, revision = revision + 1 WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS schedule_pending_refreshes_update
AFTER UPDATE ON pending_refreshes BEGIN
  UPDATE maintenance_schedule SET next_due = 0, revision = revision + 1 WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS schedule_pending_refreshes_delete
AFTER DELETE ON pending_refreshes BEGIN
  UPDATE maintenance_schedule SET next_due = 0, revision = revision + 1 WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS schedule_ledger_insert
AFTER INSERT ON ledger BEGIN
  UPDATE maintenance_schedule SET next_due = 0, revision = revision + 1 WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS schedule_ledger_update
AFTER UPDATE ON ledger BEGIN
  UPDATE maintenance_schedule SET next_due = 0, revision = revision + 1 WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS schedule_ledger_delete
AFTER DELETE ON ledger BEGIN
  UPDATE maintenance_schedule SET next_due = 0, revision = revision + 1 WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS schedule_settings_insert
AFTER INSERT ON settings BEGIN
  UPDATE maintenance_schedule SET next_due = 0, revision = revision + 1 WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS schedule_settings_update
AFTER UPDATE ON settings BEGIN
  UPDATE maintenance_schedule SET next_due = 0, revision = revision + 1 WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS schedule_settings_delete
AFTER DELETE ON settings BEGIN
  UPDATE maintenance_schedule SET next_due = 0, revision = revision + 1 WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS schedule_availability_notices_insert
AFTER INSERT ON availability_notices BEGIN
  UPDATE maintenance_schedule SET next_due = 0, revision = revision + 1 WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS schedule_availability_notices_update
AFTER UPDATE OF booking_id, message_id, html ON availability_notices
WHEN NEW.booking_id IS NOT OLD.booking_id OR NEW.message_id IS NOT OLD.message_id OR NEW.html IS NOT OLD.html BEGIN
  UPDATE maintenance_schedule SET next_due = 0, revision = revision + 1 WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS schedule_availability_notices_delete
AFTER DELETE ON availability_notices BEGIN
  UPDATE maintenance_schedule SET next_due = 0, revision = revision + 1 WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS schedule_monthly_notice_deliveries_insert
AFTER INSERT ON monthly_notice_deliveries BEGIN
  UPDATE maintenance_schedule SET next_due = 0, revision = revision + 1 WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS schedule_monthly_notice_deliveries_update
AFTER UPDATE ON monthly_notice_deliveries BEGIN
  UPDATE maintenance_schedule SET next_due = 0, revision = revision + 1 WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS schedule_monthly_notice_deliveries_delete
AFTER DELETE ON monthly_notice_deliveries BEGIN
  UPDATE maintenance_schedule SET next_due = 0, revision = revision + 1 WHERE id = 1;
END;

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

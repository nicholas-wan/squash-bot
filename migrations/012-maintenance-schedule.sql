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

-- The booking_announcements and booking_followups triggers this file once
-- created went with their tables in 014; a fresh schema.sql has neither.

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

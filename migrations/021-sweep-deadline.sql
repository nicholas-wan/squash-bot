-- A private note due tomorrow used to force a full sweep on the next minute.
-- A new or moved message now only brings the deadline forward to its own, and
-- a removed one leaves it alone. The revision still moves, so a sweep running
-- at the same moment recalculates.
DROP TRIGGER IF EXISTS schedule_sent_messages_insert;
CREATE TRIGGER schedule_sent_messages_insert
AFTER INSERT ON sent_messages BEGIN
  UPDATE maintenance_schedule SET next_due = MIN(next_due, NEW.delete_after), revision = revision + 1 WHERE id = 1;
END;

DROP TRIGGER IF EXISTS schedule_sent_messages_update;
CREATE TRIGGER schedule_sent_messages_update
AFTER UPDATE ON sent_messages BEGIN
  UPDATE maintenance_schedule SET next_due = MIN(next_due, NEW.delete_after), revision = revision + 1 WHERE id = 1;
END;

DROP TRIGGER IF EXISTS schedule_sent_messages_delete;
CREATE TRIGGER schedule_sent_messages_delete
AFTER DELETE ON sent_messages BEGIN
  UPDATE maintenance_schedule SET revision = revision + 1 WHERE id = 1;
END;

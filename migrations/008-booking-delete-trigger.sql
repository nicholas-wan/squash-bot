-- Keep transient roster and edit-draft rows from surviving a booking deletion,
-- including deletions performed by maintenance or recovery tooling.
CREATE TRIGGER IF NOT EXISTS trg_bookings_delete_dependants
AFTER DELETE ON bookings
BEGIN
  DELETE FROM booking_players WHERE booking_id = OLD.id;
  DELETE FROM booking_drafts WHERE booking_id = OLD.id;
END;

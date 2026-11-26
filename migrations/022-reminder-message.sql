-- The court's latest group reminder, so the next one can delete it and the
-- group holds at most one reminder per court.
ALTER TABLE bookings ADD COLUMN reminder_message_id INTEGER;

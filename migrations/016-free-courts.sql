-- A court whoever booked it paid for and is not charging anyone: never billed.
ALTER TABLE bookings ADD COLUMN free INTEGER NOT NULL DEFAULT 0;

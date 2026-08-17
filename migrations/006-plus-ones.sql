-- A roster row can stand for two people: an admin seating somebody "with a
-- friend" gives them a second head, which the court counts against capacity and
-- the tab divides by, so the friend needs no Telegram identity of their own.
ALTER TABLE booking_players ADD COLUMN heads INTEGER NOT NULL DEFAULT 1;

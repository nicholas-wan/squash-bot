-- The pinned board's relative labels ("in 5 days") go stale overnight, so the
-- cron redraws each board once per local day and stamps the day it did.
ALTER TABLE settings ADD COLUMN board_day TEXT;
-- One monthly balance notice per data chat, stamped by month so a retried cron
-- cannot send it twice.
ALTER TABLE settings ADD COLUMN nudged_month TEXT;

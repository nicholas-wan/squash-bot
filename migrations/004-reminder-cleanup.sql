-- Reminders are tidied away once their day is over. Telegram cannot list a
-- bot's own messages, so each one is recorded in sent_messages when it is sent.
--
-- This migration added no columns, only the sent_messages table and its index,
-- and `npm run db:init` now creates both: schema.sql is fully IF NOT EXISTS, so
-- it is safe on a live database and leaves nothing for this file to do. Kept as
-- a no-op so the documented upgrade sequence and db:migrate:004 still run.
SELECT 1;

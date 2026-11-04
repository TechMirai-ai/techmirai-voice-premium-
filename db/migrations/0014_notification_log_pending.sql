-- 0014_notification_log_pending.sql
-- VP-23 hardening: a `pending` status so a send can be RESERVED before it happens.
--
-- The daily-cap guard used to count only `sent` rows, which are written after the provider
-- answers (up to seconds later), so simultaneous bookings all counted zero and all sent. Now each
-- send first inserts a `pending` row, then counts `pending` + `sent` rows in the window; the row
-- is settled to `sent` / `failed` / `skipped` afterwards. A row left `pending` (crash mid-send)
-- keeps counting toward the cap until it ages out of the window, which fails safe.
ALTER TABLE notification_log DROP CONSTRAINT notification_log_status_check;
ALTER TABLE notification_log
  ADD CONSTRAINT notification_log_status_check
  CHECK (status IN ('pending', 'sent', 'failed', 'skipped'));

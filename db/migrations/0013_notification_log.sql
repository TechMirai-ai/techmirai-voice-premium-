-- 0013_notification_log.sql
-- Delivery record for booking notifications (VP-23; FUTURE-FEATURES F-2): one row per attempt to
-- tell someone about a booking, kept apart from the appointment itself so a failed SMS or LINE
-- push can never undo or hide a booking ("saving must succeed even if a notifier fails").
--
-- HOLDS NO PERSONAL DATA by design: no phone number, no name, no message text. `recipient_ref` is
-- the NAME of an environment variable (e.g. LINE_STAFF_USER_ID), `detail` is a short reason code
-- (e.g. `no_caller_number`, `http_400`). Keep it that way — this table is safe to log and query.
CREATE TABLE notification_log (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id            text        NOT NULL,
  appointment_id       uuid        REFERENCES appointments(id) ON DELETE CASCADE,
  channel              text        NOT NULL CHECK (channel IN ('sms', 'line')),
  status               text        NOT NULL CHECK (status IN ('sent', 'failed', 'skipped')),
  recipient_ref        text,
  detail               text,
  provider_message_id  text,
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX notification_log_appointment_idx ON notification_log (appointment_id);
CREATE INDEX notification_log_client_channel_idx
  ON notification_log (client_id, channel, status, created_at DESC);

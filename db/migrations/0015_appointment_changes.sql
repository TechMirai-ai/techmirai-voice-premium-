-- 0015_appointment_changes.sql
-- VP-25: callers can cancel or reschedule a booking by phone.
--
-- Cancelling is a SOFT cancel: the row stays (staff visibility, audit) and only `status` changes.
-- A cancelled row stops taking up its slot because the slot lookup and the unique index below only
-- consider `active` rows.

ALTER TABLE appointments
  ADD COLUMN status     text        NOT NULL DEFAULT 'active'
    CONSTRAINT appointments_status_check CHECK (status IN ('active', 'cancelled')),
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

-- One live booking per slot, enforced by the database. Until now this relied on the availability
-- re-check alone (VP-8 decision 4: no concurrency handling); a reschedule is a second writer of
-- slots, so the race is closed here. Production was checked for duplicate active slots before this
-- was added (2026-11-10: none).
CREATE UNIQUE INDEX appointments_active_slot_idx
  ON appointments (client_id, appointment_date, appointment_time)
  WHERE status = 'active';

-- Finding "this caller's upcoming bookings" by the number the call came from.
CREATE INDEX appointments_active_phone_idx
  ON appointments (client_id, patient_phone, appointment_date, appointment_time)
  WHERE status = 'active';

-- One row per cancel / reschedule: what moved, from where, in which call. Holds NO names or phone
-- numbers (like notification_log), so it is safe to log and query.
CREATE TABLE appointment_changes (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id       text        NOT NULL,
  appointment_id  uuid        NOT NULL REFERENCES appointments(id),
  call_id         text        NOT NULL,
  action          text        NOT NULL CHECK (action IN ('cancelled', 'rescheduled')),
  old_date        text        NOT NULL, -- YYYY-MM-DD
  old_time        text        NOT NULL, -- HH:MM, 24-hour
  new_date        text,                 -- null for a cancellation
  new_time        text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX appointment_changes_appointment_idx ON appointment_changes (appointment_id, created_at);
-- A hard "one change per call" rule (owner decision, VP-25): the second change in a call violates
-- this index, so the whole statement that would have made it rolls back.
CREATE UNIQUE INDEX appointment_changes_call_idx ON appointment_changes (client_id, call_id);

-- Notifications now describe more than a booking. `call_id` is the call that CAUSED the
-- notification (for a change, not the call that made the booking), so the one-send-per-call-and-
-- channel limit can be applied per event. Both are plain identifiers, never personal data.
ALTER TABLE notification_log
  ADD COLUMN event   text NOT NULL DEFAULT 'booked'
    CONSTRAINT notification_log_event_check CHECK (event IN ('booked', 'cancelled', 'rescheduled')),
  ADD COLUMN call_id text;

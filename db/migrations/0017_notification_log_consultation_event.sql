-- 0017_notification_log_consultation_event.sql
-- Consultation requests (TechMirai's own agent) send an SMS to the caller and a LINE alert to staff
-- through the same notification pipeline as bookings. The delivery log needs one more event value
-- for them: `consultation_requested`.
--
-- Changes ONLY the CHECK on notification_log.event (added in 0015): the three existing values stay
-- valid, one is added, anything else is still rejected. No data is touched, no column is added.
--
-- Rollback (manual, never a migration; first make sure no `consultation_requested` rows remain):
--   ALTER TABLE notification_log DROP CONSTRAINT notification_log_event_check;
--   ALTER TABLE notification_log ADD CONSTRAINT notification_log_event_check
--     CHECK (event IN ('booked', 'cancelled', 'rescheduled'));
ALTER TABLE notification_log DROP CONSTRAINT notification_log_event_check;
ALTER TABLE notification_log
  ADD CONSTRAINT notification_log_event_check
  CHECK (event IN ('booked', 'cancelled', 'rescheduled', 'consultation_requested'));

-- scripts/remove-follow-up-service.sql
-- Removes the "Follow-up" service (id 'follow-up') from the live reservation_services table so it is
-- no longer offered. The demo seed (npm run demo:seed) only INSERTs, so deleting it from the seed
-- file does not remove an already-seeded row — this script does. Run it by hand; it is never run by
-- the app, the tests or a migration.
--
--   1. Preview (changes nothing):  psql "$DATABASE_URL" -f scripts/remove-follow-up-service.sql
--      It ends in ROLLBACK, so the first run only shows what WOULD change.
--   2. When the preview is right, change the last line from ROLLBACK to COMMIT and run it again.
--   3. THEN run `npm run vapi:sync` — the service list is baked into the assistant prompt and the
--      book_appointment tool's serviceId enum at sync time, so the live assistants keep offering
--      Follow-up until you sync.
--
-- Existing appointments that booked Follow-up keep their service_name snapshot ("Follow-up") for
-- history; only their service_id link is cleared, because appointments.service_id is a foreign key
-- to reservation_services and the row cannot be deleted while anything points at it.
BEGIN;

-- Before: the service and how many appointments point at it.
SELECT id, client_id, name_en, duration_minutes FROM reservation_services WHERE id = 'follow-up';
SELECT count(*) AS appointments_linked FROM appointments WHERE service_id = 'follow-up';

UPDATE appointments SET service_id = NULL WHERE service_id = 'follow-up';
DELETE FROM reservation_services WHERE id = 'follow-up';

-- After: the remaining services, and nothing left pointing at follow-up (both should hold).
SELECT id, name_en, duration_minutes, sort_order FROM reservation_services ORDER BY client_id, sort_order;
SELECT count(*) AS dangling_appointments FROM appointments WHERE service_id = 'follow-up';

ROLLBACK; -- change to COMMIT once the preview above is what you want

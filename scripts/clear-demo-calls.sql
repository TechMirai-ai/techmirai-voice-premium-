-- scripts/clear-demo-calls.sql
-- Wipes the demo call history so a test run starts fresh: every row in call_logs, appointments and
-- callback_requests, for ALL clients. Run it deliberately, by hand — it is never run by the app,
-- the tests or a migration, and it cannot be undone.
--
--   psql "$DATABASE_URL" -f scripts/clear-demo-calls.sql
--
-- Not touched: staff users and sessions, call_topics (per-call topic tags), call_archive_jobs (the
-- Google archive queue; the archived Sheet/Drive files are separate and stay), and the Vapi call
-- records themselves. Add them below if you also want them gone.
BEGIN;

DELETE FROM call_logs;
DELETE FROM appointments;
DELETE FROM callback_requests;

-- Should all read 0 before you COMMIT (this runs inside the same transaction).
SELECT (SELECT count(*) FROM call_logs)         AS call_logs,
       (SELECT count(*) FROM appointments)      AS appointments,
       (SELECT count(*) FROM callback_requests) AS callback_requests;

COMMIT;

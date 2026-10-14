-- 0012_call_logs_caller_phone.sql
-- The caller's phone number per call (VP-15). Today it is typed into the demo /talk page; with real
-- phone lines (SV-5) it becomes the caller ID. NULL for every call logged before this migration —
-- old rows are deliberately not rewritten.
--
-- HOLDS PERSONAL DATA: never log it without src/lib/redact.ts.
ALTER TABLE call_logs ADD COLUMN caller_phone text;

-- Returning-caller lookup: this client's newest call for one number.
CREATE INDEX call_logs_client_phone_idx ON call_logs (client_id, caller_phone, created_at DESC)
  WHERE caller_phone IS NOT NULL;

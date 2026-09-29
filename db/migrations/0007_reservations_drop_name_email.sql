-- 0007_reservations_drop_name_email.sql
-- The reservation flow no longer collects a caller's full name or email
-- address — a phone number, read back and confirmed the same way as
-- request_callback, is now the only identifying detail collected for a
-- booking. Drop the columns that stored them.
ALTER TABLE appointments DROP COLUMN patient_name;
ALTER TABLE appointments DROP COLUMN patient_email;

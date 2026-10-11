-- 0008_appointments_patient_name.sql
-- The reservation flow now asks for, and confirms back, the caller's name instead of a spoken
-- phone number (there is no real caller number on a browser web call yet — see
-- src/lib/demoCallerPhone.ts). Nullable: rows booked before this change have no name.
ALTER TABLE appointments ADD COLUMN patient_name text;

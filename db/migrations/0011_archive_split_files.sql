-- 0011_archive_split_files.sql
-- VP-13: the transcript moves out of the Sheet into its own Drive file, and audio + transcript share
-- one base name (<date>-<time>-<topic>). The job now remembers both pointers so a retry never
-- uploads the same file twice:
--   text_file_url    — the permanent Drive link of the transcript's text file (like drive_url for
--                      audio). Named so: tests/db/callLogs.test.ts forbids any column named like
--                      transcript content, and this holds only a link.
--   file_base_name   — the reserved base name; unique per client, which is what makes a
--                      same-minute/same-topic collision resolve to -2, -3, … without a race.
-- Existing rows keep NULLs: the first test call is deliberately not migrated or renamed.
ALTER TABLE call_archive_jobs ADD COLUMN text_file_url text;
ALTER TABLE call_archive_jobs ADD COLUMN file_base_name text;
CREATE UNIQUE INDEX call_archive_jobs_file_base_name_uq
  ON call_archive_jobs (client_id, file_base_name)
  WHERE file_base_name IS NOT NULL;

-- 0010_archive_sheet_range.sql
-- The developer archive is written in two retryable steps (VP-12): first the transcript row in the
-- private Sheet, then — separately, because it is slower and can fail — the audio upload to Drive,
-- whose permanent link is written back into that same row. `sheet_range` remembers which row, so a
-- retry never appends a duplicate transcript and the link lands next to the right transcript.
-- Still no transcript or audio stored here: only a pointer (an A1 range such as 'Sheet1!A5:J5').
ALTER TABLE call_archive_jobs ADD COLUMN sheet_range text;

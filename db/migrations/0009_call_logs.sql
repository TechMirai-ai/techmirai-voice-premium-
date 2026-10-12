-- 0009_call_logs.sql
-- Per-call staff log and developer-archive job queue (VP-12).
--
-- call_logs HOLDS PERSONAL DATA (caller name, matched patient name, an AI
-- summary that may quote either). It is the staff-visible view of a call.
-- It must NEVER gain a transcript or audio column: staff see summary/status
-- only, and the full transcript + audio live solely in the developer's private
-- Google Sheet/Drive. tests/db/callLogs.test.ts fails if such a column appears.
-- Never log its rows without going through src/lib/redact.ts.
CREATE TABLE call_logs (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id            text        NOT NULL,
  call_id              text        NOT NULL,
  language             text        NOT NULL,
  caller_name          text,
  matched_patient_name text,
  -- A FAQ id or reserved topic from the call-outcome structured output; a slug, never free text.
  topic                text        CHECK (topic ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  -- Fixed enum derived from which tool actually fired (src/lib/callStatus.ts).
  status               text        NOT NULL
    CHECK (status IN ('reservation_made', 'needs_callback', 'resolved_by_ai', 'unresolved')),
  summary              text,
  ended_reason         text,
  started_at           timestamptz,
  ended_at             timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  -- Vapi may redeliver the report: a repeat is a no-op.
  CONSTRAINT call_logs_one_per_call UNIQUE (client_id, call_id)
);

-- "All Calls" and the status-filtered views read newest first per client.
CREATE INDEX call_logs_client_created_idx ON call_logs (client_id, created_at DESC);
CREATE INDEX call_logs_client_status_created_idx ON call_logs (client_id, status, created_at DESC);

-- Developer-only archive state. Holds NO transcript: a retry re-fetches the call
-- from Vapi by id, so Neon never stores one. No staff route may read this table.
CREATE TABLE call_archive_jobs (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id  text        NOT NULL,
  call_id    text        NOT NULL,
  state      text        NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'done', 'failed')),
  attempts   integer     NOT NULL DEFAULT 0,
  drive_url  text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT call_archive_jobs_one_per_call UNIQUE (client_id, call_id)
);

CREATE INDEX call_archive_jobs_state_idx ON call_archive_jobs (state, created_at);

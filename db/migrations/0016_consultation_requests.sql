-- 0016_consultation_requests.sql
-- Consultation requests: a caller asks the clinic to contact them about a consultation, for staff to
-- act on. ADDITIVE ONLY: one new table, nothing existing is altered.
--
-- HOLDS PERSONAL DATA (contact name, phone, a free-text reason). It must NEVER gain a transcript or
-- audio column — tests/db/consultationRequests.test.ts fails if the column list changes. Never log
-- its rows without going through src/lib/redact.ts.
--
-- There is deliberately NO foreign key to call_logs: that row is written at end of call, after the
-- tool that creates a consultation request has already fired.
--
-- Rollback (manual, never a migration):  DROP TABLE consultation_requests;
CREATE TABLE consultation_requests (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id     text        NOT NULL,
  call_id       text        NOT NULL,
  language      text        NOT NULL,
  contact_name  text        NOT NULL,
  -- Same normalised national form as the other tables (src/lib/callerPhone.ts); NULL when none.
  contact_phone text,
  -- Where the number came from: the caller ID of the call, or spoken by the caller.
  phone_source  text        NOT NULL CHECK (phone_source IN ('caller_id', 'spoken')),
  -- Free text, only when the caller stated a reason.
  reason        text,
  status        text        NOT NULL DEFAULT 'new'
    CHECK (status IN ('new', 'contacted', 'scheduled', 'closed')),
  -- Structured extras for later work orders; never a transcript.
  details       jsonb       NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  -- A repeated tool call in the same call is a no-op.
  CONSTRAINT consultation_requests_one_per_call UNIQUE (client_id, call_id)
);

-- The staff list reads "this client's requests, by status, newest first".
CREATE INDEX consultation_requests_client_status_created_idx
  ON consultation_requests (client_id, status, created_at DESC);

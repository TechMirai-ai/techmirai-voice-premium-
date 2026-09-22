-- 0002_callback_requests.sql
-- Callback requests left by callers, for staff to act on (VP-4).
-- This table ALWAYS holds personal data (name, phone): that is its purpose.
-- Never log its rows without going through src/lib/redact.ts.
CREATE TABLE callback_requests (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id    text        NOT NULL,
  call_id      text        NOT NULL,
  language     text        NOT NULL,
  caller_name  text        NOT NULL,
  caller_phone text        NOT NULL,
  reason       text,
  status       text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'handled')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  handled_at   timestamptz,
  CONSTRAINT callback_requests_handled_consistent
    CHECK ((status = 'handled') = (handled_at IS NOT NULL))
);

-- The admin list (VP-5) reads "pending requests for a client, newest first".
CREATE INDEX callback_requests_client_status_created_idx
  ON callback_requests (client_id, status, created_at DESC);

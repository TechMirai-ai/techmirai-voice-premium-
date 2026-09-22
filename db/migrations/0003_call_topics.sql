-- 0003_call_topics.sql
-- Call-topic analytics (VP-4). ZERO personal data, by construction: there is no
-- name, phone or free-text column here, and `topic` is constrained to a short
-- slug so it cannot carry a sentence either. Do not add such a column — a
-- test (tests/db/callTopicsSchema.test.ts) fails if the column list changes.
CREATE TABLE call_topics (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id  text        NOT NULL,
  call_id    text        NOT NULL,
  -- A FAQ id, or 'other' / 'unresolved' / 'emergency'. FAQ ids are data in
  -- client.yaml, so the allowed set is checked by the route, not here; the
  -- pattern only guarantees it is a slug, never free text.
  topic      text        NOT NULL CHECK (topic ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  outcome    text        NOT NULL CHECK (outcome IN ('resolved', 'unresolved', 'emergency')),
  language   text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- One classification per call: a repeated tool call is a no-op.
  CONSTRAINT call_topics_one_per_call UNIQUE (client_id, call_id)
);

CREATE INDEX call_topics_client_created_idx ON call_topics (client_id, created_at DESC);

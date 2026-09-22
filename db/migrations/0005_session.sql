-- 0005_session.sql
-- Server-side session store for staff logins (VP-5 §4.1: connect-pg-simple,
-- not JWT). Schema copied from connect-pg-simple's own table.sql —
-- https://github.com/voxpelli/node-connect-pg-simple/blob/main/table.sql
-- (verified against the package's main branch, 2026-09-22) — not hand-guessed,
-- with ONE deliberate change: the upstream primary key is
-- "DEFERRABLE INITIALLY IMMEDIATE", but connect-pg-simple 10.0.0's own
-- store.set() runs "INSERT ... ON CONFLICT (sid) DO UPDATE", and Postgres
-- refuses a deferrable unique constraint as an ON CONFLICT arbiter
-- ("ON CONFLICT does not support deferrable unique constraints/exclusion
-- constraints as arbiters") — reproduced in tests/db/staffTables.test.ts
-- against a real Postgres before this fix. Dropping DEFERRABLE is the fix;
-- every other column/type/index matches upstream exactly.
CREATE TABLE session (
  sid    varchar      NOT NULL COLLATE "default",
  sess   json         NOT NULL,
  expire timestamp(6) NOT NULL
);

ALTER TABLE session ADD CONSTRAINT session_pkey PRIMARY KEY (sid);

CREATE INDEX idx_session_expire ON session (expire);

-- 0004_staff_users.sql
-- Staff accounts for the callback-requests dashboard (VP-5). Rows are
-- created only by the operator-run CLI (npm run staff:create) — there is no
-- public signup route. Every account starts with must_change_password =
-- true and cannot reach the dashboard until it is flipped (src/routes/
-- staffAuth.ts, src/middleware/staffSession.ts).
CREATE TABLE staff_users (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id            text        NOT NULL,
  email                text        NOT NULL,
  password_hash        text        NOT NULL,
  -- A string, not an enum: F-1's future "client editor" role needs no migration.
  role                 text        NOT NULL DEFAULT 'admin',
  must_change_password boolean     NOT NULL DEFAULT true,
  created_at           timestamptz NOT NULL DEFAULT now()
);

-- The login identifier. Case-folded so "A@x.com" and "a@x.com" cannot both
-- be registered, and so login lookups are case-insensitive without a scan.
CREATE UNIQUE INDEX staff_users_email_lower_idx ON staff_users (lower(email));

-- The dashboard query is scoped by client_id from day one (F-3).
CREATE INDEX staff_users_client_id_idx ON staff_users (client_id);

-- 0001_init.sql
-- Baseline migration. No domain tables yet (VP-1 creates no application tables).
-- pgcrypto gives us gen_random_uuid() for primary keys from VP-4 onwards.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

/**
 * These tests need a real Postgres. Point TEST_DATABASE_URL at the
 * `postgres-test` service from docker-compose.yml (see .env.example).
 * Without it the suite is skipped rather than failing, so `npm test` still
 * works on a machine with no database.
 *
 * Each test runs inside its own Postgres schema, so the tests never see one
 * another's `schema_migrations` rows.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';

import {
  defaultMigrationsDir,
  MIGRATIONS_TABLE,
  MigrationChecksumError,
  readMigrations,
  runMigrations,
} from '../../src/db/migrate.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

/** A pool whose connections default to `schema`, so everything stays isolated. */
function poolForSchema(schema: string): pg.Pool {
  const url = new URL(TEST_DATABASE_URL!);
  url.searchParams.set('options', `-c search_path=${schema}`);
  return new pg.Pool({ connectionString: url.toString(), connectionTimeoutMillis: 5_000 });
}

describe.skipIf(!TEST_DATABASE_URL)('migration runner', () => {
  const schema = `tmvp_test_${Date.now()}_${Math.floor(Math.random() * 10_000)}`;
  let adminPool: pg.Pool;
  let pool: pg.Pool;
  const tempDirs: string[] = [];

  const migrationsFixture = (files: Record<string, string>): string => {
    const dir = mkdtempSync(path.join(tmpdir(), 'tmvp-migrations-'));
    tempDirs.push(dir);
    for (const [filename, sql] of Object.entries(files)) {
      writeFileSync(path.join(dir, filename), sql, 'utf8');
    }
    return dir;
  };

  beforeAll(async () => {
    adminPool = new pg.Pool({
      connectionString: TEST_DATABASE_URL,
      connectionTimeoutMillis: 5_000,
    });
    await adminPool.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    pool = poolForSchema(schema);
  });

  afterAll(async () => {
    await pool?.end();
    await adminPool?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await adminPool?.end();
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  });

  afterEach(async () => {
    await pool.query(`DROP TABLE IF EXISTS ${MIGRATIONS_TABLE}`);
    await pool.query('DROP TABLE IF EXISTS widgets');
    // Tables created by the repo's own migrations, so the next test can re-apply them.
    await pool.query(
      'DROP TABLE IF EXISTS callback_requests, call_topics, staff_users, session, ' +
        'appointments, reservation_services, reservation_demo_patients, reservation_booked_slots',
    );
  });

  test('applies the repo migrations, then applies nothing on a second run', async () => {
    const first = await runMigrations(pool);
    expect(first.applied).toContain('0001_init.sql');

    const second = await runMigrations(pool);
    expect(second.applied).toEqual([]);
    expect(second.skipped).toEqual(first.applied);
  });

  test('records each applied file with its checksum', async () => {
    await runMigrations(pool);

    const { rows } = await pool.query<{ filename: string; checksum: string }>(
      `SELECT filename, checksum FROM ${MIGRATIONS_TABLE} ORDER BY filename`,
    );
    const onDisk = readMigrations(defaultMigrationsDir());

    expect(rows.map((row) => row.filename)).toEqual(onDisk.map((file) => file.filename));
    expect(rows[0]?.checksum).toBe(onDisk[0]?.checksum);
  });

  test('refuses to run when an already-applied file has been edited', async () => {
    const dir = migrationsFixture({
      '0001_widgets.sql': 'CREATE TABLE widgets (id int primary key);',
    });

    await runMigrations(pool, { dir });
    writeFileSync(
      path.join(dir, '0001_widgets.sql'),
      'CREATE TABLE widgets (id int primary key, extra text);',
      'utf8',
    );

    await expect(runMigrations(pool, { dir })).rejects.toThrow(MigrationChecksumError);
    await expect(runMigrations(pool, { dir })).rejects.toThrow(/contents changed/);
  });

  test('applies files in filename order', async () => {
    const dir = migrationsFixture({
      '0002_widgets_extra.sql': 'ALTER TABLE widgets ADD COLUMN extra text;',
      '0001_widgets.sql': 'CREATE TABLE widgets (id int primary key);',
    });

    const result = await runMigrations(pool, { dir });

    expect(result.applied).toEqual(['0001_widgets.sql', '0002_widgets_extra.sql']);
  });

  test('rolls the whole file back when a statement fails, and records nothing', async () => {
    const dir = migrationsFixture({
      '0001_bad.sql': 'CREATE TABLE widgets (id int primary key); SELECT this_does_not_exist();',
    });

    await expect(runMigrations(pool, { dir })).rejects.toThrow();

    const { rows } = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${MIGRATIONS_TABLE}`,
    );
    expect(rows[0]?.count).toBe('0');
    const widgets = await pool.query<{ exists: boolean }>(
      `SELECT to_regclass('${schema}.widgets') IS NOT NULL AS exists`,
    );
    expect(widgets.rows[0]?.exists).toBe(false);
  });
});

describe('readMigrations', () => {
  test('reads the repo migrations in filename order with a checksum each', () => {
    const migrations = readMigrations(defaultMigrationsDir());

    expect(migrations.length).toBeGreaterThan(0);
    expect(migrations[0]?.filename).toBe('0001_init.sql');
    expect(migrations[0]?.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(migrations.map((m) => m.filename)).toEqual(
      [...migrations.map((m) => m.filename)].sort(),
    );
  });

  test('the first migration only enables pgcrypto — VP-1 adds no domain tables', () => {
    const [first] = readMigrations(defaultMigrationsDir());

    expect(first?.sql).toMatch(/CREATE EXTENSION IF NOT EXISTS pgcrypto/i);
    expect(first?.sql).not.toMatch(/CREATE TABLE/i);
  });
});

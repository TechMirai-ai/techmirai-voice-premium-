/**
 * Plain-SQL migration runner.
 *
 * - applies `db/migrations/*.sql` in filename order, one transaction per file;
 * - records every applied file in `schema_migrations` with a checksum;
 * - refuses to run if an already-applied file has been edited since.
 *
 * Run with `npm run db:migrate`.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type pg from 'pg';

import { loadDatabaseUrl } from '../env.js';
import { createPool } from './pool.js';

export const MIGRATIONS_TABLE = 'schema_migrations';

/** Namespaced advisory lock id, so two runners cannot overlap. */
const ADVISORY_LOCK_ID = 4_120_250_917;

export interface MigrationFile {
  filename: string;
  sql: string;
  checksum: string;
}

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

export class MigrationChecksumError extends Error {
  constructor(filename: string) {
    super(
      `Migration "${filename}" has already been applied but its contents changed. ` +
        'Applied migrations are immutable — add a new migration file instead.',
    );
    this.name = 'MigrationChecksumError';
  }
}

export function defaultMigrationsDir(): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  let dir = moduleDir;

  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = path.join(dir, 'db', 'migrations');
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  throw new Error(`Could not locate db/migrations starting from ${moduleDir}`);
}

const checksumOf = (sql: string): string => createHash('sha256').update(sql, 'utf8').digest('hex');

/** Reads every `.sql` file in the directory, sorted by filename. */
export function readMigrations(dir: string = defaultMigrationsDir()): MigrationFile[] {
  return readdirSync(dir)
    .filter((filename) => filename.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b, 'en'))
    .map((filename) => {
      const sql = readFileSync(path.join(dir, filename), 'utf8');
      return { filename, sql, checksum: checksumOf(sql) };
    });
}

export interface RunMigrationsOptions {
  dir?: string;
  onApplied?: (filename: string) => void;
}

/**
 * Applies every migration that has not been applied yet.
 * Running it twice in a row applies nothing the second time.
 */
export async function runMigrations(
  pool: pg.Pool,
  options: RunMigrationsOptions = {},
): Promise<MigrationResult> {
  const migrations = readMigrations(options.dir);
  const client = await pool.connect();
  const applied: string[] = [];
  const skipped: string[] = [];

  try {
    await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_ID]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
        filename   text PRIMARY KEY,
        checksum   text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const { rows } = await client.query<{ filename: string; checksum: string }>(
      `SELECT filename, checksum FROM ${MIGRATIONS_TABLE}`,
    );
    const alreadyApplied = new Map(rows.map((row) => [row.filename, row.checksum]));

    for (const migration of migrations) {
      const previousChecksum = alreadyApplied.get(migration.filename);

      if (previousChecksum !== undefined) {
        if (previousChecksum !== migration.checksum) {
          throw new MigrationChecksumError(migration.filename);
        }
        skipped.push(migration.filename);
        continue;
      }

      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        await client.query(`INSERT INTO ${MIGRATIONS_TABLE} (filename, checksum) VALUES ($1, $2)`, [
          migration.filename,
          migration.checksum,
        ]);
        await client.query('COMMIT');
      } catch (cause) {
        await client.query('ROLLBACK');
        throw cause;
      }

      applied.push(migration.filename);
      options.onApplied?.(migration.filename);
    }

    return { applied, skipped };
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_ID]).catch(() => undefined);
    client.release();
  }
}

/** `npm run db:migrate` */
async function main(): Promise<void> {
  const databaseUrl = loadDatabaseUrl();
  const pool = createPool({ connectionString: databaseUrl });

  try {
    const result = await runMigrations(pool, {
      onApplied: (filename) => console.log(`applied ${filename}`),
    });
    const summary =
      result.applied.length === 0
        ? `Database already up to date (${result.skipped.length} migration(s) applied previously).`
        : `Applied ${result.applied.length} migration(s).`;
    console.log(summary);
  } finally {
    await pool.end();
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

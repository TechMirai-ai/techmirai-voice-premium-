/** Postgres connection pool. */
import pg from 'pg';

const { Pool } = pg;

/**
 * The narrow slice of `pg.Pool` the app actually uses. Depending on this rather
 * than on `Pool` keeps the health check and the migration runner testable
 * without a live database.
 */
export interface Queryable {
  query(sql: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
}

export interface CreatePoolOptions {
  connectionString: string;
  /** Fail a connection attempt rather than hanging when the DB is unreachable. */
  connectionTimeoutMillis?: number;
  max?: number;
}

const DEFAULT_CONNECTION_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_CLIENTS = 10;

export function createPool(options: CreatePoolOptions): pg.Pool {
  return new Pool({
    connectionString: options.connectionString,
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? DEFAULT_CONNECTION_TIMEOUT_MS,
    max: options.max ?? DEFAULT_MAX_CLIENTS,
  });
}

/** `SELECT 1` — used by GET /healthz. Returns false instead of throwing. */
export async function isDatabaseReachable(db: Queryable): Promise<boolean> {
  try {
    await db.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

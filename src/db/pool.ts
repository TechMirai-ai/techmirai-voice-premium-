/** Postgres connection pool. */
import net from 'node:net';

import pg from 'pg';

const { Pool } = pg;

// `pg` opens its socket with a bare `net.Socket.connect(port, host)` (see
// pg/lib/connection.js) — it never passes `family`/`lookup`/`autoSelectFamily`
// through, so Node's default dual-stack "Happy Eyeballs" racing (enabled by
// default since Node 18.13/20) is the only thing deciding how that connect
// happens. On networks with no outbound IPv6 route, the IPv6 candidate fails
// instantly with ENETUNREACH, but — confirmed against a real Neon host — the
// IPv4 candidate can still be aborted by the *same* racing/timeout machinery
// and come back ETIMEDOUT even though a plain `nc`/`telnet` to that exact IP
// succeeds immediately. `connectionTimeoutMillis` below never even gets a
// chance to fire in that case. Disabling autoselection makes every `net`
// connection in this process use plain sequential resolution instead.
net.setDefaultAutoSelectFamily(false);

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

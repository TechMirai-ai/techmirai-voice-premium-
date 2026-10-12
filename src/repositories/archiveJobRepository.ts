/**
 * The developer-archive job queue (db/migrations/0009 + 0010). DEVELOPER-ONLY: no staff route may
 * read this table. It holds progress pointers (a Sheet range, a Drive link) and an error message —
 * never a transcript or audio.
 *
 * Claiming is atomic and leased: `attempts` is incremented and `updated_at` touched in the same
 * statement, and a job only becomes claimable again once the lease has lapsed, so an inline attempt
 * from the webhook and a retry run can never process the same call at once.
 */
import type { Queryable } from '../db/pool.js';
import type { ArchiveJob, JobStore } from '../google/archive.js';

export const MAX_ARCHIVE_ATTEMPTS = 5;
/** How long a claim is held before another worker may take the job over. */
export const CLAIM_LEASE_SECONDS = 120;

export interface ArchiveQueueCounts {
  pending: number;
  done: number;
  failed: number;
}

export interface ArchiveJobRepository extends JobStore {
  /** Idempotent per (client, call). */
  enqueue(clientId: string, callId: string): Promise<void>;
  /** Claims this call's job if it is runnable; `undefined` if done, failed, or leased by someone else. */
  claimCall(clientId: string, callId: string): Promise<ArchiveJob | undefined>;
  /** Claims up to `limit` runnable jobs, oldest first. */
  claimRunnable(limit: number): Promise<ArchiveJob[]>;
  countByState(): Promise<ArchiveQueueCounts>;
}

interface JobRow {
  id: string;
  client_id: string;
  call_id: string;
  attempts: number;
  sheet_range: string | null;
  drive_url: string | null;
  language: string | null;
  status: string | null;
}

const RUNNABLE = `state = 'pending' AND (attempts = 0 OR updated_at < now() - make_interval(secs => $LEASE))`;

/** Runs `claimSql` (an UPDATE … RETURNING *) and joins the call's language/status for the sheet row. */
const withCallLog = (claimSql: string): string => `
  WITH claimed AS (${claimSql})
  SELECT c.id, c.client_id, c.call_id, c.attempts, c.sheet_range, c.drive_url, l.language, l.status
  FROM claimed c
  LEFT JOIN call_logs l ON l.client_id = c.client_id AND l.call_id = c.call_id
  ORDER BY c.created_at`;

function toJob(row: JobRow): ArchiveJob {
  return {
    id: row.id,
    clientId: row.client_id,
    callId: row.call_id,
    attempts: row.attempts,
    language: row.language ?? undefined,
    status: row.status ?? undefined,
    sheetRange: row.sheet_range ?? undefined,
    driveUrl: row.drive_url ?? undefined,
  };
}

export class PgArchiveJobRepository implements ArchiveJobRepository {
  constructor(private readonly db: Queryable) {}

  async enqueue(clientId: string, callId: string): Promise<void> {
    await this.db.query(
      `INSERT INTO call_archive_jobs (client_id, call_id) VALUES ($1, $2)
       ON CONFLICT (client_id, call_id) DO NOTHING`,
      [clientId, callId],
    );
  }

  async claimCall(clientId: string, callId: string): Promise<ArchiveJob | undefined> {
    const { rows } = await this.db.query(
      withCallLog(`
        UPDATE call_archive_jobs SET attempts = attempts + 1, updated_at = now()
        WHERE id = (
          SELECT id FROM call_archive_jobs
          WHERE client_id = $1 AND call_id = $2 AND ${RUNNABLE.replace('$LEASE', '$3')}
          FOR UPDATE SKIP LOCKED)
        RETURNING *`),
      [clientId, callId, CLAIM_LEASE_SECONDS],
    );
    const row = rows[0] as JobRow | undefined;
    return row ? toJob(row) : undefined;
  }

  async claimRunnable(limit: number): Promise<ArchiveJob[]> {
    const { rows } = await this.db.query(
      withCallLog(`
        UPDATE call_archive_jobs SET attempts = attempts + 1, updated_at = now()
        WHERE id IN (
          SELECT id FROM call_archive_jobs
          WHERE ${RUNNABLE.replace('$LEASE', '$2')}
          ORDER BY created_at
          LIMIT $1
          FOR UPDATE SKIP LOCKED)
        RETURNING *`),
      [limit, CLAIM_LEASE_SECONDS],
    );
    return (rows as JobRow[]).map(toJob);
  }

  async recordSheetRow(jobId: string, sheetRange: string): Promise<void> {
    await this.db.query(
      'UPDATE call_archive_jobs SET sheet_range = $2, updated_at = now() WHERE id = $1',
      [jobId, sheetRange],
    );
  }

  async recordDriveLink(jobId: string, driveUrl: string): Promise<void> {
    await this.db.query(
      'UPDATE call_archive_jobs SET drive_url = $2, updated_at = now() WHERE id = $1',
      [jobId, driveUrl],
    );
  }

  async markDone(jobId: string): Promise<void> {
    await this.db.query(
      `UPDATE call_archive_jobs SET state = 'done', last_error = NULL, updated_at = now() WHERE id = $1`,
      [jobId],
    );
  }

  async recordFailure(jobId: string, message: string): Promise<void> {
    await this.db.query(
      `UPDATE call_archive_jobs
       SET last_error = $2,
           state = CASE WHEN attempts >= $3 THEN 'failed' ELSE state END,
           updated_at = now()
       WHERE id = $1`,
      [jobId, message, MAX_ARCHIVE_ATTEMPTS],
    );
  }

  async countByState(): Promise<ArchiveQueueCounts> {
    const { rows } = await this.db.query(
      'SELECT state, count(*)::text AS count FROM call_archive_jobs GROUP BY state',
    );
    const counts: ArchiveQueueCounts = { pending: 0, done: 0, failed: 0 };
    for (const row of rows as Array<{ state: keyof ArchiveQueueCounts; count: string }>) {
      counts[row.state] = Number(row.count);
    }
    return counts;
  }
}

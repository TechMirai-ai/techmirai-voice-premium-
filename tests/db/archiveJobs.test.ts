/**
 * Needs a real Postgres (TEST_DATABASE_URL); skipped otherwise, like migrate.test.ts.
 * Runs the repo's own migrations in a throwaway schema.
 */
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { runMigrations } from '../../src/db/migrate.js';
import {
  MAX_ARCHIVE_ATTEMPTS,
  PgArchiveJobRepository,
} from '../../src/repositories/archiveJobRepository.js';
import { PgCallLogRepository } from '../../src/repositories/callLogRepository.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DATABASE_URL)('call_archive_jobs (real Postgres)', () => {
  const schema = `tmvp_archive_${Date.now()}_${Math.floor(Math.random() * 10_000)}`;
  let adminPool: pg.Pool;
  let pool: pg.Pool;
  let repo: PgArchiveJobRepository;

  const stateOf = async (callId: string) =>
    (
      await pool.query<{
        state: string;
        attempts: number;
        sheet_range: string | null;
        drive_url: string | null;
        last_error: string | null;
      }>(
        'SELECT state, attempts, sheet_range, drive_url, last_error FROM call_archive_jobs WHERE call_id = $1',
        [callId],
      )
    ).rows[0]!;

  beforeAll(async () => {
    adminPool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(TEST_DATABASE_URL!);
    url.searchParams.set('options', `-c search_path=${schema},public`);
    pool = new pg.Pool({ connectionString: url.toString() });
    await runMigrations(pool);
    repo = new PgArchiveJobRepository(pool);
  });

  afterAll(async () => {
    await pool?.end();
    await adminPool?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await adminPool?.end();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM call_archive_jobs');
    await pool.query('DELETE FROM call_logs');
  });

  test('enqueue is idempotent per (client, call)', async () => {
    await repo.enqueue('c', 'call-1');
    await repo.enqueue('c', 'call-1');
    const { rows } = await pool.query('SELECT 1 FROM call_archive_jobs');
    expect(rows).toHaveLength(1);
  });

  test('claiming a call returns the job with its status and language from call_logs, and counts an attempt', async () => {
    await new PgCallLogRepository(pool).record({
      clientId: 'c',
      callId: 'call-1',
      language: 'ja',
      status: 'needs_callback',
    });
    await repo.enqueue('c', 'call-1');

    const job = await repo.claimCall('c', 'call-1');

    expect(job).toMatchObject({
      clientId: 'c',
      callId: 'call-1',
      language: 'ja',
      status: 'needs_callback',
      attempts: 1,
    });
    expect((await stateOf('call-1')).attempts).toBe(1);
  });

  test('a claimed job cannot be claimed again while its lease is held', async () => {
    await repo.enqueue('c', 'call-1');

    expect(await repo.claimCall('c', 'call-1')).toBeDefined();
    expect(await repo.claimCall('c', 'call-1')).toBeUndefined();
    expect(await repo.claimRunnable(10)).toEqual([]);
  });

  test('a job whose lease has expired can be claimed again', async () => {
    await repo.enqueue('c', 'call-1');
    await repo.claimCall('c', 'call-1');
    await pool.query("UPDATE call_archive_jobs SET updated_at = now() - interval '10 minutes'");

    const jobs = await repo.claimRunnable(10);

    expect(jobs.map((job) => job.callId)).toEqual(['call-1']);
    expect(jobs[0]?.attempts).toBe(2);
  });

  test('claimRunnable respects the limit and takes the oldest first', async () => {
    await repo.enqueue('c', 'old');
    await pool.query("UPDATE call_archive_jobs SET created_at = now() - interval '1 hour'");
    await repo.enqueue('c', 'new-1');
    await repo.enqueue('c', 'new-2');

    const jobs = await repo.claimRunnable(2);

    expect(jobs).toHaveLength(2);
    expect(jobs[0]?.callId).toBe('old');
  });

  test('records progress so a retry resumes: sheet row, drive link, then done', async () => {
    await repo.enqueue('c', 'call-1');
    const job = (await repo.claimCall('c', 'call-1'))!;

    await repo.recordSheetRow(job.id, 'Sheet1!A5:J5');
    await repo.recordDriveLink(job.id, 'https://drive.example/f');
    await repo.markDone(job.id);

    expect(await stateOf('call-1')).toMatchObject({
      state: 'done',
      sheet_range: 'Sheet1!A5:J5',
      drive_url: 'https://drive.example/f',
      last_error: null,
    });
    expect(await repo.claimRunnable(10)).toEqual([]);
  });

  test('a resumed job carries its progress into the next claim', async () => {
    await repo.enqueue('c', 'call-1');
    const first = (await repo.claimCall('c', 'call-1'))!;
    await repo.recordSheetRow(first.id, 'Sheet1!A5:J5');
    await repo.recordFailure(first.id, 'audio: Drive down');
    await pool.query("UPDATE call_archive_jobs SET updated_at = now() - interval '10 minutes'");

    const [second] = await repo.claimRunnable(10);

    expect(second).toMatchObject({ sheetRange: 'Sheet1!A5:J5', attempts: 2 });
    expect((await stateOf('call-1')).last_error).toBe('audio: Drive down');
  });

  test(`after ${MAX_ARCHIVE_ATTEMPTS} failed attempts the job is marked failed and never claimed again`, async () => {
    await repo.enqueue('c', 'call-1');
    for (let attempt = 1; attempt <= MAX_ARCHIVE_ATTEMPTS; attempt += 1) {
      await pool.query("UPDATE call_archive_jobs SET updated_at = now() - interval '10 minutes'");
      const [job] = await repo.claimRunnable(1);
      expect(job).toBeDefined();
      await repo.recordFailure(job!.id, `sheet: attempt ${attempt}`);
    }

    expect((await stateOf('call-1')).state).toBe('failed');
    await pool.query("UPDATE call_archive_jobs SET updated_at = now() - interval '10 minutes'");
    expect(await repo.claimRunnable(10)).toEqual([]);
  });

  test('countByState reports the queue for the retry summary', async () => {
    await repo.enqueue('c', 'a');
    await repo.enqueue('c', 'b');
    const job = (await repo.claimCall('c', 'a'))!;
    await repo.markDone(job.id);

    expect(await repo.countByState()).toEqual({ pending: 1, done: 1, failed: 0 });
  });
});

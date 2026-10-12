/**
 * Needs a real Postgres (TEST_DATABASE_URL); skipped otherwise, like migrate.test.ts.
 * Runs the repo's own migrations in a throwaway schema.
 */
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { runMigrations } from '../../src/db/migrate.js';
import { PgCallLogRepository } from '../../src/repositories/callLogRepository.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

/**
 * If you are here because this failed after adding a column to call_logs or
 * call_archive_jobs: STOP. Staff must never be able to reach a transcript or
 * audio. The full transcript/audio live only in the developer's private Google
 * Sheet/Drive (VP-12 decisions 2 and 5) — do not add them to Neon.
 */
const CALL_LOGS_COLUMNS = [
  'call_id',
  'caller_name',
  'client_id',
  'created_at',
  'ended_at',
  'ended_reason',
  'id',
  'language',
  'matched_patient_name',
  'started_at',
  'status',
  'summary',
  'topic',
];

describe.skipIf(!TEST_DATABASE_URL)('call_logs (real Postgres)', () => {
  const schema = `tmvp_calllogs_${Date.now()}_${Math.floor(Math.random() * 10_000)}`;
  let adminPool: pg.Pool;
  let pool: pg.Pool;

  const columnsOf = async (table: string): Promise<string[]> => {
    const { rows } = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = $2 ORDER BY column_name`,
      [schema, table],
    );
    return rows.map((row) => row.column_name);
  };

  beforeAll(async () => {
    adminPool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(TEST_DATABASE_URL!);
    url.searchParams.set('options', `-c search_path=${schema},public`);
    pool = new pg.Pool({ connectionString: url.toString() });
    await runMigrations(pool);
  });

  afterAll(async () => {
    await pool?.end();
    await adminPool?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await adminPool?.end();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM call_logs');
    await pool.query('DELETE FROM appointments');
  });

  test('has exactly the expected columns — no transcript or audio column', async () => {
    expect(await columnsOf('call_logs')).toEqual(CALL_LOGS_COLUMNS);
  });

  test('no column on either table is named like a transcript, audio or recording field', async () => {
    for (const table of ['call_logs', 'call_archive_jobs']) {
      for (const name of await columnsOf(table)) {
        expect(name).not.toMatch(/transcript|audio|recording|message|conversation/i);
      }
    }
  });

  test('refuses a status outside the fixed enum', async () => {
    await expect(
      pool.query(
        `INSERT INTO call_logs (client_id, call_id, language, status)
         VALUES ('c', 'x', 'ja', 'maybe')`,
      ),
    ).rejects.toThrow(/check constraint/);
  });

  test('the topic column refuses a sentence', async () => {
    await expect(
      pool.query(
        `INSERT INTO call_logs (client_id, call_id, language, status, topic)
         VALUES ('c', 'x', 'ja', 'unresolved', 'Hanako called about her knee')`,
      ),
    ).rejects.toThrow(/check constraint/);
  });

  test('the repository stores every field and ignores a redelivered report', async () => {
    const repo = new PgCallLogRepository(pool);
    const log = {
      clientId: 'c',
      callId: 'call-1',
      language: 'ja',
      status: 'needs_callback' as const,
      callerName: 'Hanako',
      matchedPatientName: 'ヤマダ タロウ',
      topic: 'parking',
      summary: 'Asked for a callback.',
      endedReason: 'assistant-ended-call',
      startedAt: '2026-10-12T01:00:00.000Z',
      endedAt: '2026-10-12T01:02:00.000Z',
    };

    await repo.record(log);
    await repo.record({ ...log, status: 'unresolved' });

    const { rows } = await pool.query(
      'SELECT status, caller_name, matched_patient_name, topic, summary FROM call_logs',
    );
    expect(rows).toEqual([
      {
        status: 'needs_callback',
        caller_name: 'Hanako',
        matched_patient_name: 'ヤマダ タロウ',
        topic: 'parking',
        summary: 'Asked for a callback.',
      },
    ]);
  });

  describe('staff reads (CallLogReader)', () => {
    const log = (
      callId: string,
      overrides: Partial<Parameters<PgCallLogRepository['record']>[0]> = {},
    ) =>
      new PgCallLogRepository(pool).record({
        clientId: 'c',
        callId,
        language: 'ja',
        status: 'unresolved',
        ...overrides,
      });

    test('lists one client’s calls newest first and never another client’s', async () => {
      await log('old', { startedAt: '2026-10-10T00:00:00.000Z' });
      await log('new', { startedAt: '2026-10-12T00:00:00.000Z' });
      await log('foreign', { clientId: 'other' });

      const rows = await new PgCallLogRepository(pool).listByClient('c');

      expect(rows.map((row) => row.callId)).toEqual(['new', 'old']);
    });

    test('filters by status', async () => {
      await log('a', { status: 'needs_callback' });
      await log('b', { status: 'resolved_by_ai' });

      const rows = await new PgCallLogRepository(pool).listByClient('c', {
        status: 'needs_callback',
      });

      expect(rows.map((row) => row.callId)).toEqual(['a']);
    });

    test('is capped, so a busy clinic never loads an unbounded list', async () => {
      await log('a');
      await log('b');
      await log('c2');

      expect(await new PgCallLogRepository(pool).listByClient('c', { limit: 2 })).toHaveLength(2);
    });

    test('returns exactly the staff-safe fields — nothing else can come back', async () => {
      await log('a', {
        callerName: 'Hanako',
        matchedPatientName: 'ヤマダ タロウ',
        topic: 'parking',
        summary: 'Asked about parking.',
        endedReason: 'assistant-ended-call',
        startedAt: '2026-10-12T00:00:00.000Z',
      });

      const [row] = await new PgCallLogRepository(pool).listByClient('c');

      expect(Object.keys(row!).sort()).toEqual([
        'callId',
        'callerName',
        'createdAt',
        'id',
        'language',
        'matchedPatientName',
        'startedAt',
        'status',
        'summary',
        'topic',
      ]);
    });

    test('reservations: only reservation_made calls, joined with the booking details', async () => {
      await log('booked', { status: 'reservation_made', startedAt: '2026-10-12T00:00:00.000Z' });
      await log('callback', { status: 'needs_callback' });
      await pool.query(
        `INSERT INTO appointments
           (client_id, call_id, language, reservation_number, patient_name, patient_phone,
            appointment_date, appointment_time, service_name)
         VALUES ('c', 'booked', 'ja', 'R000001', 'ヤマダ タロウ', '000', '2026-10-20', '10:30', 'General')`,
      );

      const rows = await new PgCallLogRepository(pool).listReservations('c');

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        callId: 'booked',
        reservationNumber: 'R000001',
        appointmentDate: '2026-10-20',
        appointmentTime: '10:30',
        serviceName: 'General',
      });
    });

    test('reservations: a reservation_made call with no appointment row still appears', async () => {
      await log('booked', { status: 'reservation_made' });

      const [row] = await new PgCallLogRepository(pool).listReservations('c');

      expect(row).toMatchObject({ callId: 'booked', reservationNumber: null });
    });
  });

  test('optional fields are stored as NULL when absent', async () => {
    await new PgCallLogRepository(pool).record({
      clientId: 'c',
      callId: 'call-2',
      language: 'en',
      status: 'unresolved',
    });
    const { rows } = await pool.query('SELECT caller_name, topic, summary FROM call_logs');
    expect(rows).toEqual([{ caller_name: null, topic: null, summary: null }]);
  });
});

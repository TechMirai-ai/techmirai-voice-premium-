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
    await pool.query('DELETE FROM callback_requests');
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
        'callback',
        'callerName',
        'createdAt',
        'durationSeconds',
        'id',
        'language',
        'matchedPatientName',
        'startedAt',
        'status',
        'summary',
        'topic',
      ]);
    });

    test('duration is the whole seconds between started_at and ended_at', async () => {
      await log('a', {
        startedAt: '2026-10-12T00:00:00.000Z',
        endedAt: '2026-10-12T00:03:07.400Z',
      });

      const [row] = await new PgCallLogRepository(pool).listByClient('c');

      expect(row?.durationSeconds).toBe(187);
    });

    test('duration is null when the call has no end time, no start time, or ends before it starts', async () => {
      await log('no-end', { startedAt: '2026-10-12T00:00:00.000Z' });
      await log('no-start', { endedAt: '2026-10-12T00:03:00.000Z' });
      await log('backwards', {
        startedAt: '2026-10-12T00:05:00.000Z',
        endedAt: '2026-10-12T00:03:00.000Z',
      });

      const rows = await new PgCallLogRepository(pool).listByClient('c');

      expect(rows).toHaveLength(3);
      expect(rows.every((row) => row.durationSeconds === null)).toBe(true);
    });

    const appointment = (callId: string, number: string, createdAt = 'now()'): Promise<unknown> =>
      pool.query(
        `INSERT INTO appointments
           (client_id, call_id, language, reservation_number, patient_name, patient_phone,
            appointment_date, appointment_time, service_name, created_at)
         VALUES ('c', $1, 'ja', $2, 'ヤマダ タロウ', '000', '2026-10-20', '10:30', 'General',
                 ${createdAt === 'now()' ? 'now()' : '$3::timestamptz'})`,
        createdAt === 'now()' ? [callId, number] : [callId, number, createdAt],
      );

    test('callback: a needs_callback call carries its callback request, so it can be marked handled', async () => {
      await log('cb-call', { status: 'needs_callback' });
      await log('plain', { status: 'resolved_by_ai' });
      await pool.query(
        `INSERT INTO callback_requests (client_id, call_id, language, caller_name, caller_phone, reason)
         VALUES ('c', 'cb-call', 'ja', 'Hanako', '000-0000-0000', 'Asked about a treatment')`,
      );

      const rows = await new PgCallLogRepository(pool).listByClient('c');
      const withCallback = rows.find((row) => row.callId === 'cb-call');
      const without = rows.find((row) => row.callId === 'plain');

      expect(withCallback?.callback).toMatchObject({
        callerPhone: '000-0000-0000',
        reason: 'Asked about a treatment',
        status: 'pending',
        handledAt: null,
      });
      expect(withCallback?.callback?.id).toEqual(expect.any(String));
      expect(without?.callback).toBeNull();
    });

    test('callback: two requests for one call never turn it into two rows', async () => {
      await log('cb-call', { status: 'needs_callback' });
      await pool.query(
        `INSERT INTO callback_requests (client_id, call_id, language, caller_name, caller_phone, status, handled_at)
         VALUES ('c', 'cb-call', 'ja', 'Hanako', '000', 'handled', now()),
                ('c', 'cb-call', 'ja', 'Hanako', '000', 'pending', NULL)`,
      );

      const rows = await new PgCallLogRepository(pool).listByClient('c');

      expect(rows).toHaveLength(1);
    });

    test('callback: another client’s callback for the same call id is never joined', async () => {
      await log('shared-id', { status: 'needs_callback' });
      await pool.query(
        `INSERT INTO callback_requests (client_id, call_id, language, caller_name, caller_phone)
         VALUES ('other', 'shared-id', 'ja', 'Someone Else', '999')`,
      );

      const [row] = await new PgCallLogRepository(pool).listByClient('c');

      expect(row?.callback).toBeNull();
    });

    const callbackRow = (callId: string, extra = ''): Promise<unknown> =>
      pool.query(
        `INSERT INTO callback_requests (client_id, call_id, language, caller_name, caller_phone ${extra ? ', status, handled_at' : ''})
         VALUES ('c', $1, 'ja', 'Hanako', '000' ${extra})`,
        [callId],
      );

    test('needs-callback view: a callback with NO call_logs row (older than call logging, or its report never arrived) still appears and can be marked handled', async () => {
      await callbackRow('orphan');

      const rows = await new PgCallLogRepository(pool).listNeedsCallback('c');

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        callId: 'orphan',
        status: 'needs_callback',
        language: 'ja',
        callerName: 'Hanako',
        summary: null,
        durationSeconds: null,
        callback: { callerPhone: '000', status: 'pending' },
      });
      expect(rows[0]?.createdAt).toBeInstanceOf(Date);
    });

    test('needs-callback view: a callback on a call whose derived status is NOT needs_callback (booked, then asked for a callback) still appears', async () => {
      await log('booked-and-callback', { status: 'reservation_made' });
      await callbackRow('booked-and-callback');

      const rows = await new PgCallLogRepository(pool).listNeedsCallback('c');

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        status: 'reservation_made',
        callback: { status: 'pending' },
      });
    });

    test('needs-callback view: one row per callback request (two on one call both show, each with its own id), and a needs_callback call with no request shows too', async () => {
      await log('twice', { status: 'needs_callback' });
      await callbackRow('twice');
      await callbackRow('twice', ", 'handled', now()");
      await log('no-request', { status: 'needs_callback' });
      await log('plain', { status: 'resolved_by_ai' });

      const rows = await new PgCallLogRepository(pool).listNeedsCallback('c');

      expect(rows.map((row) => row.callId).sort()).toEqual(['no-request', 'twice', 'twice']);
      const ids = rows.map((row) => row.id);
      expect(new Set(ids).size).toBe(3);
      expect(rows.find((row) => row.callId === 'no-request')?.callback).toBeNull();
    });

    test('needs-callback view: scoped to the client, and capped', async () => {
      await callbackRow('a');
      await callbackRow('b');
      await pool.query(
        `INSERT INTO callback_requests (client_id, call_id, language, caller_name, caller_phone)
         VALUES ('other', 'x', 'ja', 'n', '0')`,
      );

      const repo = new PgCallLogRepository(pool);

      expect(await repo.listNeedsCallback('c')).toHaveLength(2);
      expect(await repo.listNeedsCallback('c', 1)).toHaveLength(1);
    });

    test('reservations: a booking with no patient name (made before names were collected) still lists', async () => {
      await pool.query(
        `INSERT INTO appointments
           (client_id, call_id, language, reservation_number, patient_phone, appointment_date, appointment_time)
         VALUES ('c', 'nameless', 'ja', 'R000009', '000', '2026-10-20', '10:30')`,
      );

      const [row] = await new PgCallLogRepository(pool).listReservations('c');

      expect(row).toMatchObject({ reservationNumber: 'R000009', patientName: null });
    });

    test('reservations: every appointment appears, with the booking details and the call summary', async () => {
      await log('booked', { status: 'reservation_made', summary: 'Booked a visit.' });
      await log('callback', { status: 'needs_callback' });
      await appointment('booked', 'R000001');

      const rows = await new PgCallLogRepository(pool).listReservations('c');

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        reservationNumber: 'R000001',
        appointmentDate: '2026-10-20',
        appointmentTime: '10:30',
        serviceName: 'General',
        patientName: 'ヤマダ タロウ',
        isReturningPatient: false,
        language: 'ja',
        summary: 'Booked a visit.',
      });
      expect(rows[0]?.bookedAt).toBeInstanceOf(Date);
    });

    test('reservations: an appointment with no call_logs row (made before call logging existed, or by another source) still appears', async () => {
      await appointment('no-log-row', 'R000002');

      const [row] = await new PgCallLogRepository(pool).listReservations('c');

      expect(row).toMatchObject({ reservationNumber: 'R000002', summary: null });
    });

    test('reservations: newest booking first, scoped to the client, and capped', async () => {
      await appointment('a', 'R-OLD', '2026-10-01T00:00:00Z');
      await appointment('b', 'R-NEW', '2026-10-05T00:00:00Z');
      await pool.query(
        `INSERT INTO appointments
           (client_id, call_id, language, reservation_number, patient_name, patient_phone,
            appointment_date, appointment_time)
         VALUES ('other', 'x', 'ja', 'R-OTHER', 'n', '0', '2026-10-20', '10:30')`,
      );

      const repo = new PgCallLogRepository(pool);
      const rows = await repo.listReservations('c');

      expect(rows.map((row) => row.reservationNumber)).toEqual(['R-NEW', 'R-OLD']);
      expect(await repo.listReservations('c', 1)).toHaveLength(1);
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

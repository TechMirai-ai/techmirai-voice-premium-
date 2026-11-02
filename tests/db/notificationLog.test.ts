/**
 * Needs a real Postgres (TEST_DATABASE_URL); skipped otherwise, like callLogs.test.ts.
 * Runs the repo's own migrations in a throwaway schema.
 */
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { runMigrations } from '../../src/db/migrate.js';
import { PgAppointmentRepository } from '../../src/repositories/appointmentRepository.js';
import { PgNotificationLogRepository } from '../../src/repositories/notificationLogRepository.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

/**
 * If you are here because this failed after adding a column to notification_log: STOP. The table
 * is deliberately free of personal data (no phone number, name, message text or LINE id) so it is
 * safe to log and query. Put new personal data somewhere that is access-controlled, not here.
 */
const NOTIFICATION_LOG_COLUMNS = [
  'appointment_id',
  'channel',
  'client_id',
  'created_at',
  'detail',
  'id',
  'provider_message_id',
  'recipient_ref',
  'status',
];

const CLIENT = 'sakura-seikotsuin';
const PHONE_A = '09012345678';
const PHONE_B = '08011112222';
const HOUR_MS = 60 * 60 * 1000;

describe.skipIf(!TEST_DATABASE_URL)('notification_log (real Postgres)', () => {
  const schema = `tmvp_notiflog_${Date.now()}_${Math.floor(Math.random() * 10_000)}`;
  let adminPool: pg.Pool;
  let pool: pg.Pool;
  let log: PgNotificationLogRepository;
  let appointments: PgAppointmentRepository;

  const bookFor = async (patientPhone: string, clientId: string = CLIENT) =>
    (
      await appointments.create({
        clientId,
        callId: `call-${Math.random()}`,
        language: 'ja',
        serviceId: null,
        serviceName: null,
        patientName: 'Hanako Yamada',
        patientPhone,
        isReturningPatient: false,
        appointmentDate: '2026-11-03',
        appointmentTime: '10:00',
      })
    ).id;

  const sent = (appointmentId: string, extra: { clientId?: string } = {}) =>
    log.record({
      clientId: extra.clientId ?? CLIENT,
      appointmentId,
      channel: 'sms',
      status: 'sent',
      providerMessageId: 'msg-1',
    });

  beforeAll(async () => {
    adminPool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(TEST_DATABASE_URL!);
    url.searchParams.set('options', `-c search_path=${schema},public`);
    pool = new pg.Pool({ connectionString: url.toString() });
    await runMigrations(pool);
    log = new PgNotificationLogRepository(pool);
    appointments = new PgAppointmentRepository(pool);
  });

  afterAll(async () => {
    await pool?.end();
    await adminPool?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await adminPool?.end();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM notification_log');
    await pool.query('DELETE FROM appointments');
  });

  test('has exactly the expected columns — nothing that could hold personal data', async () => {
    const { rows } = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'notification_log' ORDER BY column_name`,
      [schema],
    );

    expect(rows.map((row) => row.column_name)).toEqual(NOTIFICATION_LOG_COLUMNS);
  });

  test('stores one attempt, with optional fields left null', async () => {
    const appointmentId = await bookFor(PHONE_A);

    await log.record({ clientId: CLIENT, appointmentId, channel: 'line', status: 'skipped' });

    const { rows } = await pool.query(
      'SELECT client_id, channel, status, recipient_ref, detail, provider_message_id FROM notification_log',
    );
    expect(rows).toEqual([
      {
        client_id: CLIENT,
        channel: 'line',
        status: 'skipped',
        recipient_ref: null,
        detail: null,
        provider_message_id: null,
      },
    ]);
  });

  test('keeps the env-var name and reason code it is given', async () => {
    const appointmentId = await bookFor(PHONE_A);

    await log.record({
      clientId: CLIENT,
      appointmentId,
      channel: 'line',
      status: 'failed',
      recipientRef: 'LINE_STAFF_USER_ID',
      detail: 'http_400',
    });

    const { rows } = await pool.query('SELECT recipient_ref, detail FROM notification_log');
    expect(rows).toEqual([{ recipient_ref: 'LINE_STAFF_USER_ID', detail: 'http_400' }]);
  });

  test.each([
    ['channel', "'email'", "'sent'"],
    ['status', "'sms'", "'maybe'"],
  ])('refuses an unknown %s', async (_field, channel, status) => {
    const appointmentId = await bookFor(PHONE_A);

    await expect(
      pool.query(
        `INSERT INTO notification_log (client_id, appointment_id, channel, status)
         VALUES ($1, $2, ${channel}, ${status})`,
        [CLIENT, appointmentId],
      ),
    ).rejects.toThrow(/check constraint/);
  });

  test('refuses a row for an appointment that does not exist', async () => {
    await expect(
      pool.query(
        `INSERT INTO notification_log (client_id, appointment_id, channel, status)
         VALUES ($1, gen_random_uuid(), 'sms', 'sent')`,
        [CLIENT],
      ),
    ).rejects.toThrow(/foreign key/);
  });

  test('deleting an appointment deletes its delivery rows', async () => {
    const appointmentId = await bookFor(PHONE_A);
    await sent(appointmentId);

    await pool.query('DELETE FROM appointments WHERE id = $1', [appointmentId]);

    const { rows } = await pool.query('SELECT 1 FROM notification_log');
    expect(rows).toHaveLength(0);
  });

  describe('countSmsSentToNumber (the abuse guard)', () => {
    const since = () => new Date(Date.now() - 24 * HOUR_MS);

    test('counts only successfully sent SMS to bookings under that number', async () => {
      const first = await bookFor(PHONE_A);
      const second = await bookFor(PHONE_A);
      const third = await bookFor(PHONE_A);
      const other = await bookFor(PHONE_B);
      await sent(first);
      await sent(second);
      await log.record({
        clientId: CLIENT,
        appointmentId: third,
        channel: 'sms',
        status: 'failed',
      });
      await log.record({
        clientId: CLIENT,
        appointmentId: third,
        channel: 'sms',
        status: 'skipped',
        detail: 'rate_limited',
      });
      await log.record({ clientId: CLIENT, appointmentId: third, channel: 'line', status: 'sent' });
      await sent(other);

      expect(await log.countSmsSentToNumber(CLIENT, PHONE_A, since())).toBe(2);
      expect(await log.countSmsSentToNumber(CLIENT, PHONE_B, since())).toBe(1);
      expect(await log.countSmsSentToNumber(CLIENT, '07000000000', since())).toBe(0);
    });

    test('ignores anything older than the window', async () => {
      const appointmentId = await bookFor(PHONE_A);
      await sent(appointmentId);
      await pool.query("UPDATE notification_log SET created_at = now() - interval '25 hours'");

      expect(await log.countSmsSentToNumber(CLIENT, PHONE_A, since())).toBe(0);
    });

    test('is scoped to one client', async () => {
      const appointmentId = await bookFor(PHONE_A, 'other-client');
      await sent(appointmentId, { clientId: 'other-client' });

      expect(await log.countSmsSentToNumber(CLIENT, PHONE_A, since())).toBe(0);
      expect(await log.countSmsSentToNumber('other-client', PHONE_A, since())).toBe(1);
    });
  });
});

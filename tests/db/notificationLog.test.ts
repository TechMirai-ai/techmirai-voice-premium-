/**
 * Needs a real Postgres (TEST_DATABASE_URL); skipped otherwise, like callLogs.test.ts.
 * Runs the repo's own migrations in a throwaway schema.
 */
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { parseClientConfig } from '../../src/config/schema.js';
import { runMigrations } from '../../src/db/migrate.js';
import { ChannelBookingNotifier } from '../../src/notifications/bookingNotifier.js';
import { PgAppointmentRepository } from '../../src/repositories/appointmentRepository.js';
import { PgNotificationLogRepository } from '../../src/repositories/notificationLogRepository.js';
import { readSakuraDocument, SAKURA_ID, withChanges } from '../helpers/clientFixtures.js';

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

  const bookFor = async (
    patientPhone: string,
    clientId: string = CLIENT,
    callId: string = `call-${Math.random()}`,
  ) =>
    (
      await appointments.create({
        clientId,
        callId,
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

  describe('reserve / settle', () => {
    test('a reservation is a pending row that settle moves to its final status', async () => {
      const appointmentId = await bookFor(PHONE_A);

      const id = await log.reserve({
        clientId: CLIENT,
        appointmentId,
        channel: 'line',
        recipientRef: 'LINE_STAFF_USER_ID',
      });
      const pending = await pool.query(
        'SELECT status, detail FROM notification_log WHERE id = $1',
        [id],
      );
      await log.settle(id, { status: 'sent', providerMessageId: 'msg-9' });
      const settled = await pool.query(
        'SELECT status, detail, provider_message_id, recipient_ref FROM notification_log WHERE id = $1',
        [id],
      );

      expect(pending.rows).toEqual([{ status: 'pending', detail: null }]);
      expect(settled.rows).toEqual([
        {
          status: 'sent',
          detail: null,
          provider_message_id: 'msg-9',
          recipient_ref: 'LINE_STAFF_USER_ID',
        },
      ]);
    });

    test('settle can record a refusal with its reason code', async () => {
      const appointmentId = await bookFor(PHONE_A);
      const id = await log.reserve({ clientId: CLIENT, appointmentId, channel: 'sms' });

      await log.settle(id, { status: 'skipped', detail: 'daily_limit' });

      const { rows } = await pool.query('SELECT status, detail FROM notification_log');
      expect(rows).toEqual([{ status: 'skipped', detail: 'daily_limit' }]);
    });
  });

  describe('countReserved (the abuse guard)', () => {
    const since = () => new Date(Date.now() - 24 * HOUR_MS);
    const count = (
      channel: 'sms' | 'line',
      patientPhone?: string,
      clientId: string = CLIENT,
      callId?: string,
    ) =>
      log.countReserved({
        clientId,
        channel,
        since: since(),
        pendingSince: new Date(Date.now() - 5 * 60 * 1000),
        ...(patientPhone ? { patientPhone } : {}),
        ...(callId ? { callId } : {}),
      });

    test('counts sent and pending SMS, per number and for the whole client', async () => {
      const first = await bookFor(PHONE_A);
      const second = await bookFor(PHONE_A);
      const third = await bookFor(PHONE_A);
      const other = await bookFor(PHONE_B);
      await sent(first);
      await log.reserve({ clientId: CLIENT, appointmentId: second, channel: 'sms' }); // pending
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

      expect(await count('sms', PHONE_A)).toMatchObject({ forClient: 3, forNumber: 2 });
      expect(await count('sms', PHONE_B)).toMatchObject({ forClient: 3, forNumber: 1 });
      expect(await count('sms', '07000000000')).toMatchObject({ forClient: 3, forNumber: 0 });
      expect(await count('sms')).toMatchObject({ forClient: 3, forNumber: 0 });
    });

    test('counts per call: only appointments booked in that call, only live rows', async () => {
      const first = await bookFor(PHONE_A, CLIENT, 'call-X');
      const second = await bookFor(PHONE_B, CLIENT, 'call-X');
      const elsewhere = await bookFor(PHONE_A, CLIENT, 'call-Y');
      await sent(first);
      await log.reserve({ clientId: CLIENT, appointmentId: second, channel: 'sms' }); // pending
      await log.record({
        clientId: CLIENT,
        appointmentId: second,
        channel: 'sms',
        status: 'skipped',
        detail: 'call_limit',
      });
      await sent(elsewhere);

      expect((await count('sms', undefined, CLIENT, 'call-X')).forCall).toBe(2);
      expect((await count('sms', undefined, CLIENT, 'call-Y')).forCall).toBe(1);
      expect((await count('sms', undefined, CLIENT, 'call-none')).forCall).toBe(0);
      expect((await count('sms')).forCall).toBe(0);
      expect((await count('line', undefined, CLIENT, 'call-X')).forCall).toBe(0);
    });

    test('a pending row stops counting after the stale cutoff, a sent row never does', async () => {
      const staleAppointment = await bookFor(PHONE_A);
      const freshAppointment = await bookFor(PHONE_A);
      const oldSent = await bookFor(PHONE_A);
      const stale = await log.reserve({
        clientId: CLIENT,
        appointmentId: staleAppointment,
        channel: 'sms',
      });
      await log.reserve({ clientId: CLIENT, appointmentId: freshAppointment, channel: 'sms' });
      await sent(oldSent);
      await pool.query(
        "UPDATE notification_log SET created_at = now() - interval '10 minutes' WHERE id = $1 OR appointment_id = $2",
        [stale, oldSent],
      );

      // fresh pending + sent (10 min old, still inside the 24 h window) count; stale pending does not
      expect(await count('sms', PHONE_A)).toMatchObject({ forClient: 2, forNumber: 2 });
    });

    test('a stale pending row still falls outside once it is older than the window', async () => {
      const appointmentId = await bookFor(PHONE_A);
      await log.reserve({ clientId: CLIENT, appointmentId, channel: 'sms' });
      await pool.query("UPDATE notification_log SET created_at = now() - interval '25 hours'");

      expect(await count('sms', PHONE_A)).toMatchObject({ forClient: 0, forNumber: 0 });
    });

    test('counts each channel separately', async () => {
      const appointmentId = await bookFor(PHONE_A);
      await sent(appointmentId);
      await log.record({ clientId: CLIENT, appointmentId, channel: 'line', status: 'sent' });
      await log.record({ clientId: CLIENT, appointmentId, channel: 'line', status: 'sent' });

      expect((await count('sms')).forClient).toBe(1);
      expect((await count('line')).forClient).toBe(2);
    });

    test('ignores anything older than the window', async () => {
      const appointmentId = await bookFor(PHONE_A);
      await sent(appointmentId);
      await pool.query("UPDATE notification_log SET created_at = now() - interval '25 hours'");

      expect(await count('sms', PHONE_A)).toMatchObject({ forClient: 0, forNumber: 0 });
    });

    test('is scoped to one client', async () => {
      const appointmentId = await bookFor(PHONE_A, 'other-client');
      await sent(appointmentId, { clientId: 'other-client' });

      expect(await count('sms', PHONE_A)).toMatchObject({ forClient: 0, forNumber: 0 });
      expect(await count('sms', PHONE_A, 'other-client')).toMatchObject({
        forClient: 1,
        forNumber: 1,
      });
    });
  });

  describe('the notifier against real Postgres', () => {
    const credentials: Record<string, string> = {
      TELNYX_API_KEY: 'test-telnyx-key',
      LINE_CHANNEL_ACCESS_TOKEN: 'test-line-token',
      LINE_STAFF_USER_ID: `U${'a'.repeat(32)}`,
    };

    /** Fake providers that take a moment to answer — exactly when the old guard was blind. */
    const buildNotifier = (document: Record<string, any>) => {
      const config = parseClientConfig(document, SAKURA_ID).config;
      const delivered = { sms: 0, line: 0 };
      const pause = () => new Promise((resolve) => setTimeout(resolve, 25));
      const notifier = new ChannelBookingNotifier({
        loadConfig: () => config,
        credential: (name) => credentials[name],
        sms: {
          send: async () => {
            await pause();
            delivered.sms += 1;
            return { messageId: 'sms-x' };
          },
        },
        line: {
          push: async () => {
            await pause();
            delivered.line += 1;
            return {};
          },
        },
        log,
      });
      return { notifier, delivered };
    };

    /** Books one appointment per phone, each in its own call, and returns what the notifier needs. */
    const bookCalls = (phones: string[]) =>
      Promise.all(
        phones.map(async (phone, index) => {
          const callId = `call-${index}`;
          return { id: await bookFor(phone, CLIENT, callId), callId, phone };
        }),
      );

    const bookingFor = (appointmentId: string, callerPhone: string, callId: string) => ({
      clientId: SAKURA_ID,
      appointmentId,
      callId,
      reservationNumber: 'R123456',
      language: 'ja',
      patientName: 'Hanako Yamada',
      serviceName: null,
      date: '2026-11-03',
      time: '10:00',
      callerPhone,
    });

    test('simultaneous bookings for one number cannot exceed the per-number cap', async () => {
      const { notifier, delivered } = buildNotifier(readSakuraDocument());
      const calls = await bookCalls(Array.from({ length: 12 }, () => PHONE_A));

      await Promise.all(
        calls.map(({ id, callId }) => notifier.notifyBooked(bookingFor(id, PHONE_A, callId))),
      );

      expect(delivered.sms).toBeLessThanOrEqual(3); // sms.maxPerRecipientPerDay
      const { rows } = await pool.query<{ status: string }>(
        "SELECT status FROM notification_log WHERE channel = 'sms'",
      );
      expect(rows.filter((row) => row.status === 'sent').length).toBeLessThanOrEqual(3);
      expect(rows.filter((row) => row.status === 'pending')).toHaveLength(0);
    });

    test('simultaneous bookings from many numbers cannot exceed the client-wide caps', async () => {
      const { notifier, delivered } = buildNotifier(
        withChanges(readSakuraDocument(), (draft) => {
          draft.notifications.sms.maxPerDay = 4;
          draft.notifications.line.maxPerDay = 3;
        }),
      );
      const phones = Array.from({ length: 12 }, (_, i) => `090${String(10_000_000 + i)}`);
      const calls = await bookCalls(phones);

      await Promise.all(
        calls.map(({ id, callId, phone }) => notifier.notifyBooked(bookingFor(id, phone, callId))),
      );

      expect(delivered.sms).toBeLessThanOrEqual(4);
      expect(delivered.line).toBeLessThanOrEqual(3);
    });

    test('bookings one after another stop exactly at the cap', async () => {
      const { notifier, delivered } = buildNotifier(readSakuraDocument());

      for (let index = 0; index < 5; index += 1) {
        const id = await bookFor(PHONE_A, CLIENT, `call-${index}`);
        await notifier.notifyBooked(bookingFor(id, PHONE_A, `call-${index}`));
      }

      expect(delivered.sms).toBe(3);
    });

    test('simultaneous bookings in ONE call send at most one SMS and one LINE alert', async () => {
      const { notifier, delivered } = buildNotifier(readSakuraDocument());
      const ids = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          bookFor(`090${String(20_000_000 + i)}`, CLIENT, 'call-one'),
        ),
      );

      await Promise.all(
        ids.map((id, i) =>
          notifier.notifyBooked(bookingFor(id, `090${String(20_000_000 + i)}`, 'call-one')),
        ),
      );

      expect(delivered.sms).toBeLessThanOrEqual(1);
      expect(delivered.line).toBeLessThanOrEqual(1);
    });

    test('a second booking in the same call, afterwards, is refused as call_limit', async () => {
      const { notifier, delivered } = buildNotifier(readSakuraDocument());
      const first = await bookFor(PHONE_A, CLIENT, 'call-one');
      const second = await bookFor(PHONE_B, CLIENT, 'call-one');

      await notifier.notifyBooked(bookingFor(first, PHONE_A, 'call-one'));
      await notifier.notifyBooked(bookingFor(second, PHONE_B, 'call-one'));

      expect(delivered).toEqual({ sms: 1, line: 1 });
      const { rows } = await pool.query(
        `SELECT channel, status, detail FROM notification_log
          WHERE appointment_id = $1 ORDER BY channel`,
        [second],
      );
      expect(rows).toEqual([
        { channel: 'line', status: 'skipped', detail: 'call_limit' },
        { channel: 'sms', status: 'skipped', detail: 'call_limit' },
      ]);
    });

    test('a booking in another call is unaffected by the first call having been used', async () => {
      const { notifier, delivered } = buildNotifier(readSakuraDocument());
      const first = await bookFor(PHONE_A, CLIENT, 'call-one');
      const other = await bookFor(PHONE_B, CLIENT, 'call-two');

      await notifier.notifyBooked(bookingFor(first, PHONE_A, 'call-one'));
      await notifier.notifyBooked(bookingFor(other, PHONE_B, 'call-two'));

      expect(delivered).toEqual({ sms: 2, line: 2 });
    });
  });
});

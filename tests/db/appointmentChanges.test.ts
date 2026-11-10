/**
 * VP-25: soft-cancel, reschedule, the one-live-booking-per-slot index and the one-change-per-call
 * rule, against a real Postgres (TEST_DATABASE_URL; skipped otherwise). Runs the repo's own
 * migrations in a throwaway schema.
 */
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { runMigrations } from '../../src/db/migrate.js';
import {
  ChangeLimitError,
  PgAppointmentRepository,
  SlotTakenError,
  type NewAppointment,
} from '../../src/repositories/appointmentRepository.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

const CLIENT = 'c';
const PHONE = '09012345678';
const OTHER_PHONE = '08099998888';
/** "Now" for every test, clinic-local. */
const NOW = { date: '2026-11-10', time: '12:00' };

function appointment(overrides: Partial<NewAppointment> = {}): NewAppointment {
  return {
    clientId: CLIENT,
    callId: 'booking-call',
    language: 'ja',
    serviceId: null,
    serviceName: 'General Consultation',
    patientName: 'Hanako',
    patientPhone: PHONE,
    isReturningPatient: false,
    appointmentDate: '2026-11-12',
    appointmentTime: '10:00',
    ...overrides,
  };
}

describe.skipIf(!TEST_DATABASE_URL)('VP-25 appointment changes (real Postgres)', () => {
  const schema = `tmvp_changes_${Date.now()}_${Math.floor(Math.random() * 10_000)}`;
  let adminPool: pg.Pool;
  let pool: pg.Pool;
  let repo: PgAppointmentRepository;

  beforeAll(async () => {
    adminPool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(TEST_DATABASE_URL!);
    url.searchParams.set('options', `-c search_path=${schema},public`);
    pool = new pg.Pool({ connectionString: url.toString() });
    await runMigrations(pool);
    repo = new PgAppointmentRepository(pool);
  });

  afterAll(async () => {
    await pool?.end();
    await adminPool?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await adminPool?.end();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM notification_log');
    await pool.query('DELETE FROM appointment_changes');
    await pool.query('DELETE FROM appointments');
    await pool.query('DELETE FROM reservation_booked_slots');
  });

  describe('one live booking per slot', () => {
    test('a second booking for the same slot is refused', async () => {
      await repo.create(appointment());

      await expect(repo.create(appointment({ patientPhone: OTHER_PHONE }))).rejects.toBeInstanceOf(
        SlotTakenError,
      );
    });

    test('the same time on another date, or for another client, is fine', async () => {
      await repo.create(appointment());

      await repo.create(appointment({ appointmentDate: '2026-11-13' }));
      await repo.create(appointment({ clientId: 'other-client' }));
    });

    test('a cancelled booking no longer blocks its slot', async () => {
      const booked = await repo.create(appointment());
      await repo.cancel({
        clientId: CLIENT,
        appointmentId: booked.id,
        phone: PHONE,
        callId: 'change-call',
        now: NOW,
      });

      await repo.create(appointment({ patientPhone: OTHER_PHONE }));
    });
  });

  describe('listTakenTimes', () => {
    test('does not count a cancelled booking', async () => {
      const kept = await repo.create(appointment({ appointmentTime: '09:00' }));
      const cancelled = await repo.create(appointment({ appointmentTime: '10:00' }));
      await repo.cancel({
        clientId: CLIENT,
        appointmentId: cancelled.id,
        phone: PHONE,
        callId: 'change-call',
        now: NOW,
      });

      const taken = await repo.listTakenTimes(CLIENT, '2026-11-12');

      expect(taken.has(kept.appointmentTime)).toBe(true);
      expect(taken.has('10:00')).toBe(false);
    });
  });

  describe('listUpcomingForPhone', () => {
    test('returns only this caller’s active, upcoming bookings, soonest first', async () => {
      await repo.create(appointment({ appointmentDate: '2026-11-14', appointmentTime: '09:30' }));
      await repo.create(appointment({ appointmentDate: '2026-11-12', appointmentTime: '15:00' }));
      await repo.create(appointment({ appointmentDate: '2026-11-11', appointmentTime: '09:00' }));
      await repo.create(appointment({ patientPhone: OTHER_PHONE, appointmentTime: '11:00' }));
      await repo.create(appointment({ clientId: 'other-client', appointmentTime: '11:30' }));
      // In the past: an earlier day, and earlier today.
      await repo.create(appointment({ appointmentDate: '2026-11-09', appointmentTime: '09:00' }));
      await repo.create(appointment({ appointmentDate: '2026-11-10', appointmentTime: '11:30' }));
      const cancelled = await repo.create(
        appointment({ appointmentDate: '2026-11-15', appointmentTime: '09:00' }),
      );
      await repo.cancel({
        clientId: CLIENT,
        appointmentId: cancelled.id,
        phone: PHONE,
        callId: 'change-call',
        now: NOW,
      });

      const found = await repo.listUpcomingForPhone(CLIENT, PHONE, NOW, 5);

      expect(found.map((entry) => `${entry.appointmentDate} ${entry.appointmentTime}`)).toEqual([
        '2026-11-11 09:00',
        '2026-11-12 15:00',
        '2026-11-14 09:30',
      ]);
      expect(found[0]).toMatchObject({ serviceName: 'General Consultation' });
    });

    test('honours the limit', async () => {
      for (const time of ['09:00', '09:30', '10:00']) {
        await repo.create(appointment({ appointmentTime: time }));
      }

      expect(await repo.listUpcomingForPhone(CLIENT, PHONE, NOW, 2)).toHaveLength(2);
    });
  });

  describe('cancel', () => {
    test('soft-cancels: the row stays, its status changes, and the change is recorded', async () => {
      const booked = await repo.create(appointment());

      const changed = await repo.cancel({
        clientId: CLIENT,
        appointmentId: booked.id,
        phone: PHONE,
        callId: 'change-call',
        now: NOW,
      });

      expect(changed).toMatchObject({
        id: booked.id,
        reservationNumber: booked.reservationNumber,
        oldDate: '2026-11-12',
        oldTime: '10:00',
      });
      const row = await pool.query('SELECT status FROM appointments WHERE id = $1', [booked.id]);
      expect(row.rows).toEqual([{ status: 'cancelled' }]);
      const log = await pool.query(
        'SELECT call_id, action, old_date, old_time, new_date, new_time FROM appointment_changes',
      );
      expect(log.rows).toEqual([
        {
          call_id: 'change-call',
          action: 'cancelled',
          old_date: '2026-11-12',
          old_time: '10:00',
          new_date: null,
          new_time: null,
        },
      ]);
    });

    test.each([
      ['another caller’s number', { phone: OTHER_PHONE }],
      ['another client', { clientId: 'other-client' }],
    ])('does nothing for %s', async (_label, override) => {
      const booked = await repo.create(appointment());

      const changed = await repo.cancel({
        clientId: CLIENT,
        appointmentId: booked.id,
        phone: PHONE,
        callId: 'change-call',
        now: NOW,
        ...override,
      });

      expect(changed).toBeUndefined();
      const row = await pool.query('SELECT status FROM appointments WHERE id = $1', [booked.id]);
      expect(row.rows).toEqual([{ status: 'active' }]);
      expect((await pool.query('SELECT 1 FROM appointment_changes')).rows).toHaveLength(0);
    });

    test('does nothing for an appointment that is already cancelled or in the past', async () => {
      const past = await repo.create(
        appointment({ appointmentDate: '2026-11-10', appointmentTime: '11:30' }),
      );
      const request = { clientId: CLIENT, phone: PHONE, callId: 'change-call', now: NOW };

      expect(await repo.cancel({ ...request, appointmentId: past.id })).toBeUndefined();

      const booked = await repo.create(appointment());
      await repo.cancel({ ...request, appointmentId: booked.id });
      expect(
        await repo.cancel({ ...request, appointmentId: booked.id, callId: 'later-call' }),
      ).toBeUndefined();
    });

    test('a second change in the same call is refused and changes nothing', async () => {
      const first = await repo.create(appointment({ appointmentTime: '09:00' }));
      const second = await repo.create(appointment({ appointmentTime: '10:00' }));
      const request = { clientId: CLIENT, phone: PHONE, callId: 'change-call', now: NOW };

      await repo.cancel({ ...request, appointmentId: first.id });
      await expect(repo.cancel({ ...request, appointmentId: second.id })).rejects.toBeInstanceOf(
        ChangeLimitError,
      );

      const row = await pool.query('SELECT status FROM appointments WHERE id = $1', [second.id]);
      expect(row.rows).toEqual([{ status: 'active' }]);
    });
  });

  describe('concurrency and quota', () => {
    const request = { clientId: CLIENT, phone: PHONE, callId: 'change-call', now: NOW };

    test('two simultaneous cancels of one booking: exactly one succeeds, one audit row', async () => {
      const booked = await repo.create(appointment());

      const results = await Promise.allSettled([
        repo.cancel({ ...request, appointmentId: booked.id, callId: 'call-a' }),
        repo.cancel({ ...request, appointmentId: booked.id, callId: 'call-b' }),
      ]);

      const changed = results.filter(
        (result) => result.status === 'fulfilled' && result.value !== undefined,
      );
      expect(changed).toHaveLength(1);
      expect((await pool.query('SELECT 1 FROM appointment_changes')).rows).toHaveLength(1);
    });

    test('two simultaneous moves onto one slot: exactly one wins, the other is told the slot is taken', async () => {
      const first = await repo.create(appointment({ appointmentTime: '09:00' }));
      const second = await repo.create(appointment({ appointmentTime: '09:30' }));
      const move = (id: string, callId: string) =>
        repo.reschedule({
          ...request,
          appointmentId: id,
          callId,
          newDate: '2026-11-13',
          newTime: '14:30',
        });

      const results = await Promise.allSettled([
        move(first.id, 'call-a'),
        move(second.id, 'call-b'),
      ]);

      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const refused = results.find((result) => result.status === 'rejected');
      expect(refused).toMatchObject({ reason: expect.any(SlotTakenError) });
    });

    test('a change that matches nothing does not use up the call’s one change', async () => {
      const booked = await repo.create(appointment());

      expect(
        await repo.cancel({
          ...request,
          appointmentId: '11111111-1111-4111-8111-111111111111',
        }),
      ).toBeUndefined();
      const changed = await repo.cancel({ ...request, appointmentId: booked.id });

      expect(changed).toBeDefined();
    });

    test('the same call id in two different clients is allowed', async () => {
      const mine = await repo.create(appointment());
      const theirs = await repo.create(appointment({ clientId: 'other-client' }));

      await repo.cancel({ ...request, appointmentId: mine.id });
      const other = await repo.cancel({
        ...request,
        clientId: 'other-client',
        appointmentId: theirs.id,
      });

      expect(other).toBeDefined();
    });

    test('findChangeInCall returns what this call did, only for the caller’s own booking', async () => {
      const booked = await repo.create(appointment());
      await repo.reschedule({
        ...request,
        appointmentId: booked.id,
        newDate: '2026-11-13',
        newTime: '14:30',
      });

      const found = await repo.findChangeInCall(CLIENT, 'change-call', booked.id, PHONE);

      expect(found).toMatchObject({
        oldDate: '2026-11-12',
        oldTime: '10:00',
        newDate: '2026-11-13',
        newTime: '14:30',
      });
      expect(await repo.findChangeInCall(CLIENT, 'another-call', booked.id, PHONE)).toBeUndefined();
      expect(
        await repo.findChangeInCall(CLIENT, 'change-call', booked.id, OTHER_PHONE),
      ).toBeUndefined();
      expect(
        await repo.findChangeInCall('other-client', 'change-call', booked.id, PHONE),
      ).toBeUndefined();
    });
  });

  describe('reschedule', () => {
    const request = { clientId: CLIENT, phone: PHONE, callId: 'change-call', now: NOW };

    test('moves the booking, keeps its reservation number and records where it came from', async () => {
      const booked = await repo.create(appointment());

      const changed = await repo.reschedule({
        ...request,
        appointmentId: booked.id,
        newDate: '2026-11-13',
        newTime: '14:30',
      });

      expect(changed).toMatchObject({
        reservationNumber: booked.reservationNumber,
        oldDate: '2026-11-12',
        oldTime: '10:00',
        newDate: '2026-11-13',
        newTime: '14:30',
      });
      const row = await pool.query(
        'SELECT status, appointment_date, appointment_time FROM appointments WHERE id = $1',
        [booked.id],
      );
      expect(row.rows).toEqual([
        { status: 'active', appointment_date: '2026-11-13', appointment_time: '14:30' },
      ]);
      // Updated in place: no duplicate booking is created.
      expect((await pool.query('SELECT 1 FROM appointments')).rows).toHaveLength(1);
      const log = await pool.query('SELECT action, old_time, new_time FROM appointment_changes');
      expect(log.rows).toEqual([{ action: 'rescheduled', old_time: '10:00', new_time: '14:30' }]);
    });

    test('the freed slot can be booked by someone else afterwards', async () => {
      const booked = await repo.create(appointment());
      await repo.reschedule({
        ...request,
        appointmentId: booked.id,
        newDate: '2026-11-13',
        newTime: '14:30',
      });

      await repo.create(appointment({ patientPhone: OTHER_PHONE }));
    });

    test('moving onto a slot someone else holds is refused and changes nothing', async () => {
      const booked = await repo.create(appointment());
      await repo.create(
        appointment({
          patientPhone: OTHER_PHONE,
          appointmentDate: '2026-11-13',
          appointmentTime: '14:30',
        }),
      );

      await expect(
        repo.reschedule({
          ...request,
          appointmentId: booked.id,
          newDate: '2026-11-13',
          newTime: '14:30',
        }),
      ).rejects.toBeInstanceOf(SlotTakenError);

      const row = await pool.query(
        'SELECT appointment_date, appointment_time FROM appointments WHERE id = $1',
        [booked.id],
      );
      expect(row.rows).toEqual([{ appointment_date: '2026-11-12', appointment_time: '10:00' }]);
      expect((await pool.query('SELECT 1 FROM appointment_changes')).rows).toHaveLength(0);
    });

    test('does nothing for another caller’s booking', async () => {
      const booked = await repo.create(appointment());

      const changed = await repo.reschedule({
        ...request,
        phone: OTHER_PHONE,
        appointmentId: booked.id,
        newDate: '2026-11-13',
        newTime: '14:30',
      });

      expect(changed).toBeUndefined();
    });

    test('a second change in the same call is refused and changes nothing', async () => {
      const booked = await repo.create(appointment());
      const other = await repo.create(appointment({ appointmentTime: '11:00' }));
      await repo.cancel({ ...request, appointmentId: other.id });

      await expect(
        repo.reschedule({
          ...request,
          appointmentId: booked.id,
          newDate: '2026-11-13',
          newTime: '14:30',
        }),
      ).rejects.toBeInstanceOf(ChangeLimitError);

      const row = await pool.query('SELECT appointment_time FROM appointments WHERE id = $1', [
        booked.id,
      ]);
      expect(row.rows).toEqual([{ appointment_time: '10:00' }]);
    });
  });
});

/**
 * VP-26: the "last visit" read path over the appointments table, against a real Postgres
 * (TEST_DATABASE_URL; skipped otherwise). Runs the repo's own migrations in a throwaway schema.
 */
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { runMigrations } from '../../src/db/migrate.js';
import {
  PgAppointmentRepository,
  type NewAppointment,
} from '../../src/repositories/appointmentRepository.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

const CLIENT = 'c';
const PHONE = '09012345678';
const OTHER_PHONE = '08099998888';
/** "Now" for every test, clinic-local. */
const NOW = { date: '2026-11-10', time: '12:00' };
/** The oldest visit date that still counts (365 days before NOW). */
const OLDEST = '2025-11-10';

function appointment(overrides: Partial<NewAppointment> = {}): NewAppointment {
  return {
    clientId: CLIENT,
    callId: `call-${Math.random()}`,
    language: 'ja',
    serviceId: null,
    serviceName: 'General Consultation',
    patientName: 'Hanako',
    patientPhone: PHONE,
    isReturningPatient: false,
    appointmentDate: '2026-10-01',
    appointmentTime: '10:00',
    ...overrides,
  };
}

describe.skipIf(!TEST_DATABASE_URL)('VP-26 findLastVisit (real Postgres)', () => {
  const schema = `tmvp_visit_${Date.now()}_${Math.floor(Math.random() * 10_000)}`;
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
    await pool.query('DELETE FROM appointment_changes');
    await pool.query('DELETE FROM appointments');
  });

  test('returns the most recent past visit — date and service only', async () => {
    await repo.create(appointment({ appointmentDate: '2026-08-01', serviceName: 'Older' }));
    await repo.create(appointment({ appointmentDate: '2026-10-01', serviceName: 'Newer' }));

    const visit = await repo.findLastVisit(CLIENT, PHONE, NOW, OLDEST);

    expect(visit).toEqual({ appointmentDate: '2026-10-01', serviceId: null, serviceName: 'Newer' });
  });

  test('the later time wins when two past visits share a date', async () => {
    await repo.create(
      appointment({ appointmentDate: '2026-10-01', appointmentTime: '09:00', serviceName: 'AM' }),
    );
    await repo.create(
      appointment({ appointmentDate: '2026-10-01', appointmentTime: '15:00', serviceName: 'PM' }),
    );

    expect((await repo.findLastVisit(CLIENT, PHONE, NOW, OLDEST))?.serviceName).toBe('PM');
  });

  test('a booking that has not started yet is not a visit; one that started earlier today is', async () => {
    await repo.create(appointment({ appointmentDate: '2026-11-10', appointmentTime: '12:30' }));
    expect(await repo.findLastVisit(CLIENT, PHONE, NOW, OLDEST)).toBeUndefined();

    await repo.create(
      appointment({
        appointmentDate: '2026-11-10',
        appointmentTime: '09:00',
        serviceName: 'Today',
      }),
    );
    expect((await repo.findLastVisit(CLIENT, PHONE, NOW, OLDEST))?.serviceName).toBe('Today');
  });

  test('the "has started" boundary is exactly now: 12:00 is a visit, 12:01 is not (and never both with "upcoming")', async () => {
    await repo.create(appointment({ appointmentDate: '2026-11-10', appointmentTime: '12:01' }));
    expect(await repo.findLastVisit(CLIENT, PHONE, NOW, OLDEST)).toBeUndefined();

    await repo.create(
      appointment({ appointmentDate: '2026-11-10', appointmentTime: '12:00', serviceName: 'Now' }),
    );
    expect((await repo.findLastVisit(CLIENT, PHONE, NOW, OLDEST))?.serviceName).toBe('Now');
    // The same booking is not also an upcoming one (VP-25's complement).
    const upcoming = await repo.listUpcomingForPhone(CLIENT, PHONE, NOW, 5);
    expect(upcoming.map((entry) => entry.appointmentTime)).toEqual(['12:01']);
  });

  test('a cancelled booking was never a visit', async () => {
    const booked = await repo.create(appointment({ appointmentDate: '2026-10-01' }));
    await pool.query(`UPDATE appointments SET status = 'cancelled' WHERE id = $1`, [booked.id]);

    expect(await repo.findLastVisit(CLIENT, PHONE, NOW, OLDEST)).toBeUndefined();
  });

  test('another number and another client never match', async () => {
    await repo.create(appointment({ patientPhone: OTHER_PHONE }));
    await repo.create(appointment({ clientId: 'other-client' }));

    expect(await repo.findLastVisit(CLIENT, PHONE, NOW, OLDEST)).toBeUndefined();
  });

  test('a visit older than the cutoff is not returned; one exactly on it is', async () => {
    await repo.create(appointment({ appointmentDate: '2025-11-09' }));
    expect(await repo.findLastVisit(CLIENT, PHONE, NOW, OLDEST)).toBeUndefined();

    await repo.create(appointment({ appointmentDate: OLDEST, serviceName: 'On the line' }));
    expect((await repo.findLastVisit(CLIENT, PHONE, NOW, OLDEST))?.serviceName).toBe('On the line');
  });

  test('a returning-patient booking has no service; the stored service id is returned when present', async () => {
    await pool.query(
      `INSERT INTO reservation_services (id, client_id, name_ja, name_en, duration_minutes)
       VALUES ('svc-1', $1, '一般施術', 'General', 30)`,
      [CLIENT],
    );
    await repo.create(appointment({ serviceId: 'svc-1', serviceName: '一般施術' }));
    expect((await repo.findLastVisit(CLIENT, PHONE, NOW, OLDEST))?.serviceId).toBe('svc-1');

    await pool.query('DELETE FROM appointments');
    await repo.create(appointment({ serviceId: null, serviceName: null }));
    expect(await repo.findLastVisit(CLIENT, PHONE, NOW, OLDEST)).toEqual({
      appointmentDate: '2026-10-01',
      serviceId: null,
      serviceName: null,
    });
  });
});

/**
 * Needs a real Postgres (TEST_DATABASE_URL); skipped otherwise, like callTables.test.ts.
 * Runs the repo's own migrations in a throwaway schema.
 */
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { runMigrations } from '../../src/db/migrate.js';
import { PgAppointmentRepository } from '../../src/repositories/appointmentRepository.js';
import { PgReservationPatientRepository } from '../../src/repositories/reservationPatientRepository.js';
import { PgReservationServiceRepository } from '../../src/repositories/reservationServiceRepository.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DATABASE_URL)('VP-8 reservation tables (real Postgres)', () => {
  const schema = `tmvp_reservations_${Date.now()}_${Math.floor(Math.random() * 10_000)}`;
  let adminPool: pg.Pool;
  let pool: pg.Pool;

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
    await pool.query('DELETE FROM appointments');
    await pool.query('DELETE FROM reservation_booked_slots');
    await pool.query('DELETE FROM reservation_demo_patients');
    await pool.query('DELETE FROM reservation_services');
  });

  describe('reservation_services', () => {
    test('the repository returns services in sort order, localized', async () => {
      await pool.query(
        `INSERT INTO reservation_services (id, client_id, name_ja, name_en, duration_minutes, sort_order)
         VALUES ('follow-up', 'c', 'フォローアップ', 'Follow-up', 20, 2),
                ('general-consultation', 'c', '一般施術', 'General Consultation', 30, 1)`,
      );

      const repo = new PgReservationServiceRepository(pool);
      const services = await repo.listByClient('c');

      expect(services).toEqual([
        {
          id: 'general-consultation',
          name: { ja: '一般施術', en: 'General Consultation' },
          durationMinutes: 30,
        },
        { id: 'follow-up', name: { ja: 'フォローアップ', en: 'Follow-up' }, durationMinutes: 20 },
      ]);
    });

    test('is scoped by client_id', async () => {
      await pool.query(
        `INSERT INTO reservation_services (id, client_id, name_ja, name_en, duration_minutes)
         VALUES ('x', 'other-clinic', 'X', 'X', 30)`,
      );

      expect(await new PgReservationServiceRepository(pool).listByClient('c')).toEqual([]);
    });

    test('refuses a non-positive duration', async () => {
      await expect(
        pool.query(
          `INSERT INTO reservation_services (id, client_id, name_ja, name_en, duration_minutes)
           VALUES ('x', 'c', 'X', 'X', 0)`,
        ),
      ).rejects.toThrow(/check constraint/);
    });
  });

  describe('reservation_demo_patients', () => {
    test('findByPhone matches by (client_id, phone) exactly', async () => {
      await pool.query(
        `INSERT INTO reservation_demo_patients (client_id, name, phone) VALUES ('c', 'ヤマダ タロウ', '09011112222')`,
      );

      const repo = new PgReservationPatientRepository(pool);
      expect(await repo.findByPhone('c', '09011112222')).toEqual({
        name: 'ヤマダ タロウ',
        phone: '09011112222',
      });
      expect(await repo.findByPhone('c', '09099998888')).toBeUndefined();
      expect(await repo.findByPhone('other-clinic', '09011112222')).toBeUndefined();
    });

    test('refuses a duplicate phone within one client', async () => {
      await pool.query(
        `INSERT INTO reservation_demo_patients (client_id, name, phone) VALUES ('c', 'A', '090')`,
      );
      await expect(
        pool.query(
          `INSERT INTO reservation_demo_patients (client_id, name, phone) VALUES ('c', 'B', '090')`,
        ),
      ).rejects.toThrow(/duplicate key/);
    });
  });

  describe('appointments', () => {
    test('listTakenTimes combines pre-seeded booked slots and real appointments for one date', async () => {
      await pool.query(
        `INSERT INTO reservation_booked_slots (client_id, slot_date, slot_time) VALUES ('c', '2026-10-05', '10:00')`,
      );
      const repo = new PgAppointmentRepository(pool);
      await repo.create({
        clientId: 'c',
        callId: 'call-1',
        language: 'ja',
        serviceId: null,
        serviceName: null,
        patientName: 'A',
        patientPhone: '09000000000',
        patientEmail: null,
        isReturningPatient: false,
        appointmentDate: '2026-10-05',
        appointmentTime: '11:00',
      });

      const taken = await repo.listTakenTimes('c', '2026-10-05');
      expect(taken).toEqual(new Set(['10:00', '11:00']));
      expect(await repo.listTakenTimes('c', '2026-10-06')).toEqual(new Set());
    });

    test('create generates a reservation number and returns the saved row', async () => {
      const repo = new PgAppointmentRepository(pool);

      const booked = await repo.create({
        clientId: 'c',
        callId: 'call-2',
        language: 'en',
        serviceId: null,
        serviceName: null,
        patientName: 'Hanako Yamada',
        patientPhone: '09012345678',
        patientEmail: 'hanako@example.com',
        isReturningPatient: false,
        appointmentDate: '2026-10-05',
        appointmentTime: '14:00',
      });

      expect(booked.reservationNumber).toMatch(/^R\d{6}$/);
      const { rows } = await pool.query('SELECT * FROM appointments WHERE id = $1', [booked.id]);
      expect(rows[0]).toMatchObject({
        client_id: 'c',
        patient_name: 'Hanako Yamada',
        patient_phone: '09012345678',
        patient_email: 'hanako@example.com',
        appointment_date: '2026-10-05',
        appointment_time: '14:00',
      });
    });

    test('service_id references reservation_services and can be null for a returning patient', async () => {
      await pool.query(
        `INSERT INTO reservation_services (id, client_id, name_ja, name_en, duration_minutes)
         VALUES ('general-consultation', 'c', '一般施術', 'General Consultation', 30)`,
      );
      const repo = new PgAppointmentRepository(pool);

      const booked = await repo.create({
        clientId: 'c',
        callId: 'call-3',
        language: 'ja',
        serviceId: 'general-consultation',
        serviceName: 'General Consultation',
        patientName: 'A',
        patientPhone: '09000000000',
        patientEmail: null,
        isReturningPatient: true,
        appointmentDate: '2026-10-05',
        appointmentTime: '09:00',
      });

      const { rows } = await pool.query(
        'SELECT service_id, is_returning_patient FROM appointments WHERE id = $1',
        [booked.id],
      );
      expect(rows[0]).toEqual({ service_id: 'general-consultation', is_returning_patient: true });
    });

    test('reservation_number is unique per client', async () => {
      const repo = new PgAppointmentRepository(pool);
      const booked = await repo.create({
        clientId: 'c',
        callId: 'call-4',
        language: 'ja',
        serviceId: null,
        serviceName: null,
        patientName: 'A',
        patientPhone: '09000000000',
        patientEmail: null,
        isReturningPatient: false,
        appointmentDate: '2026-10-05',
        appointmentTime: '09:00',
      });

      await expect(
        pool.query(
          `INSERT INTO appointments
             (client_id, call_id, language, reservation_number, patient_name, patient_phone,
              is_returning_patient, appointment_date, appointment_time)
           VALUES ('c', 'call-5', 'ja', $1, 'B', '09011111111', false, '2026-10-06', '10:00')`,
          [booked.reservationNumber],
        ),
      ).rejects.toThrow(/duplicate key/);
    });
  });
});

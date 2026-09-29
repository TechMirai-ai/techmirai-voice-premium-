/**
 * Completed demo bookings (VP-8). Also answers "what times are already taken
 * on this date" — the fake pre-seeded `reservation_booked_slots` plus every
 * real appointment already booked this demo — which `checkAvailability`
 * (src/reservation/availability.ts) treats as one combined taken-set.
 */
import type { Queryable } from '../db/pool.js';
import { generateReservationNumber } from '../reservation/reservationNumber.js';

export interface NewAppointment {
  clientId: string;
  callId: string;
  language: string;
  /** Null for a returning-patient booking, which skips service selection (work order §3). */
  serviceId: string | null;
  serviceName: string | null;
  /** Digits only — see src/lib/phone.ts. */
  patientPhone: string;
  isReturningPatient: boolean;
  appointmentDate: string; // YYYY-MM-DD
  appointmentTime: string; // HH:MM, 24-hour
}

export interface BookedAppointment extends NewAppointment {
  id: string;
  reservationNumber: string;
  createdAt: Date;
}

export interface AppointmentRepository {
  /** Every time already spoken for on `date` — fake pre-seeded slots plus real demo bookings. */
  listTakenTimes(clientId: string, date: string): Promise<Set<string>>;
  create(appointment: NewAppointment): Promise<BookedAppointment>;
}

const UNIQUE_VIOLATION = '23505';
/** A collision is astronomically unlikely (1 in a million per attempt) — this bounds a retry loop, not a real risk. */
const MAX_RESERVATION_NUMBER_ATTEMPTS = 5;

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === UNIQUE_VIOLATION
  );
}

interface BookedSlotRow {
  slot_time: string;
}

interface AppointmentTimeRow {
  appointment_time: string;
}

interface AppointmentRow {
  id: string;
  created_at: Date;
}

export class PgAppointmentRepository implements AppointmentRepository {
  constructor(private readonly db: Queryable) {}

  async listTakenTimes(clientId: string, date: string): Promise<Set<string>> {
    const [booked, appointments] = await Promise.all([
      this.db.query(
        `SELECT slot_time FROM reservation_booked_slots WHERE client_id = $1 AND slot_date = $2`,
        [clientId, date],
      ),
      this.db.query(
        `SELECT appointment_time FROM appointments WHERE client_id = $1 AND appointment_date = $2`,
        [clientId, date],
      ),
    ]);

    const times = [
      ...(booked.rows as BookedSlotRow[]).map((row) => row.slot_time),
      ...(appointments.rows as AppointmentTimeRow[]).map((row) => row.appointment_time),
    ];
    return new Set(times);
  }

  async create(appointment: NewAppointment): Promise<BookedAppointment> {
    for (let attempt = 0; attempt < MAX_RESERVATION_NUMBER_ATTEMPTS; attempt += 1) {
      const reservationNumber = generateReservationNumber();
      try {
        const { rows } = await this.db.query(
          `INSERT INTO appointments
             (client_id, call_id, language, reservation_number, service_id, service_name,
              patient_phone, is_returning_patient, appointment_date, appointment_time)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           RETURNING id, created_at`,
          [
            appointment.clientId,
            appointment.callId,
            appointment.language,
            reservationNumber,
            appointment.serviceId,
            appointment.serviceName,
            appointment.patientPhone,
            appointment.isReturningPatient,
            appointment.appointmentDate,
            appointment.appointmentTime,
          ],
        );
        const row = rows[0] as AppointmentRow | undefined;
        if (!row) throw new Error('appointments insert returned no row');
        return { ...appointment, id: row.id, reservationNumber, createdAt: row.created_at };
      } catch (error) {
        if (isUniqueViolation(error)) continue; // reservation_number collision — retry with a new number
        throw error;
      }
    }
    throw new Error('could not generate a unique reservation number after several attempts');
  }
}

/**
 * Completed demo bookings (VP-8). Also answers "what times are already taken
 * on this date" — the fake pre-seeded `reservation_booked_slots` plus every
 * real appointment already booked this demo — which `checkAvailability`
 * (src/reservation/availability.ts) treats as one combined taken-set.
 */
import type { Queryable } from '../db/pool.js';
import type { ClinicNow } from '../lib/clinicTime.js';
import { generateReservationNumber } from '../reservation/reservationNumber.js';

export interface NewAppointment {
  clientId: string;
  callId: string;
  language: string;
  /** Null for a returning-patient booking, which skips service selection (work order §3). */
  serviceId: string | null;
  serviceName: string | null;
  /** The caller's confirmed name (katakana for Japanese, as spelled for English). */
  patientName: string;
  /** Demo placeholder until real caller-ID exists — see src/lib/demoCallerPhone.ts. */
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

/** An upcoming, still-active booking, as told to the caller. Holds no phone number. */
export interface UpcomingAppointment {
  id: string;
  reservationNumber: string;
  serviceName: string | null;
  appointmentDate: string; // YYYY-MM-DD
  appointmentTime: string; // HH:MM, 24-hour
}

/**
 * A caller's most recent earlier visit, as recalled to them (VP-26). Deliberately only the date and
 * the service: no time of day, name, reservation number or phone number ever leaves this type.
 */
export interface LastVisit {
  appointmentDate: string; // YYYY-MM-DD
  /** The stored service slug; null for a returning-patient booking, which skips service selection. */
  serviceId: string | null;
  /** The service text as it was when booked (may be in another language than this call's). */
  serviceName: string | null;
}

/** Who is changing which booking, in which call. `phone` is the call's own number, never a model argument. */
export interface ChangeRequest {
  clientId: string;
  appointmentId: string;
  /** The caller's stored (normalised) number; only a booking made under it can be changed. */
  phone: string;
  callId: string;
  /** Clinic-local "now": a booking that has already started cannot be changed. */
  now: ClinicNow;
}

export interface RescheduleRequest extends ChangeRequest {
  newDate: string; // YYYY-MM-DD
  newTime: string; // HH:MM, 24-hour
}

/** What a successful cancel / reschedule did — what staff and the caller are told. */
export interface ChangedAppointment {
  id: string;
  reservationNumber: string;
  serviceName: string | null;
  patientName: string | null;
  language: string;
  oldDate: string;
  oldTime: string;
  /** Present for a reschedule only. */
  newDate?: string;
  newTime?: string;
}

/** The slot was taken by another live booking (unique index) — nothing was changed. */
export class SlotTakenError extends Error {
  constructor() {
    super('that appointment slot is already taken');
    this.name = 'SlotTakenError';
  }
}

/** This call has already cancelled or rescheduled one booking (one change per call) — nothing was changed. */
export class ChangeLimitError extends Error {
  constructor() {
    super('this call has already made a change');
    this.name = 'ChangeLimitError';
  }
}

export interface AppointmentRepository {
  /** Every time already spoken for on `date` — fake pre-seeded slots plus real, active demo bookings. */
  listTakenTimes(clientId: string, date: string): Promise<Set<string>>;
  /** @throws SlotTakenError when another live booking already holds the slot. */
  create(appointment: NewAppointment): Promise<BookedAppointment>;
  /** This caller's active bookings that have not started yet, soonest first. */
  listUpcomingForPhone(
    clientId: string,
    phone: string,
    now: ClinicNow,
    limit: number,
  ): Promise<UpcomingAppointment[]>;
  /**
   * This caller's most recent earlier visit: an active booking that has already started and is no
   * older than `oldestDate` (inclusive). A booking is not proof of attendance — there is no
   * attendance record — so this is "the latest booking whose time has passed". `undefined` when
   * there is none. Reads nothing but the caller's own rows (client + number).
   */
  findLastVisit(
    clientId: string,
    phone: string,
    now: ClinicNow,
    oldestDate: string,
  ): Promise<LastVisit | undefined>;
  /**
   * Soft-cancels the booking (status `cancelled`, row kept) and records the change, in one
   * statement. `undefined` when no active, upcoming booking of this caller matches.
   * @throws ChangeLimitError when this call already made a change.
   */
  cancel(request: ChangeRequest): Promise<ChangedAppointment | undefined>;
  /**
   * Moves the booking to a new slot in place (same row, same reservation number) and records the
   * change, in one statement. `undefined` when no active, upcoming booking of this caller matches.
   * @throws SlotTakenError when the new slot is held by another live booking.
   * @throws ChangeLimitError when this call already made a change.
   */
  reschedule(request: RescheduleRequest): Promise<ChangedAppointment | undefined>;
  /**
   * The change THIS call already made to this caller's booking, if any. A tool call that is
   * delivered twice (a retry, or the model calling again) finds nothing to change the second time;
   * this lets the route answer with the original outcome instead of "could not be made".
   */
  findChangeInCall(
    clientId: string,
    callId: string,
    appointmentId: string,
    phone: string,
  ): Promise<ChangedAppointment | undefined>;
}

const UNIQUE_VIOLATION = '23505';
const RESERVATION_NUMBER_INDEX = 'appointments_client_reservation_idx';
const ACTIVE_SLOT_INDEX = 'appointments_active_slot_idx';
const ONE_CHANGE_PER_CALL_INDEX = 'appointment_changes_call_idx';
/** A collision is astronomically unlikely (1 in a million per attempt) — this bounds a retry loop, not a real risk. */
const MAX_RESERVATION_NUMBER_ATTEMPTS = 5;

/** The name of the unique index a write violated, or undefined if it was not a unique violation. */
function violatedIndex(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const { code, constraint } = error as { code?: unknown; constraint?: unknown };
  return code === UNIQUE_VIOLATION && typeof constraint === 'string' ? constraint : undefined;
}

/** Turns the two index violations a change can hit into their own errors; anything else is rethrown. */
function translateChangeError(error: unknown): never {
  const index = violatedIndex(error);
  if (index === ACTIVE_SLOT_INDEX) throw new SlotTakenError();
  if (index === ONE_CHANGE_PER_CALL_INDEX) throw new ChangeLimitError();
  throw error;
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
        // A cancelled booking has given its slot back.
        `SELECT appointment_time FROM appointments
          WHERE client_id = $1 AND appointment_date = $2 AND status = 'active'`,
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
              patient_name, patient_phone, is_returning_patient, appointment_date, appointment_time)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           RETURNING id, created_at`,
          [
            appointment.clientId,
            appointment.callId,
            appointment.language,
            reservationNumber,
            appointment.serviceId,
            appointment.serviceName,
            appointment.patientName,
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
        const index = violatedIndex(error);
        if (index === RESERVATION_NUMBER_INDEX) continue; // collision — retry with a new number
        if (index === ACTIVE_SLOT_INDEX) throw new SlotTakenError();
        throw error;
      }
    }
    throw new Error('could not generate a unique reservation number after several attempts');
  }

  async listUpcomingForPhone(
    clientId: string,
    phone: string,
    now: ClinicNow,
    limit: number,
  ): Promise<UpcomingAppointment[]> {
    const { rows } = await this.db.query(
      `SELECT id, reservation_number, service_name, appointment_date, appointment_time
         FROM appointments
        WHERE client_id = $1 AND patient_phone = $2 AND status = 'active'
          AND (appointment_date > $3 OR (appointment_date = $3 AND appointment_time > $4))
        ORDER BY appointment_date, appointment_time
        LIMIT $5`,
      [clientId, phone, now.date, now.time, limit],
    );
    return (rows as UpcomingRow[]).map((row) => ({
      id: row.id,
      reservationNumber: row.reservation_number,
      serviceName: row.service_name,
      appointmentDate: row.appointment_date,
      appointmentTime: row.appointment_time,
    }));
  }

  async findLastVisit(
    clientId: string,
    phone: string,
    now: ClinicNow,
    oldestDate: string,
  ): Promise<LastVisit | undefined> {
    // The complement of `listUpcomingForPhone`'s "has not started yet": a booking that has started.
    // Served by appointments_active_phone_idx (client, phone, date, time) WHERE status = 'active'.
    const { rows } = await this.db.query(
      `SELECT appointment_date, service_id, service_name
         FROM appointments
        WHERE client_id = $1 AND patient_phone = $2 AND status = 'active'
          AND appointment_date >= $5
          AND (appointment_date < $3 OR (appointment_date = $3 AND appointment_time <= $4))
        ORDER BY appointment_date DESC, appointment_time DESC
        LIMIT 1`,
      [clientId, phone, now.date, now.time, oldestDate],
    );
    const row = rows[0] as LastVisitRow | undefined;
    if (!row) return undefined;
    return {
      appointmentDate: row.appointment_date,
      serviceId: row.service_id,
      serviceName: row.service_name,
    };
  }

  async findChangeInCall(
    clientId: string,
    callId: string,
    appointmentId: string,
    phone: string,
  ): Promise<ChangedAppointment | undefined> {
    const { rows } = await this.db.query(
      `SELECT a.id, a.reservation_number, a.service_name, a.patient_name, a.language,
              c.old_date, c.old_time, c.new_date, c.new_time
         FROM appointment_changes c
         JOIN appointments a ON a.id = c.appointment_id
        WHERE c.client_id = $1 AND c.call_id = $2 AND c.appointment_id = $3
          AND a.client_id = $1 AND a.patient_phone = $4`,
      [clientId, callId, appointmentId, phone],
    );
    const row = rows[0] as
      (ChangedRow & { new_date: string | null; new_time: string | null }) | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      reservationNumber: row.reservation_number,
      serviceName: row.service_name,
      patientName: row.patient_name,
      language: row.language,
      oldDate: row.old_date,
      oldTime: row.old_time,
      ...(row.new_date !== null && row.new_time !== null
        ? { newDate: row.new_date, newTime: row.new_time }
        : {}),
    };
  }

  cancel(request: ChangeRequest): Promise<ChangedAppointment | undefined> {
    return this.change(request, undefined);
  }

  reschedule(request: RescheduleRequest): Promise<ChangedAppointment | undefined> {
    return this.change(request, { date: request.newDate, time: request.newTime });
  }

  /**
   * One statement, so it is all-or-nothing: lock the caller's matching booking, update it, and
   * write the audit row. A unique-index violation (slot taken, or a second change in this call)
   * aborts the whole statement, so a refused change leaves the booking exactly as it was.
   */
  private async change(
    request: ChangeRequest,
    moveTo: { date: string; time: string } | undefined,
  ): Promise<ChangedAppointment | undefined> {
    const action = moveTo ? 'rescheduled' : 'cancelled';
    try {
      const { rows } = await this.db.query(
        `WITH target AS (
           SELECT id, appointment_date AS old_date, appointment_time AS old_time
             FROM appointments
            WHERE id = $1 AND client_id = $2 AND patient_phone = $3 AND status = 'active'
              AND (appointment_date > $4 OR (appointment_date = $4 AND appointment_time > $5))
            FOR NO KEY UPDATE
         ), changed AS (
           UPDATE appointments a
              SET status = CASE WHEN $8::text = 'cancelled' THEN 'cancelled' ELSE a.status END,
                  appointment_date = COALESCE($6, a.appointment_date),
                  appointment_time = COALESCE($7, a.appointment_time),
                  updated_at = now()
             FROM target t
            WHERE a.id = t.id
        RETURNING a.id, a.reservation_number, a.service_name, a.patient_name, a.language,
                  a.appointment_date AS new_date, a.appointment_time AS new_time,
                  t.old_date, t.old_time
         ), logged AS (
           INSERT INTO appointment_changes
                  (client_id, appointment_id, call_id, action, old_date, old_time, new_date, new_time)
           SELECT $2, id, $9, $8, old_date, old_time,
                  CASE WHEN $8 = 'rescheduled' THEN new_date END,
                  CASE WHEN $8 = 'rescheduled' THEN new_time END
             FROM changed
         )
         SELECT * FROM changed`,
        [
          request.appointmentId,
          request.clientId,
          request.phone,
          request.now.date,
          request.now.time,
          moveTo?.date ?? null,
          moveTo?.time ?? null,
          action,
          request.callId,
        ],
      );
      const row = rows[0] as ChangedRow | undefined;
      if (!row) return undefined;
      return {
        id: row.id,
        reservationNumber: row.reservation_number,
        serviceName: row.service_name,
        patientName: row.patient_name,
        language: row.language,
        oldDate: row.old_date,
        oldTime: row.old_time,
        ...(moveTo ? { newDate: row.new_date, newTime: row.new_time } : {}),
      };
    } catch (error) {
      return translateChangeError(error);
    }
  }
}

interface UpcomingRow {
  id: string;
  reservation_number: string;
  service_name: string | null;
  appointment_date: string;
  appointment_time: string;
}

interface LastVisitRow {
  appointment_date: string;
  service_id: string | null;
  service_name: string | null;
}

interface ChangedRow extends UpcomingRow {
  patient_name: string | null;
  language: string;
  old_date: string;
  old_time: string;
  new_date: string;
  new_time: string;
}

import type { Queryable } from '../db/pool.js';
import type { CallStatus } from '../lib/callStatus.js';

/**
 * The staff-visible record of one call (db/migrations/0009_call_logs.sql).
 * Holds personal data — never log it without src/lib/redact.ts — and has
 * deliberately no transcript or audio field.
 */
export interface NewCallLog {
  clientId: string;
  callId: string;
  language: string;
  status: CallStatus;
  callerName?: string;
  matchedPatientName?: string;
  topic?: string;
  summary?: string;
  endedReason?: string;
  /** ISO 8601, as Vapi sends it. */
  startedAt?: string;
  endedAt?: string;
}

export interface CallLogRepository {
  /** Idempotent per (client, call): Vapi redelivering the report is ignored. */
  record(log: NewCallLog): Promise<void>;
}

/**
 * What staff are allowed to see of a call (VP-12 decision 2): summary and status only.
 * The shape is an explicit allow-list — there is no transcript, audio, recording, ended-reason or
 * archive field to leak, and the SQL below names every column instead of using `SELECT *`.
 */
export interface StaffCallSummary {
  id: string;
  callId: string;
  startedAt: Date | null;
  createdAt: Date;
  language: string;
  callerName: string | null;
  matchedPatientName: string | null;
  topic: string | null;
  status: CallStatus;
  summary: string | null;
  /** Whole seconds from started_at to ended_at; null when either is missing or they are out of order. */
  durationSeconds: number | null;
  /** The callback request the call produced, if any (staff mark it handled from the call list). */
  callback: StaffCallbackInfo | null;
}

/** The act-on-it part of a callback request (VP-4/VP-5), joined onto its call. */
export interface StaffCallbackInfo {
  id: string;
  callerPhone: string;
  reason: string | null;
  status: 'pending' | 'handled';
  handledAt: Date | null;
}

/**
 * One reservation, whatever created it. Rows come from `appointments`, not from `call_logs`: today
 * every booking is made by the voice agent, but a future booking source has no call, so the
 * summary is nullable and comes from the originating call when there is one.
 */
export interface StaffReservationSummary {
  id: string;
  reservationNumber: string;
  /** Clinic-local `YYYY-MM-DD` and `HH:MM` as stored — wall-clock text, not instants. */
  appointmentDate: string;
  appointmentTime: string;
  serviceName: string | null;
  /** Null for bookings made before the name was collected again (migration 0008). */
  patientName: string | null;
  isReturningPatient: boolean;
  language: string;
  /** When the booking was made. */
  bookedAt: Date;
  /** The AI summary of the call that made the booking; null if no call log exists for it. */
  summary: string | null;
}

export interface StaffCallListOptions {
  status?: CallStatus;
  limit?: number;
}

/** Read side for the staff dashboard. Always scoped to one client — never "all rows". */
export interface CallLogReader {
  /** Newest first. */
  listByClient(clientId: string, options?: StaffCallListOptions): Promise<StaffCallSummary[]>;
  /**
   * The Needs Callback view: one row per callback request, with its call's details when a call log
   * exists (callbacks older than call logging, or whose end-of-call report never arrived, have
   * none), plus needs_callback calls that have no callback request. Newest first.
   */
  listNeedsCallback(clientId: string, limit?: number): Promise<StaffCallSummary[]>;
  /** Every reservation for the client, most recently booked first. */
  listReservations(clientId: string, limit?: number): Promise<StaffReservationSummary[]>;
}

/** A page of the dashboard; busy clinics get the most recent calls, never an unbounded query. */
export const STAFF_LIST_LIMIT = 100;

interface StaffCallRow {
  id: string;
  call_id: string;
  started_at: Date | null;
  created_at: Date;
  language: string;
  caller_name: string | null;
  matched_patient_name: string | null;
  topic: string | null;
  status: CallStatus;
  summary: string | null;
  duration_seconds: number | null;
  callback_id: string | null;
  callback_phone: string | null;
  callback_reason: string | null;
  callback_status: 'pending' | 'handled' | null;
  callback_handled_at: Date | null;
}

/** SQL for StaffCallRow.duration_seconds, given the table alias that owns started_at/ended_at. */
const durationSql = (alias: string): string =>
  `CASE WHEN ${alias}.started_at IS NOT NULL AND ${alias}.ended_at >= ${alias}.started_at
        THEN round(EXTRACT(EPOCH FROM (${alias}.ended_at - ${alias}.started_at)))::int END`;

interface StaffReservationRow {
  id: string;
  reservation_number: string;
  appointment_date: string;
  appointment_time: string;
  service_name: string | null;
  patient_name: string | null;
  is_returning_patient: boolean;
  language: string;
  created_at: Date;
  summary: string | null;
}

function toStaffCall(row: StaffCallRow): StaffCallSummary {
  return {
    id: row.id,
    callId: row.call_id,
    startedAt: row.started_at,
    createdAt: row.created_at,
    language: row.language,
    callerName: row.caller_name,
    matchedPatientName: row.matched_patient_name,
    topic: row.topic,
    status: row.status,
    summary: row.summary,
    durationSeconds: row.duration_seconds,
    callback:
      row.callback_id !== null && row.callback_status !== null
        ? {
            id: row.callback_id,
            callerPhone: row.callback_phone ?? '',
            reason: row.callback_reason,
            status: row.callback_status,
            handledAt: row.callback_handled_at,
          }
        : null,
  };
}

export class PgCallLogRepository implements CallLogRepository, CallLogReader {
  constructor(private readonly db: Queryable) {}

  async listByClient(
    clientId: string,
    options: StaffCallListOptions = {},
  ): Promise<StaffCallSummary[]> {
    const { rows } = await this.db.query(
      `SELECT l.id, l.call_id, l.started_at, l.created_at, l.language, l.caller_name,
              l.matched_patient_name, l.topic, l.status, l.summary,
              ${durationSql('l')} AS duration_seconds,
              cb.id AS callback_id, cb.caller_phone AS callback_phone,
              cb.reason AS callback_reason, cb.status AS callback_status,
              cb.handled_at AS callback_handled_at
       FROM call_logs l
       LEFT JOIN LATERAL (
         SELECT c.id, c.caller_phone, c.reason, c.status, c.handled_at
         FROM callback_requests c
         WHERE c.client_id = l.client_id AND c.call_id = l.call_id
         ORDER BY c.created_at DESC
         LIMIT 1
       ) cb ON true
       WHERE l.client_id = $1 AND ($2::text IS NULL OR l.status = $2)
       ORDER BY COALESCE(l.started_at, l.created_at) DESC
       LIMIT $3`,
      [clientId, options.status ?? null, options.limit ?? STAFF_LIST_LIMIT],
    );
    return (rows as StaffCallRow[]).map(toStaffCall);
  }

  async listNeedsCallback(
    clientId: string,
    limit: number = STAFF_LIST_LIMIT,
  ): Promise<StaffCallSummary[]> {
    const { rows } = await this.db.query(
      `SELECT * FROM (
         SELECT c.id, c.call_id, l.started_at, COALESCE(l.created_at, c.created_at) AS created_at,
                COALESCE(l.language, c.language) AS language,
                COALESCE(l.caller_name, c.caller_name) AS caller_name,
                l.matched_patient_name, l.topic, COALESCE(l.status, 'needs_callback') AS status,
                l.summary, ${durationSql('l')} AS duration_seconds,
                c.id AS callback_id, c.caller_phone AS callback_phone, c.reason AS callback_reason,
                c.status AS callback_status, c.handled_at AS callback_handled_at
         FROM callback_requests c
         LEFT JOIN call_logs l ON l.client_id = c.client_id AND l.call_id = c.call_id
         WHERE c.client_id = $1
         UNION ALL
         SELECT l.id, l.call_id, l.started_at, l.created_at, l.language, l.caller_name,
                l.matched_patient_name, l.topic, l.status, l.summary,
                ${durationSql('l')} AS duration_seconds,
                NULL, NULL, NULL, NULL, NULL
         FROM call_logs l
         WHERE l.client_id = $1 AND l.status = 'needs_callback'
           AND NOT EXISTS (
             SELECT 1 FROM callback_requests c WHERE c.client_id = l.client_id AND c.call_id = l.call_id
           )
       ) rows
       ORDER BY COALESCE(started_at, created_at) DESC
       LIMIT $2`,
      [clientId, limit],
    );
    return (rows as StaffCallRow[]).map(toStaffCall);
  }

  async listReservations(
    clientId: string,
    limit: number = STAFF_LIST_LIMIT,
  ): Promise<StaffReservationSummary[]> {
    const { rows } = await this.db.query(
      `SELECT a.id, a.reservation_number, a.appointment_date, a.appointment_time, a.service_name,
              a.patient_name, a.is_returning_patient, a.language, a.created_at, l.summary
       FROM appointments a
       LEFT JOIN call_logs l ON l.client_id = a.client_id AND l.call_id = a.call_id
       WHERE a.client_id = $1
       ORDER BY a.created_at DESC
       LIMIT $2`,
      [clientId, limit],
    );
    return (rows as StaffReservationRow[]).map((row) => ({
      id: row.id,
      reservationNumber: row.reservation_number,
      appointmentDate: row.appointment_date,
      appointmentTime: row.appointment_time,
      serviceName: row.service_name,
      patientName: row.patient_name,
      isReturningPatient: row.is_returning_patient,
      language: row.language,
      bookedAt: row.created_at,
      summary: row.summary,
    }));
  }

  async record(log: NewCallLog): Promise<void> {
    await this.db.query(
      `INSERT INTO call_logs
         (client_id, call_id, language, status, caller_name, matched_patient_name,
          topic, summary, ended_reason, started_at, ended_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (client_id, call_id) DO NOTHING`,
      [
        log.clientId,
        log.callId,
        log.language,
        log.status,
        log.callerName ?? null,
        log.matchedPatientName ?? null,
        log.topic ?? null,
        log.summary ?? null,
        log.endedReason ?? null,
        log.startedAt ?? null,
        log.endedAt ?? null,
      ],
    );
  }
}

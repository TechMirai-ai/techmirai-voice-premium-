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
}

/** A reservation_made call with its booking details (null if the appointment row is missing). */
export interface StaffReservationSummary extends StaffCallSummary {
  reservationNumber: string | null;
  appointmentDate: string | null;
  appointmentTime: string | null;
  serviceName: string | null;
}

export interface StaffCallListOptions {
  status?: CallStatus;
  limit?: number;
}

/** Read side for the staff dashboard. Always scoped to one client — never "all rows". */
export interface CallLogReader {
  /** Newest first. */
  listByClient(clientId: string, options?: StaffCallListOptions): Promise<StaffCallSummary[]>;
  /** Calls whose status is reservation_made, newest first, joined with their appointment. */
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
}

interface StaffReservationRow extends StaffCallRow {
  reservation_number: string | null;
  appointment_date: string | null;
  appointment_time: string | null;
  service_name: string | null;
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
  };
}

export class PgCallLogRepository implements CallLogRepository, CallLogReader {
  constructor(private readonly db: Queryable) {}

  async listByClient(
    clientId: string,
    options: StaffCallListOptions = {},
  ): Promise<StaffCallSummary[]> {
    const { rows } = await this.db.query(
      `SELECT id, call_id, started_at, created_at, language, caller_name,
              matched_patient_name, topic, status, summary
       FROM call_logs
       WHERE client_id = $1 AND ($2::text IS NULL OR status = $2)
       ORDER BY COALESCE(started_at, created_at) DESC
       LIMIT $3`,
      [clientId, options.status ?? null, options.limit ?? STAFF_LIST_LIMIT],
    );
    return (rows as StaffCallRow[]).map(toStaffCall);
  }

  async listReservations(
    clientId: string,
    limit: number = STAFF_LIST_LIMIT,
  ): Promise<StaffReservationSummary[]> {
    const { rows } = await this.db.query(
      `SELECT l.id, l.call_id, l.started_at, l.created_at, l.language, l.caller_name,
              l.matched_patient_name, l.topic, l.status, l.summary,
              a.reservation_number, a.appointment_date, a.appointment_time, a.service_name
       FROM call_logs l
       LEFT JOIN appointments a ON a.client_id = l.client_id AND a.call_id = l.call_id
       WHERE l.client_id = $1 AND l.status = 'reservation_made'
       ORDER BY COALESCE(l.started_at, l.created_at) DESC
       LIMIT $2`,
      [clientId, limit],
    );
    return (rows as StaffReservationRow[]).map((row) => ({
      ...toStaffCall(row),
      reservationNumber: row.reservation_number,
      appointmentDate: row.appointment_date,
      appointmentTime: row.appointment_time,
      serviceName: row.service_name,
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

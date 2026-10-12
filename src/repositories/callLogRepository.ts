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

export class PgCallLogRepository implements CallLogRepository {
  constructor(private readonly db: Queryable) {}

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

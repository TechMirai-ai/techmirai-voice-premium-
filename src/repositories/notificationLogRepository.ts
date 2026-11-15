/**
 * Delivery record for booking notifications (VP-23). One row per attempt, holding NO personal
 * data — see db/migrations/0013_notification_log.sql.
 *
 * Sends are guarded by daily and per-call caps (an abuse guard for a public page where anyone can
 * type a number). To make the caps race-safe the notifier RESERVES a slot first: `reserve` inserts
 * a `pending` row, `countReserved` counts live rows (its own included), and `settle` records the
 * outcome. Whichever concurrent request counts last sees every other request's reservation, so
 * together they can never exceed a cap.
 */
import type { Queryable } from '../db/pool.js';

export type NotificationChannel = 'sms' | 'line';
/** What a notification is about. Rows written before VP-25 are all `booked`; a consultation request has no appointment. */
export type NotificationEvent = 'booked' | 'cancelled' | 'rescheduled' | 'consultation_requested';
export const DEFAULT_NOTIFICATION_EVENT: NotificationEvent = 'booked';
export type NotificationStatus = 'pending' | 'sent' | 'failed' | 'skipped';
export type SettledStatus = Exclude<NotificationStatus, 'pending'>;

export interface NewNotificationLogEntry {
  clientId: string;
  /** Absent for events that are not about an appointment (a consultation request). */
  appointmentId?: string | undefined;
  channel: NotificationChannel;
  /** What it was about; defaults to `booked`. */
  event?: NotificationEvent;
  /** The Vapi call that caused it (a change's own call, not the call that made the booking). */
  callId?: string;
  /** A final state; use `reserve` + `settle` for a send that has to claim a cap slot first. */
  status: SettledStatus;
  /** The NAME of the env var that held the recipient (LINE); never the recipient itself. */
  recipientRef?: string;
  /** A short reason code such as `no_caller_number` or `http_400` — never free text from a provider. */
  detail?: string;
  providerMessageId?: string;
}

export interface Reservation {
  clientId: string;
  appointmentId?: string | undefined;
  channel: NotificationChannel;
  event?: NotificationEvent;
  callId?: string;
  recipientRef?: string;
}

export interface Settlement {
  status: SettledStatus;
  detail?: string;
  providerMessageId?: string;
}

export interface ReservedCountQuery {
  clientId: string;
  channel: NotificationChannel;
  /** Start of the rolling window the caps apply to. */
  since: Date;
  /**
   * A `pending` row created before this no longer counts: a live send finishes in seconds, so an
   * older one belongs to a crashed or timed-out request and must not hold a slot for a day.
   */
  pendingSince: Date;
  /** The stored caller number; when given, `forNumber` counts bookings under it. */
  patientPhone?: string;
  /** The Vapi call id; when given, `forCall` counts sends caused by that call (for `event`). */
  callId?: string;
  /** Which event `forCall` counts — the per-call limit is per event. Defaults to `booked`. */
  event?: NotificationEvent;
}

export interface ReservedCounts {
  /** Live (`sent`, or recent `pending`) rows on this channel for the client since `since`. */
  forClient: number;
  /** The same, limited to appointments booked under `patientPhone` (0 when none given). */
  forNumber: number;
  /** The same, limited to appointments booked in call `callId` (0 when none given). */
  forCall: number;
}

export interface RecordedCountQuery {
  clientId: string;
  channel: NotificationChannel;
  /** The reason code stored in `detail`, e.g. `cap_alert`. */
  detail: string;
  since: Date;
}

export interface NotificationLogRepository {
  record(entry: NewNotificationLogEntry): Promise<void>;
  /** Inserts a `pending` row and returns its id. */
  reserve(reservation: Reservation): Promise<string>;
  /** Moves a reserved row to its final status. */
  settle(id: string, settlement: Settlement): Promise<void>;
  countReserved(query: ReservedCountQuery): Promise<ReservedCounts>;
  /** Rows of any status carrying this `detail` since `since` (used to send a notice once a day). */
  countRecorded(query: RecordedCountQuery): Promise<number>;
}

interface CountRow {
  for_client: string;
  for_number: string;
  for_call: string;
}

export class PgNotificationLogRepository implements NotificationLogRepository {
  constructor(private readonly db: Queryable) {}

  async record(entry: NewNotificationLogEntry): Promise<void> {
    await this.db.query(
      `INSERT INTO notification_log
         (client_id, appointment_id, channel, status, recipient_ref, detail, provider_message_id,
          event, call_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        entry.clientId,
        entry.appointmentId ?? null,
        entry.channel,
        entry.status,
        entry.recipientRef ?? null,
        entry.detail ?? null,
        entry.providerMessageId ?? null,
        entry.event ?? DEFAULT_NOTIFICATION_EVENT,
        entry.callId ?? null,
      ],
    );
  }

  async reserve(reservation: Reservation): Promise<string> {
    const { rows } = await this.db.query(
      `INSERT INTO notification_log
         (client_id, appointment_id, channel, status, recipient_ref, event, call_id)
       VALUES ($1,$2,$3,'pending',$4,$5,$6)
       RETURNING id`,
      [
        reservation.clientId,
        reservation.appointmentId ?? null,
        reservation.channel,
        reservation.recipientRef ?? null,
        reservation.event ?? DEFAULT_NOTIFICATION_EVENT,
        reservation.callId ?? null,
      ],
    );
    const id = (rows[0] as { id: string } | undefined)?.id;
    if (!id) throw new Error('notification reservation returned no id');
    return id;
  }

  async settle(id: string, settlement: Settlement): Promise<void> {
    await this.db.query(
      `UPDATE notification_log
          SET status = $2, detail = $3, provider_message_id = $4
        WHERE id = $1`,
      [id, settlement.status, settlement.detail ?? null, settlement.providerMessageId ?? null],
    );
  }

  async countRecorded(query: RecordedCountQuery): Promise<number> {
    const { rows } = await this.db.query(
      `SELECT count(*)::text AS total FROM notification_log
        WHERE client_id = $1 AND channel = $2 AND detail = $3 AND created_at >= $4`,
      [query.clientId, query.channel, query.detail, query.since],
    );
    return Number((rows[0] as { total: string } | undefined)?.total ?? 0);
  }

  async countReserved(query: ReservedCountQuery): Promise<ReservedCounts> {
    const { rows } = await this.db.query(
      `SELECT count(*)::text AS for_client,
              (count(*) FILTER (WHERE a.patient_phone = $5))::text AS for_number,
              (count(*) FILTER (
                WHERE n.event = $7 AND COALESCE(n.call_id, a.call_id) = $6
              ))::text AS for_call
         FROM notification_log n
         LEFT JOIN appointments a ON a.id = n.appointment_id
        WHERE n.client_id = $1
          AND n.channel = $2
          AND n.created_at >= $3
          AND (n.status = 'sent' OR (n.status = 'pending' AND n.created_at >= $4))`,
      [
        query.clientId,
        query.channel,
        query.since,
        query.pendingSince,
        query.patientPhone ?? null,
        query.callId ?? null,
        query.event ?? DEFAULT_NOTIFICATION_EVENT,
      ],
    );
    const row = rows[0] as CountRow | undefined;
    return {
      forClient: Number(row?.for_client ?? 0),
      forNumber: Number(row?.for_number ?? 0),
      forCall: Number(row?.for_call ?? 0),
    };
  }
}

/**
 * Delivery record for booking notifications (VP-23). One row per attempt, holding NO personal
 * data — see db/migrations/0013_notification_log.sql.
 */
import type { Queryable } from '../db/pool.js';

export type NotificationChannel = 'sms' | 'line';
export type NotificationStatus = 'sent' | 'failed' | 'skipped';

export interface NewNotificationLogEntry {
  clientId: string;
  appointmentId: string;
  channel: NotificationChannel;
  status: NotificationStatus;
  /** The NAME of the env var that held the recipient (LINE); never the recipient itself. */
  recipientRef?: string;
  /** A short reason code such as `no_caller_number` or `http_400` — never free text from a provider. */
  detail?: string;
  providerMessageId?: string;
}

export interface NotificationLogRepository {
  record(entry: NewNotificationLogEntry): Promise<void>;
  /**
   * How many confirmation SMS were successfully sent since `since` to appointments booked under
   * this number — the abuse guard for a public page where anyone can type a number.
   */
  countSmsSentToNumber(clientId: string, patientPhone: string, since: Date): Promise<number>;
}

interface CountRow {
  sent: string;
}

export class PgNotificationLogRepository implements NotificationLogRepository {
  constructor(private readonly db: Queryable) {}

  async record(entry: NewNotificationLogEntry): Promise<void> {
    await this.db.query(
      `INSERT INTO notification_log
         (client_id, appointment_id, channel, status, recipient_ref, detail, provider_message_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        entry.clientId,
        entry.appointmentId,
        entry.channel,
        entry.status,
        entry.recipientRef ?? null,
        entry.detail ?? null,
        entry.providerMessageId ?? null,
      ],
    );
  }

  async countSmsSentToNumber(clientId: string, patientPhone: string, since: Date): Promise<number> {
    const { rows } = await this.db.query(
      `SELECT count(*)::text AS sent
         FROM notification_log n
         JOIN appointments a ON a.id = n.appointment_id
        WHERE n.client_id = $1
          AND n.channel = 'sms'
          AND n.status = 'sent'
          AND a.patient_phone = $2
          AND n.created_at >= $3`,
      [clientId, patientPhone, since],
    );
    return Number((rows[0] as CountRow | undefined)?.sent ?? 0);
  }
}

import type { Queryable } from '../db/pool.js';

export const CONSULTATION_STATUSES = ['new', 'contacted', 'scheduled', 'closed'] as const;
export type ConsultationStatus = (typeof CONSULTATION_STATUSES)[number];

export type PhoneSource = 'caller_id' | 'spoken';

export interface NewConsultationRequest {
  clientId: string;
  callId: string;
  language: string;
  contactName: string;
  /** Normalised national form (src/lib/callerPhone.ts), or null when there is none. */
  contactPhone: string | null;
  phoneSource: PhoneSource;
  /** Only when the caller stated one. */
  reason: string | null;
  details?: Record<string, unknown>;
}

/** One row as read back. HOLDS PERSONAL DATA — redact before logging. */
export interface ConsultationRequest {
  id: string;
  clientId: string;
  callId: string;
  language: string;
  contactName: string;
  contactPhone: string | null;
  phoneSource: PhoneSource;
  reason: string | null;
  status: ConsultationStatus;
  details: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateResult {
  request: ConsultationRequest;
  /** False when a row for (clientId, callId) already existed and was returned unchanged. */
  created: boolean;
}

export type UpdateStatusResult = { found: true; request: ConsultationRequest } | { found: false };

export interface ConsultationRequestRepository {
  /** Idempotent on (clientId, callId): a repeat returns the existing row and changes nothing. */
  create(request: NewConsultationRequest): Promise<CreateResult>;
  /** One client's requests, newest first, optionally only one status. Always scoped. */
  listByClient(clientId: string, status?: ConsultationStatus): Promise<ConsultationRequest[]>;
  /** `found: false` — and nothing changed — when the id is unknown or belongs to another client. */
  updateStatus(
    id: string,
    clientId: string,
    status: ConsultationStatus,
  ): Promise<UpdateStatusResult>;
}

interface ConsultationRow {
  id: string;
  client_id: string;
  call_id: string;
  language: string;
  contact_name: string;
  contact_phone: string | null;
  phone_source: PhoneSource;
  reason: string | null;
  status: ConsultationStatus;
  details: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

const COLUMNS = `id, client_id, call_id, language, contact_name, contact_phone, phone_source,
  reason, status, details, created_at, updated_at`;

function toRequest(row: ConsultationRow): ConsultationRequest {
  return {
    id: row.id,
    clientId: row.client_id,
    callId: row.call_id,
    language: row.language,
    contactName: row.contact_name,
    contactPhone: row.contact_phone,
    phoneSource: row.phone_source,
    reason: row.reason,
    status: row.status,
    details: row.details,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class PgConsultationRequestRepository implements ConsultationRequestRepository {
  constructor(private readonly db: Queryable) {}

  async create(request: NewConsultationRequest): Promise<CreateResult> {
    const inserted = await this.db.query(
      `INSERT INTO consultation_requests
         (client_id, call_id, language, contact_name, contact_phone, phone_source, reason, details)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
       ON CONFLICT (client_id, call_id) DO NOTHING
       RETURNING ${COLUMNS}`,
      [
        request.clientId,
        request.callId,
        request.language,
        request.contactName,
        request.contactPhone,
        request.phoneSource,
        request.reason,
        JSON.stringify(request.details ?? {}),
      ],
    );
    const insertedRow = inserted.rows[0] as ConsultationRow | undefined;
    if (insertedRow) return { request: toRequest(insertedRow), created: true };

    const existing = await this.db.query(
      `SELECT ${COLUMNS} FROM consultation_requests WHERE client_id = $1 AND call_id = $2`,
      [request.clientId, request.callId],
    );
    const existingRow = existing.rows[0] as ConsultationRow | undefined;
    if (!existingRow) throw new Error('consultation_requests insert conflicted but no row found');
    return { request: toRequest(existingRow), created: false };
  }

  async listByClient(
    clientId: string,
    status?: ConsultationStatus,
  ): Promise<ConsultationRequest[]> {
    const { rows } = await this.db.query(
      `SELECT ${COLUMNS} FROM consultation_requests
       WHERE client_id = $1 AND ($2::text IS NULL OR status = $2)
       ORDER BY created_at DESC, id`,
      [clientId, status ?? null],
    );
    return (rows as ConsultationRow[]).map(toRequest);
  }

  async updateStatus(
    id: string,
    clientId: string,
    status: ConsultationStatus,
  ): Promise<UpdateStatusResult> {
    const { rows } = await this.db.query(
      `UPDATE consultation_requests
       SET status = $3, updated_at = now()
       WHERE id = $1 AND client_id = $2
       RETURNING ${COLUMNS}`,
      [id, clientId, status],
    );
    const row = rows[0] as ConsultationRow | undefined;
    return row ? { found: true, request: toRequest(row) } : { found: false };
  }
}

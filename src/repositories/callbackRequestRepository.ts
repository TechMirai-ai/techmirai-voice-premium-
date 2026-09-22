import type { Queryable } from '../db/pool.js';
import type { CallbackNotification } from '../lib/callbackNotifier.js';

export interface NewCallbackRequest {
  clientId: string;
  callId: string;
  language: string;
  callerName: string;
  callerPhone: string;
  reason: string | null;
}

export interface CallbackRequestRepository {
  create(request: NewCallbackRequest): Promise<CallbackNotification>;
}

/** The staff dashboard's read model (VP-5) — one row as shown to a logged-in staff member. */
export interface CallbackRequestSummary {
  id: string;
  clientId: string;
  callId: string;
  language: string;
  callerName: string;
  callerPhone: string;
  reason: string | null;
  status: 'pending' | 'handled';
  createdAt: Date;
  handledAt: Date | null;
}

/**
 * Separate from CallbackRequestRepository (used by the request_callback
 * webhook) so that interface keeps its single responsibility — creating a
 * row — and every existing caller/fake of it is unaffected by the dashboard's
 * read/update needs.
 */
export interface CallbackRequestAdminRepository {
  /** Every callback for one client, newest first. Always scoped — never "all rows" (§4.3). */
  listByClient(clientId: string): Promise<CallbackRequestSummary[]>;
  /**
   * Marks a callback handled. Returns false — and changes nothing — if the id
   * does not exist or belongs to a different client, so a cross-client
   * request can be rejected without confirming whether the id exists at all.
   * Idempotent: marking an already-handled row again keeps its original
   * handled_at.
   */
  markHandled(id: string, clientId: string): Promise<boolean>;
}

interface CallbackRow {
  id: string;
  created_at: Date;
}

interface CallbackSummaryRow {
  id: string;
  client_id: string;
  call_id: string;
  language: string;
  caller_name: string;
  caller_phone: string;
  reason: string | null;
  status: 'pending' | 'handled';
  created_at: Date;
  handled_at: Date | null;
}

function toSummary(row: CallbackSummaryRow): CallbackRequestSummary {
  return {
    id: row.id,
    clientId: row.client_id,
    callId: row.call_id,
    language: row.language,
    callerName: row.caller_name,
    callerPhone: row.caller_phone,
    reason: row.reason,
    status: row.status,
    createdAt: row.created_at,
    handledAt: row.handled_at,
  };
}

export class PgCallbackRequestRepository
  implements CallbackRequestRepository, CallbackRequestAdminRepository
{
  constructor(private readonly db: Queryable) {}

  async create(request: NewCallbackRequest): Promise<CallbackNotification> {
    const { rows } = await this.db.query(
      `INSERT INTO callback_requests
         (client_id, call_id, language, caller_name, caller_phone, reason)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, created_at`,
      [
        request.clientId,
        request.callId,
        request.language,
        request.callerName,
        request.callerPhone,
        request.reason,
      ],
    );
    const row = rows[0] as CallbackRow | undefined;
    if (!row) throw new Error('callback_requests insert returned no row');

    return { ...request, id: row.id, createdAt: row.created_at };
  }

  async listByClient(clientId: string): Promise<CallbackRequestSummary[]> {
    const { rows } = await this.db.query(
      `SELECT id, client_id, call_id, language, caller_name, caller_phone, reason, status, created_at, handled_at
       FROM callback_requests
       WHERE client_id = $1
       ORDER BY created_at DESC`,
      [clientId],
    );
    return (rows as CallbackSummaryRow[]).map(toSummary);
  }

  async markHandled(id: string, clientId: string): Promise<boolean> {
    const { rows } = await this.db.query(
      `UPDATE callback_requests
       SET status = 'handled', handled_at = COALESCE(handled_at, now())
       WHERE id = $1 AND client_id = $2
       RETURNING id`,
      [id, clientId],
    );
    return rows.length > 0;
  }
}

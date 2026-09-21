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

interface CallbackRow {
  id: string;
  created_at: Date;
}

export class PgCallbackRequestRepository implements CallbackRequestRepository {
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
}

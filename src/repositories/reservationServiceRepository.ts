/**
 * Read-only access to a client's demo bookable services (VP-8). Content is
 * seeded by `npm run demo:seed` (src/cli/seedReservationDemoData.ts), never
 * written here — this interface is read-only, same spirit as `KnowledgeSource`.
 */
import type { Queryable } from '../db/pool.js';

export interface ReservationService {
  /** A slug, e.g. "general-consultation" — the value a tool call and the prompt both use. */
  id: string;
  name: Record<string, string>; // language code -> text, e.g. { ja: "...", en: "..." }
  durationMinutes: number;
}

export interface ReservationServiceRepository {
  /** Every service for one client, in display order. Empty = reservations are off for this client. */
  listByClient(clientId: string): Promise<ReservationService[]>;
}

interface ServiceRow {
  id: string;
  name_ja: string;
  name_en: string;
  duration_minutes: number;
}

export class PgReservationServiceRepository implements ReservationServiceRepository {
  constructor(private readonly db: Queryable) {}

  async listByClient(clientId: string): Promise<ReservationService[]> {
    const { rows } = await this.db.query(
      `SELECT id, name_ja, name_en, duration_minutes
       FROM reservation_services
       WHERE client_id = $1
       ORDER BY sort_order, id`,
      [clientId],
    );
    return (rows as ServiceRow[]).map((row) => ({
      id: row.id,
      name: { ja: row.name_ja, en: row.name_en },
      durationMinutes: row.duration_minutes,
    }));
  }
}

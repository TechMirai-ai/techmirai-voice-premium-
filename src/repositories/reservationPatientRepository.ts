/**
 * Read-only lookup of the demo's fake returning patients (VP-8), matched by
 * phone number only (work order §1 decision 5) — the caller's spoken name is
 * never the lookup key, only something to confirm out loud against what this
 * returns. Content is seeded by `npm run demo:seed`, never written here.
 */
import type { Queryable } from '../db/pool.js';

export interface ReservationPatient {
  name: string;
  phone: string;
}

export interface ReservationPatientRepository {
  /** `phoneDigits` must already be normalized (digits only) — see src/lib/phone.ts. */
  findByPhone(clientId: string, phoneDigits: string): Promise<ReservationPatient | undefined>;
}

interface PatientRow {
  name: string;
  phone: string;
}

export class PgReservationPatientRepository implements ReservationPatientRepository {
  constructor(private readonly db: Queryable) {}

  async findByPhone(
    clientId: string,
    phoneDigits: string,
  ): Promise<ReservationPatient | undefined> {
    const { rows } = await this.db.query(
      `SELECT name, phone FROM reservation_demo_patients WHERE client_id = $1 AND phone = $2`,
      [clientId, phoneDigits],
    );
    const row = rows[0] as PatientRow | undefined;
    return row ? { name: row.name, phone: row.phone } : undefined;
  }
}

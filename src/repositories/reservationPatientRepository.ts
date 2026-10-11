/**
 * Read-only lookup of the demo's fake returning patients (VP-8). There is no real caller number on
 * a browser web call yet (src/lib/demoCallerPhone.ts), so a returning patient is matched by the
 * name the caller gave and confirmed out loud. Content is seeded by `npm run demo:seed`, never
 * written here.
 */
import type { Queryable } from '../db/pool.js';

export interface ReservationPatient {
  name: string;
}

export interface ReservationPatientRepository {
  /**
   * The one patient whose name matches `name`, or `undefined` when none — or more than one —
   * does (an ambiguous short name must not silently pick someone).
   */
  findByName(clientId: string, name: string): Promise<ReservationPatient | undefined>;
}

interface PatientRow {
  name: string;
}

const compact = (value: string): string =>
  value.normalize('NFKC').toLowerCase().replace(/\s+/g, '');

/**
 * A caller may give a short name ("Taro"), so a name matches a patient when it equals the whole
 * stored name or exactly one whitespace-separated part of it (spacing and case ignored).
 */
export function matchPatientsByName(names: string[], spoken: string): string[] {
  const wanted = compact(spoken);
  if (wanted === '') return [];
  return names.filter((stored) => {
    if (compact(stored) === wanted) return true;
    return stored
      .normalize('NFKC')
      .split(/\s+/)
      .some((part) => compact(part) === wanted);
  });
}

export class PgReservationPatientRepository implements ReservationPatientRepository {
  constructor(private readonly db: Queryable) {}

  async findByName(clientId: string, name: string): Promise<ReservationPatient | undefined> {
    const { rows } = await this.db.query(
      `SELECT name FROM reservation_demo_patients WHERE client_id = $1`,
      [clientId],
    );
    const matches = matchPatientsByName(
      (rows as PatientRow[]).map((row) => row.name),
      name,
    );
    return matches.length === 1 ? { name: matches[0]! } : undefined;
  }
}

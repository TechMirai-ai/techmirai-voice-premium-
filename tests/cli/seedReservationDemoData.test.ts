import { describe, expect, test } from 'vitest';

import { seedReservationDemoData, runSeed } from '../../src/cli/seedReservationDemoData.js';

interface RecordedQuery {
  sql: string;
  values: unknown[] | undefined;
}

function fakeDb() {
  const queries: RecordedQuery[] = [];
  return {
    queries,
    query: (sql: string, values?: unknown[]) => {
      queries.push({ sql, values });
      return Promise.resolve({ rows: [] });
    },
  };
}

describe('seedReservationDemoData', () => {
  test('seeds every service, patient and booked slot for sakura-seikotsuin', async () => {
    const db = fakeDb();

    const result = await seedReservationDemoData(
      'sakura-seikotsuin',
      db,
      new Date('2026-10-01T00:00:00Z'),
    );

    expect(result).toEqual({ services: 3, patients: 3, bookedSlots: 4 });
    const insertedInto = (table: string) =>
      db.queries.filter((q) => q.sql.includes(`INSERT INTO ${table}`));
    expect(insertedInto('reservation_services')).toHaveLength(3);
    expect(insertedInto('reservation_demo_patients')).toHaveLength(3);
    expect(insertedInto('reservation_booked_slots')).toHaveLength(4);
  });

  test('every insert is ON CONFLICT DO NOTHING — idempotent', async () => {
    const db = fakeDb();

    await seedReservationDemoData('sakura-seikotsuin', db);

    for (const query of db.queries) {
      expect(query.sql).toMatch(/ON CONFLICT .* DO NOTHING/);
    }
  });

  test('booked-slot dates are computed relative to `now`, not hard-coded', async () => {
    const db = fakeDb();

    await seedReservationDemoData('sakura-seikotsuin', db, new Date('2026-10-01T00:00:00Z'));

    const slotDates = db.queries
      .filter((q) => q.sql.includes('INSERT INTO reservation_booked_slots'))
      .map((q) => q.values?.[1]);
    expect(slotDates).toEqual(['2026-10-02', '2026-10-02', '2026-10-03', '2026-10-04']);
  });

  test('rejects an unknown client id without touching the database', async () => {
    const db = fakeDb();

    await expect(seedReservationDemoData('no-such-clinic', db)).rejects.toThrow(
      /no demo reservation fixture/i,
    );
    expect(db.queries).toEqual([]);
  });
});

describe('runSeed', () => {
  test('prints usage and exits non-zero when clientId is missing', async () => {
    expect(await runSeed([])).toBe(1);
  });
});

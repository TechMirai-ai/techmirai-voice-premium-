/**
 * `npm run demo:seed -- <clientId>`
 *
 * Seeds the VP-8 demo reservation feature's fake fixture data: a small fixed
 * services list, a couple of returning "demo" patients, and a handful of
 * pre-seeded fake "already booked" times, so check_availability has
 * something to say no to. Idempotent — `ON CONFLICT DO NOTHING` on every
 * insert, so running it again is a no-op, matching `npm run db:migrate`'s
 * "running it twice applies nothing the second time" guarantee.
 *
 * This content is entirely fictional (work order §1 decision 1-2) and is not
 * clinic identity data, so — unlike client.yaml — it lives here in code, same
 * spirit as the "Yamada Taro" test data used in VP-7. `--client-id` lets any
 * client id be seeded, not only the one hard-coded set below (only
 * sakura-seikotsuin is defined today).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createPool } from '../db/pool.js';
import { loadDatabaseUrl } from '../env.js';

function printLine(text: string): void {
  process.stdout.write(`${text}\n`);
}

function printError(text: string): void {
  process.stderr.write(`${text}\n`);
}

interface SeedService {
  id: string;
  nameJa: string;
  nameEn: string;
  durationMinutes: number;
  sortOrder: number;
}

interface SeedPatient {
  name: string;
  phone: string;
}

interface DemoFixture {
  services: SeedService[];
  patients: SeedPatient[];
  /** Relative to the seed run date — kept as fixed offsets so the fixture never goes stale. */
  bookedSlotOffsetsDays: { dayOffset: number; time: string }[];
}

/** Only sakura-seikotsuin's fixture is defined today — this is demo-only content, not client.yaml data. */
const FIXTURES: Record<string, DemoFixture> = {
  'sakura-seikotsuin': {
    services: [
      {
        id: 'general-consultation',
        nameJa: '一般施術',
        nameEn: 'General Consultation',
        durationMinutes: 30,
        sortOrder: 1,
      },
      {
        id: 'follow-up',
        nameJa: 'フォローアップ',
        nameEn: 'Follow-up',
        durationMinutes: 20,
        sortOrder: 2,
      },
      {
        id: 'sports-injury',
        nameJa: 'スポーツ外傷施術',
        nameEn: 'Sports Injury Treatment',
        durationMinutes: 45,
        sortOrder: 3,
      },
    ],
    // Same spirit as the "Yamada Taro" test data used in VP-7's manual testing.
    patients: [
      { name: 'ヤマダ タロウ', phone: '09011112222' },
      { name: 'サトウ ハナコ', phone: '08033334444' },
      { name: 'Sato Hanako', phone: '08033334444' },
    ],
    bookedSlotOffsetsDays: [
      { dayOffset: 1, time: '10:00' },
      { dayOffset: 1, time: '14:00' },
      { dayOffset: 2, time: '09:00' },
      { dayOffset: 3, time: '15:30' },
    ],
  },
};

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export interface SeedResult {
  services: number;
  patients: number;
  bookedSlots: number;
}

export async function seedReservationDemoData(
  clientId: string,
  db: { query(sql: string, values?: unknown[]): Promise<{ rows: unknown[] }> },
  now: Date = new Date(),
): Promise<SeedResult> {
  const fixture = FIXTURES[clientId];
  if (!fixture) {
    throw new Error(
      `No demo reservation fixture is defined for "${clientId}" — add one to FIXTURES in ` +
        'src/cli/seedReservationDemoData.ts (this is fictional demo content, not client.yaml data).',
    );
  }

  for (const service of fixture.services) {
    await db.query(
      `INSERT INTO reservation_services (id, client_id, name_ja, name_en, duration_minutes, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO NOTHING`,
      [
        service.id,
        clientId,
        service.nameJa,
        service.nameEn,
        service.durationMinutes,
        service.sortOrder,
      ],
    );
  }

  for (const patient of fixture.patients) {
    await db.query(
      `INSERT INTO reservation_demo_patients (client_id, name, phone)
       VALUES ($1, $2, $3)
       ON CONFLICT (client_id, phone) DO NOTHING`,
      [clientId, patient.name, patient.phone],
    );
  }

  for (const slot of fixture.bookedSlotOffsetsDays) {
    const date = new Date(now);
    date.setUTCDate(date.getUTCDate() + slot.dayOffset);
    await db.query(
      `INSERT INTO reservation_booked_slots (client_id, slot_date, slot_time)
       VALUES ($1, $2, $3)
       ON CONFLICT (client_id, slot_date, slot_time) DO NOTHING`,
      [clientId, isoDate(date), slot.time],
    );
  }

  return {
    services: fixture.services.length,
    patients: fixture.patients.length,
    bookedSlots: fixture.bookedSlotOffsetsDays.length,
  };
}

const USAGE = 'Usage: npm run demo:seed -- <clientId>';

export async function runSeed(argv: string[]): Promise<number> {
  const [clientId] = argv;
  if (!clientId) {
    printError(USAGE);
    return 1;
  }

  const databaseUrl = loadDatabaseUrl();
  const pool = createPool({ connectionString: databaseUrl });
  try {
    const result = await seedReservationDemoData(clientId, pool);
    printLine(
      `Seeded "${clientId}": ${result.services} service(s), ${result.patients} demo patient(s), ` +
        `${result.bookedSlots} fake booked slot(s). Re-running is safe — inserts are idempotent.`,
    );
    return 0;
  } catch (error) {
    printError(error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    await pool.end();
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  runSeed(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      printError(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}

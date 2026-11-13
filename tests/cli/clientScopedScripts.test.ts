/**
 * demo:clear-calls and services:remove-follow-up: argument/known-client guards (no database), and
 * per-client isolation, preview-by-default and --commit against a real Postgres (TEST_DATABASE_URL;
 * skipped otherwise) in a throwaway schema.
 */
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { runClientScopedCommand } from '../../src/cli/clientScopedCommand.js';
import { clearDemoCallsAction } from '../../src/cli/clearDemoCalls.js';
import { removeFollowUpAction } from '../../src/cli/removeFollowUpService.js';
import { runMigrations } from '../../src/db/migrate.js';
import type { Queryable } from '../../src/db/pool.js';
import { SAKURA_ID } from '../helpers/clientFixtures.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
/** Both exist under clients/ in this repo. */
const KANTO_ID = 'kanto-city-gas-demo';

type Deps = Parameters<typeof runClientScopedCommand>[2];

function capture(): { out: string[]; err: string[]; deps: (db: Queryable) => Deps } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    deps: (db) => ({ db, print: (l) => out.push(l), printError: (l) => err.push(l) }),
  };
}

/** A database that must never be reached: every query is recorded so the test can assert none ran. */
function untouchableDb(): Queryable & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    query(sql: string) {
      calls.push(sql);
      return Promise.resolve({ rows: [] });
    },
  };
}

describe.each([
  ['demo:clear-calls', clearDemoCallsAction],
  ['services:remove-follow-up', removeFollowUpAction],
])('%s guards', (_name, action) => {
  test('refuses a missing clientId and touches nothing', async () => {
    const io = capture();
    const db = untouchableDb();

    const code = await runClientScopedCommand([], action, io.deps(db));

    expect(code).toBe(1);
    expect(io.err.join('\n')).toContain('Usage:');
    expect(db.calls).toEqual([]);
  });

  test('refuses --commit on its own (no clientId) and touches nothing', async () => {
    const io = capture();
    const db = untouchableDb();

    const code = await runClientScopedCommand(['--commit'], action, io.deps(db));

    expect(code).toBe(1);
    expect(db.calls).toEqual([]);
  });

  test('refuses an unknown clientId and touches nothing', async () => {
    const io = capture();
    const db = untouchableDb();

    const code = await runClientScopedCommand(['no-such-clinic', '--commit'], action, io.deps(db));

    expect(code).toBe(1);
    expect(io.err.join('\n')).toContain('Unknown client "no-such-clinic"');
    expect(db.calls).toEqual([]);
  });

  test('refuses a path-traversal clientId and touches nothing', async () => {
    const io = capture();
    const db = untouchableDb();

    const code = await runClientScopedCommand(['../etc'], action, io.deps(db));

    expect(code).toBe(1);
    expect(db.calls).toEqual([]);
  });

  test('refuses extra arguments and touches nothing', async () => {
    const io = capture();
    const db = untouchableDb();

    const code = await runClientScopedCommand([SAKURA_ID, KANTO_ID], action, io.deps(db));

    expect(code).toBe(1);
    expect(db.calls).toEqual([]);
  });
});

describe.each([
  ['demo:clear-calls', clearDemoCallsAction],
  ['services:remove-follow-up', removeFollowUpAction],
])('%s failure part-way', (_name, action) => {
  /** Query 1 is BEGIN; query 3 (the second statement of the command) throws. */
  function failingThirdQueryDb(): Queryable & { calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      query(sql: string) {
        calls.push(sql);
        if (calls.length === 3) return Promise.reject(new Error('simulated failure'));
        return Promise.resolve({ rows: [{ n: 0 }] });
      },
    };
  }

  test.each([[[SAKURA_ID, '--commit']], [[SAKURA_ID]]])(
    'rolls back, never commits, and exits 1 (argv %j)',
    async (argv) => {
      const io = capture();
      const db = failingThirdQueryDb();

      const code = await runClientScopedCommand(argv, action, io.deps(db));

      expect(code).toBe(1);
      expect(db.calls[0]).toBe('BEGIN');
      expect(db.calls).toContain('ROLLBACK');
      expect(db.calls).not.toContain('COMMIT');
      // Nothing is queried after the rollback, and the failure is reported, not swallowed.
      expect(db.calls.at(-1)).toBe('ROLLBACK');
      expect(io.err.join('\n')).toContain('simulated failure');
      expect(io.out.join('\n')).not.toContain('Committed.');
    },
  );
});

describe.skipIf(!TEST_DATABASE_URL)('client-scoped scripts (real Postgres)', () => {
  const schema = `tmvp_scripts_${Date.now()}_${Math.floor(Math.random() * 10_000)}`;
  let adminPool: pg.Pool;
  let pool: pg.Pool;

  const countFor = async (table: string, clientId: string): Promise<number> => {
    const { rows } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ${table} WHERE client_id = $1`,
      [clientId],
    );
    return rows[0]?.n ?? 0;
  };

  async function seedCallRows(clientId: string): Promise<void> {
    const call = `${clientId}-call`;
    await pool.query(
      `INSERT INTO call_logs (client_id, call_id, language, status) VALUES ($1, $2, 'ja', 'unresolved')`,
      [clientId, call],
    );
    await pool.query(
      `INSERT INTO appointments
         (client_id, call_id, language, reservation_number, patient_phone, appointment_date, appointment_time)
       VALUES ($1, $2, 'ja', $3, '09012345678', '2026-12-01', '10:00')`,
      [clientId, call, `R-${clientId}`],
    );
    await pool.query(
      `INSERT INTO appointment_changes (client_id, appointment_id, call_id, action, old_date, old_time)
       SELECT client_id, id, $2, 'cancelled', '2026-12-01', '10:00' FROM appointments WHERE client_id = $1`,
      [clientId, `${call}-change`],
    );
    await pool.query(
      `INSERT INTO callback_requests (client_id, call_id, language, caller_name, caller_phone)
       VALUES ($1, $2, 'ja', 'n', '09012345678')`,
      [clientId, call],
    );
    await pool.query(
      `INSERT INTO call_topics (client_id, call_id, topic, outcome, language)
       VALUES ($1, $2, 'parking', 'resolved', 'ja')`,
      [clientId, call],
    );
    await pool.query(`INSERT INTO call_archive_jobs (client_id, call_id) VALUES ($1, $2)`, [
      clientId,
      call,
    ]);
    await pool.query(
      `INSERT INTO consultation_requests (client_id, call_id, language, contact_name, phone_source)
       VALUES ($1, $2, 'ja', 'n', 'spoken')`,
      [clientId, call],
    );
  }

  const CLEARED_TABLES = [
    'call_logs',
    'appointment_changes',
    'appointments',
    'callback_requests',
    'call_topics',
    'call_archive_jobs',
  ];

  beforeAll(async () => {
    adminPool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(TEST_DATABASE_URL!);
    url.searchParams.set('options', `-c search_path=${schema},public`);
    // max 1: BEGIN … ROLLBACK/COMMIT must share one session, as in the real CLIs.
    pool = new pg.Pool({ connectionString: url.toString(), max: 1 });
    await runMigrations(pool);
  });

  afterAll(async () => {
    await pool?.end();
    await adminPool?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await adminPool?.end();
  });

  beforeEach(async () => {
    // Children before parents: appointment_changes and notification_log point at appointments.
    for (const table of [
      'appointment_changes',
      'notification_log',
      'call_logs',
      'appointments',
      'callback_requests',
      'call_topics',
      'call_archive_jobs',
      'consultation_requests',
      'reservation_services',
    ]) {
      await pool.query(`DELETE FROM ${table}`);
    }
    await seedCallRows(SAKURA_ID);
    await seedCallRows(KANTO_ID);
  });

  describe('demo:clear-calls', () => {
    test('previews by default: reports counts and changes nothing', async () => {
      const io = capture();

      const code = await runClientScopedCommand([SAKURA_ID], clearDemoCallsAction, io.deps(pool));

      expect(code).toBe(0);
      expect(io.out.join('\n')).toContain('call_logs: 1');
      expect(io.out.join('\n')).toContain('Preview only');
      for (const table of CLEARED_TABLES) expect(await countFor(table, SAKURA_ID)).toBe(1);
    });

    test('--commit deletes only that client’s rows, in all six tables, and prints counts only', async () => {
      const io = capture();

      const code = await runClientScopedCommand(
        [SAKURA_ID, '--commit'],
        clearDemoCallsAction,
        io.deps(pool),
      );

      expect(code).toBe(0);
      for (const table of CLEARED_TABLES) {
        expect(await countFor(table, SAKURA_ID)).toBe(0);
        expect(await countFor(table, KANTO_ID)).toBe(1);
      }
      // Not part of the demo-call wipe.
      expect(await countFor('consultation_requests', SAKURA_ID)).toBe(1);
      const printed = io.out.join('\n');
      expect(printed).toContain('Committed.');
      expect(printed).not.toContain('09012345678');
    });
  });

  describe('services:remove-follow-up', () => {
    beforeEach(async () => {
      // reservation_services.id is a global primary key, so the other client uses a different id.
      for (const [clientId, serviceId] of [
        [SAKURA_ID, 'follow-up'],
        [KANTO_ID, 'kanto-other'],
      ]) {
        await pool.query(
          `INSERT INTO reservation_services (id, client_id, name_ja, name_en, duration_minutes)
           VALUES ($1, $2, 'x', 'Follow-up', 15)`,
          [serviceId, clientId],
        );
      }
      await pool.query(`UPDATE appointments SET service_id = 'follow-up' WHERE client_id = $1`, [
        SAKURA_ID,
      ]);
    });

    test('previews by default and changes nothing', async () => {
      const io = capture();

      const code = await runClientScopedCommand([SAKURA_ID], removeFollowUpAction, io.deps(pool));

      expect(code).toBe(0);
      expect(io.out.join('\n')).toContain('services_deleted: 1');
      expect(io.out.join('\n')).toContain('appointments_unlinked: 1');
      expect(await countFor('reservation_services', SAKURA_ID)).toBe(1);
      const { rows } = await pool.query(
        `SELECT 1 FROM appointments WHERE client_id = $1 AND service_id = 'follow-up'`,
        [SAKURA_ID],
      );
      expect(rows).toHaveLength(1);
    });

    test('--commit removes the service and unlinks appointments for that client only', async () => {
      const io = capture();

      const code = await runClientScopedCommand(
        [SAKURA_ID, '--commit'],
        removeFollowUpAction,
        io.deps(pool),
      );

      expect(code).toBe(0);
      expect(await countFor('reservation_services', SAKURA_ID)).toBe(0);
      expect(await countFor('reservation_services', KANTO_ID)).toBe(1);
      expect(await countFor('appointments', SAKURA_ID)).toBe(1);
      const { rows } = await pool.query(
        `SELECT service_id FROM appointments WHERE client_id = $1`,
        [SAKURA_ID],
      );
      expect(rows[0]).toEqual({ service_id: null });
    });

    test('another client’s run does not touch this client’s follow-up service', async () => {
      const io = capture();

      await runClientScopedCommand([KANTO_ID, '--commit'], removeFollowUpAction, io.deps(pool));

      expect(await countFor('reservation_services', SAKURA_ID)).toBe(1);
      expect(await countFor('appointments', SAKURA_ID)).toBe(1);
    });
  });
});

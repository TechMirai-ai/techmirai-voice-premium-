/**
 * Destructive single-client CLIs refuse a `status: live` client unless --allow-live is given with
 * --commit (preview always works), and demo:clear-calls also clears consultation requests and the
 * consultation deliveries (real Postgres via TEST_DATABASE_URL; skipped otherwise).
 */
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import {
  ALLOW_LIVE_FLAG,
  runClientScopedCommand,
  type ClientScopedAction,
} from '../../src/cli/clientScopedCommand.js';
import { clearDemoCallsAction } from '../../src/cli/clearDemoCalls.js';
import { removeFollowUpAction } from '../../src/cli/removeFollowUpService.js';
import { runMigrations } from '../../src/db/migrate.js';
import type { Queryable } from '../../src/db/pool.js';
import {
  readSakuraDocument,
  withChanges,
  writeClientFixture,
  type ClientFixture,
} from '../helpers/clientFixtures.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const LIVE_ID = 'sakura-seikotsuin';

let fixture: ClientFixture | undefined;
const makeFixture = (status: 'live' | 'demo') =>
  writeClientFixture(
    LIVE_ID,
    withChanges(readSakuraDocument(), (draft) => {
      draft['status'] = status;
    }),
  );

afterEach(() => fixture?.cleanup());

/** Records every statement so a test can assert none ran. */
function recordingDb(): Queryable & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    query(sql: string) {
      calls.push(sql);
      return Promise.resolve({ rows: [{ n: 0 }] });
    },
  };
}

function run(
  argv: string[],
  action: ClientScopedAction,
  db: Queryable,
  clientsDir: string,
): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  return runClientScopedCommand(argv, action, {
    db,
    clientsOptions: { clientsDir },
    print: (line) => out.push(line),
    printError: (line) => err.push(line),
  }).then((code) => ({ code, out, err }));
}

describe.each([
  ['demo:clear-calls', clearDemoCallsAction],
  ['services:remove-follow-up', removeFollowUpAction],
])('%s and a live client', (_name, action) => {
  test('--commit without --allow-live is refused and touches nothing', async () => {
    fixture = makeFixture('live');
    const db = recordingDb();

    const result = await run([LIVE_ID, '--commit'], action, db, fixture.clientsDir);

    expect(result.code).toBe(1);
    expect(result.err.join('\n')).toMatch(/Refused: sakura-seikotsuin is a LIVE client/);
    expect(result.err.join('\n')).toContain(ALLOW_LIVE_FLAG);
    expect(db.calls).toEqual([]);
  });

  test('a preview (no --commit) works on a live client, rolls back, and says how to apply', async () => {
    fixture = makeFixture('live');
    const db = recordingDb();

    const result = await run([LIVE_ID], action, db, fixture.clientsDir);

    expect(result.code).toBe(0);
    expect(db.calls[0]).toBe('BEGIN');
    expect(db.calls.at(-1)).toBe('ROLLBACK');
    expect(db.calls).not.toContain('COMMIT');
    expect(result.out.join('\n')).toContain('(LIVE)');
    expect(result.out.join('\n')).toContain(`--commit ${ALLOW_LIVE_FLAG}`);
  });

  test('--allow-live alone (no --commit) is still only a preview', async () => {
    fixture = makeFixture('live');
    const db = recordingDb();

    const result = await run([LIVE_ID, ALLOW_LIVE_FLAG], action, db, fixture.clientsDir);

    expect(result.code).toBe(0);
    expect(db.calls.at(-1)).toBe('ROLLBACK');
  });

  test('--commit --allow-live (either order) commits on a live client', async () => {
    fixture = makeFixture('live');
    for (const argv of [
      [LIVE_ID, '--commit', ALLOW_LIVE_FLAG],
      [ALLOW_LIVE_FLAG, LIVE_ID, '--commit'],
    ]) {
      const db = recordingDb();

      const result = await run(argv, action, db, fixture.clientsDir);

      expect(result.code).toBe(0);
      expect(db.calls.at(-1)).toBe('COMMIT');
      expect(result.out.join('\n')).toContain('Committed.');
    }
  });

  test('a demo client needs no extra flag, and --allow-live is harmless there', async () => {
    fixture = makeFixture('demo');
    for (const argv of [
      [LIVE_ID, '--commit'],
      [LIVE_ID, '--commit', ALLOW_LIVE_FLAG],
    ]) {
      const db = recordingDb();

      const result = await run(argv, action, db, fixture.clientsDir);

      expect(result.code).toBe(0);
      expect(db.calls.at(-1)).toBe('COMMIT');
    }
  });

  test('an unreadable client.yaml fails closed, not open', async () => {
    fixture = writeClientFixture(LIVE_ID, { clientId: LIVE_ID });
    const db = recordingDb();

    const result = await run([LIVE_ID, '--commit'], action, db, fixture.clientsDir);

    expect(result.code).toBe(1);
    expect(result.err.join('\n')).toContain('cannot tell whether it is live');
    expect(db.calls).toEqual([]);
  });
});

describe('the real TechMirai client is live', () => {
  test('demo:clear-calls --commit on techmirai-ai is refused without --allow-live', async () => {
    const db = recordingDb();
    const err: string[] = [];

    const code = await runClientScopedCommand(['techmirai-ai', '--commit'], clearDemoCallsAction, {
      db,
      print: () => undefined,
      printError: (line) => err.push(line),
    });

    expect(code).toBe(1);
    expect(err.join('\n')).toContain('LIVE client');
    expect(db.calls).toEqual([]);
  });
});

describe.skipIf(!TEST_DATABASE_URL)(
  'demo:clear-calls and consultation data (real Postgres)',
  () => {
    const schema = `tmvp_liveguard_${Date.now()}_${Math.floor(Math.random() * 10_000)}`;
    let adminPool: pg.Pool;
    let pool: pg.Pool;

    const count = async (table: string, clientId: string): Promise<number> => {
      const { rows } = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM ${table} WHERE client_id = $1`,
        [clientId],
      );
      return rows[0]?.n ?? 0;
    };

    async function seedConsultation(clientId: string): Promise<void> {
      await pool.query(
        `INSERT INTO consultation_requests (client_id, call_id, language, contact_name, phone_source)
       VALUES ($1, 'c1', 'ja', 'n', 'spoken')`,
        [clientId],
      );
      for (const channel of ['sms', 'line']) {
        await pool.query(
          `INSERT INTO notification_log (client_id, channel, status, event, call_id)
         VALUES ($1, $2, 'sent', 'consultation_requested', 'c1')`,
          [clientId, channel],
        );
      }
    }

    beforeAll(async () => {
      adminPool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
      await adminPool.query(`CREATE SCHEMA ${schema}`);
      const url = new URL(TEST_DATABASE_URL!);
      url.searchParams.set('options', `-c search_path=${schema},public`);
      // max 1: BEGIN … COMMIT/ROLLBACK must share one session, as in the real CLIs.
      pool = new pg.Pool({ connectionString: url.toString(), max: 1 });
      await runMigrations(pool);
    });

    afterAll(async () => {
      await pool?.end();
      await adminPool?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await adminPool?.end();
    });

    beforeEach(async () => {
      await pool.query('TRUNCATE notification_log, consultation_requests');
      await seedConsultation('techmirai-ai');
      await seedConsultation('sakura-seikotsuin');
    });

    test('a preview counts them and changes nothing', async () => {
      const out: string[] = [];

      const code = await runClientScopedCommand(['techmirai-ai'], clearDemoCallsAction, {
        db: pool,
        print: (line) => out.push(line),
        printError: () => undefined,
      });

      expect(code).toBe(0);
      expect(out.join('\n')).toContain('consultation_requests: 1');
      expect(out.join('\n')).toContain('notification_log_without_appointment: 2');
      expect(await count('consultation_requests', 'techmirai-ai')).toBe(1);
      expect(await count('notification_log', 'techmirai-ai')).toBe(2);
    });

    test('--commit --allow-live clears this client’s consultation requests and deliveries, and only those', async () => {
      const code = await runClientScopedCommand(
        ['techmirai-ai', '--commit', ALLOW_LIVE_FLAG],
        clearDemoCallsAction,
        { db: pool, print: () => undefined, printError: () => undefined },
      );

      expect(code).toBe(0);
      expect(await count('consultation_requests', 'techmirai-ai')).toBe(0);
      expect(await count('notification_log', 'techmirai-ai')).toBe(0);
      // Another client's rows are untouched.
      expect(await count('consultation_requests', 'sakura-seikotsuin')).toBe(1);
      expect(await count('notification_log', 'sakura-seikotsuin')).toBe(2);
    });

    test('--commit without --allow-live leaves everything in place', async () => {
      const code = await runClientScopedCommand(
        ['techmirai-ai', '--commit'],
        clearDemoCallsAction,
        { db: pool, print: () => undefined, printError: () => undefined },
      );

      expect(code).toBe(1);
      expect(await count('consultation_requests', 'techmirai-ai')).toBe(1);
      expect(await count('notification_log', 'techmirai-ai')).toBe(2);
    });
  },
);

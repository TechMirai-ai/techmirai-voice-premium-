/**
 * Needs a real Postgres (TEST_DATABASE_URL); skipped otherwise, like callLogs.test.ts.
 * Runs the repo's own migrations in a throwaway schema.
 */
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { runMigrations } from '../../src/db/migrate.js';
import {
  PgConsultationRequestRepository,
  type NewConsultationRequest,
} from '../../src/repositories/consultationRequestRepository.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

/**
 * If you are here because this failed after adding a column: STOP. Like call_logs, this table must
 * never hold a transcript or audio — those live only in the developer's private Google archive.
 */
const CONSULTATION_REQUESTS_COLUMNS = [
  'call_id',
  'client_id',
  'contact_name',
  'contact_phone',
  'created_at',
  'details',
  'id',
  'language',
  'phone_source',
  'reason',
  'status',
  'updated_at',
];

function newRequest(overrides: Partial<NewConsultationRequest> = {}): NewConsultationRequest {
  return {
    clientId: 'client-a',
    callId: 'call-1',
    language: 'ja',
    contactName: 'Hanako',
    contactPhone: '09012345678',
    phoneSource: 'caller_id',
    reason: null,
    ...overrides,
  };
}

describe.skipIf(!TEST_DATABASE_URL)('consultation_requests (real Postgres)', () => {
  const schema = `tmvp_consult_${Date.now()}_${Math.floor(Math.random() * 10_000)}`;
  let adminPool: pg.Pool;
  let pool: pg.Pool;
  let repo: PgConsultationRequestRepository;

  beforeAll(async () => {
    adminPool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(TEST_DATABASE_URL!);
    url.searchParams.set('options', `-c search_path=${schema},public`);
    pool = new pg.Pool({ connectionString: url.toString() });
    await runMigrations(pool);
    repo = new PgConsultationRequestRepository(pool);
  });

  afterAll(async () => {
    await pool?.end();
    await adminPool?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await adminPool?.end();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM consultation_requests');
  });

  test('has exactly the expected columns — no transcript or audio column', async () => {
    const { rows } = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'consultation_requests' ORDER BY column_name`,
      [schema],
    );
    const columns = rows.map((row) => row.column_name);
    expect(columns).toEqual(CONSULTATION_REQUESTS_COLUMNS);
    for (const name of columns) {
      expect(name).not.toMatch(/transcript|audio|recording|message|conversation/i);
    }
  });

  test('has no foreign keys', async () => {
    const { rows } = await pool.query(
      `SELECT 1 FROM information_schema.table_constraints
       WHERE table_schema = $1 AND table_name = 'consultation_requests'
         AND constraint_type = 'FOREIGN KEY'`,
      [schema],
    );
    expect(rows).toHaveLength(0);
  });

  test('inserts with a NULL phone and applies the defaults', async () => {
    const { request, created } = await repo.create(
      newRequest({ contactPhone: null, phoneSource: 'spoken' }),
    );

    expect(created).toBe(true);
    expect(request.contactPhone).toBeNull();
    expect(request.reason).toBeNull();
    expect(request.status).toBe('new');
    expect(request.details).toEqual({});
    expect(request.createdAt).toBeInstanceOf(Date);
    expect(request.updatedAt).toBeInstanceOf(Date);
  });

  test('stores reason and details', async () => {
    const { request } = await repo.create(
      newRequest({ reason: 'Knee pain', details: { preferredTime: 'morning' } }),
    );
    expect(request.reason).toBe('Knee pain');
    expect(request.details).toEqual({ preferredTime: 'morning' });
  });

  test('a duplicate (client_id, call_id) is idempotent and returns the existing row unchanged', async () => {
    const first = await repo.create(newRequest({ contactName: 'Original' }));
    const second = await repo.create(newRequest({ contactName: 'Different', reason: 'x' }));

    expect(second.created).toBe(false);
    expect(second.request.id).toBe(first.request.id);
    expect(second.request.contactName).toBe('Original');
    expect(second.request.reason).toBeNull();
    expect(await repo.listByClient('client-a')).toHaveLength(1);
  });

  test('the same call_id under a different client is a separate row', async () => {
    await repo.create(newRequest());
    const other = await repo.create(newRequest({ clientId: 'client-b' }));
    expect(other.created).toBe(true);
  });

  test('refuses a status outside the fixed set', async () => {
    await expect(
      pool.query(
        `INSERT INTO consultation_requests
           (client_id, call_id, language, contact_name, phone_source, status)
         VALUES ('c', 'x', 'ja', 'n', 'spoken', 'maybe')`,
      ),
    ).rejects.toThrow(/check constraint/);
  });

  test('refuses a phone_source outside the fixed set', async () => {
    await expect(
      pool.query(
        `INSERT INTO consultation_requests
           (client_id, call_id, language, contact_name, phone_source)
         VALUES ('c', 'x', 'ja', 'n', 'guessed')`,
      ),
    ).rejects.toThrow(/check constraint/);
    await expect(repo.create(newRequest({ phoneSource: 'guessed' as 'spoken' }))).rejects.toThrow(
      /check constraint/,
    );
  });

  test('updateStatus changes the status and bumps updated_at', async () => {
    const { request } = await repo.create(newRequest());

    const result = await repo.updateStatus(request.id, 'client-a', 'contacted');

    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.request.status).toBe('contacted');
    expect(result.request.updatedAt.getTime()).toBeGreaterThanOrEqual(request.updatedAt.getTime());
  });

  test('updateStatus refuses an invalid status', async () => {
    const { request } = await repo.create(newRequest());
    await expect(repo.updateStatus(request.id, 'client-a', 'bogus' as 'new')).rejects.toThrow(
      /check constraint/,
    );
  });

  test('listByClient filters by status and returns newest first', async () => {
    const first = await repo.create(newRequest({ callId: 'c1' }));
    await repo.create(newRequest({ callId: 'c2' }));
    await repo.create(newRequest({ callId: 'c3' }));
    await pool.query(
      `UPDATE consultation_requests
       SET created_at = now() - (right(call_id, 1)::int || ' hours')::interval`,
    );
    await repo.updateStatus(first.request.id, 'client-a', 'closed');

    const all = await repo.listByClient('client-a');
    expect(all.map((r) => r.callId)).toEqual(['c1', 'c2', 'c3']);

    const closed = await repo.listByClient('client-a', 'closed');
    expect(closed.map((r) => r.callId)).toEqual(['c1']);
    expect(await repo.listByClient('client-a', 'scheduled')).toEqual([]);
  });

  describe('client separation', () => {
    test('client A can neither read nor update client B’s row', async () => {
      const b = await repo.create(newRequest({ clientId: 'client-b', callId: 'b-call' }));
      await repo.create(newRequest({ clientId: 'client-a', callId: 'a-call' }));

      const listedByA = await repo.listByClient('client-a');
      expect(listedByA.map((r) => r.clientId)).toEqual(['client-a']);
      expect(listedByA.some((r) => r.id === b.request.id)).toBe(false);

      const update = await repo.updateStatus(b.request.id, 'client-a', 'closed');
      expect(update).toEqual({ found: false });

      const bRows = await repo.listByClient('client-b');
      expect(bRows).toHaveLength(1);
      expect(bRows[0]?.status).toBe('new');
    });

    test('updateStatus on an unknown id is not-found', async () => {
      const result = await repo.updateStatus(
        '00000000-0000-0000-0000-000000000000',
        'client-a',
        'closed',
      );
      expect(result).toEqual({ found: false });
    });
  });
});

/**
 * Needs a real Postgres (TEST_DATABASE_URL); skipped otherwise, like migrate.test.ts.
 * Runs the repo's own migrations in a throwaway schema.
 */
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { runMigrations } from '../../src/db/migrate.js';
import { PgCallbackRequestRepository } from '../../src/repositories/callbackRequestRepository.js';
import { PgCallTopicRepository } from '../../src/repositories/callTopicRepository.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

/**
 * VP-4 §6 test 3. If you are here because this failed after adding a column to
 * call_topics: STOP. That table must never be able to hold personal data —
 * no name, phone, or free-text column. Add such a column to a different table.
 */
const CALL_TOPICS_COLUMNS = [
  'call_id',
  'client_id',
  'created_at',
  'id',
  'language',
  'outcome',
  'topic',
];

const CALLBACK_REQUESTS_COLUMNS = [
  'call_id',
  'caller_name',
  'caller_phone',
  'client_id',
  'created_at',
  'handled_at',
  'id',
  'language',
  'reason',
  'status',
];

describe.skipIf(!TEST_DATABASE_URL)('callback_requests and call_topics (real Postgres)', () => {
  const schema = `tmvp_calls_${Date.now()}_${Math.floor(Math.random() * 10_000)}`;
  let adminPool: pg.Pool;
  let pool: pg.Pool;

  const columnsOf = async (table: string): Promise<string[]> => {
    const { rows } = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = $2 ORDER BY column_name`,
      [schema, table],
    );
    return rows.map((row) => row.column_name);
  };

  beforeAll(async () => {
    adminPool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(TEST_DATABASE_URL!);
    url.searchParams.set('options', `-c search_path=${schema},public`);
    pool = new pg.Pool({ connectionString: url.toString() });
    await runMigrations(pool);
  });

  afterAll(async () => {
    await pool?.end();
    await adminPool?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await adminPool?.end();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM callback_requests');
    await pool.query('DELETE FROM call_topics');
  });

  describe('call_topics schema', () => {
    test('has exactly the expected columns — no personal-data or free-text column', async () => {
      expect(await columnsOf('call_topics')).toEqual(CALL_TOPICS_COLUMNS);
    });

    test('no column is named like personal data or free text', async () => {
      for (const name of await columnsOf('call_topics')) {
        expect(name).not.toMatch(
          /name|phone|tel|mail|reason|note|text|comment|message|transcript|summary/i,
        );
      }
    });

    test('the topic column refuses a sentence, so it cannot smuggle free text', async () => {
      const insert = (callId: string, topic: string) =>
        pool.query(
          `INSERT INTO call_topics (client_id, call_id, topic, outcome, language)
           VALUES ('c', $1, $2, 'resolved', 'ja')`,
          [callId, topic],
        );

      await expect(insert('a', 'Hanako Yamada called about her knee')).rejects.toThrow(
        /check constraint/,
      );
      await expect(insert('b', 'hours')).resolves.toBeDefined();
    });

    test('refuses an unknown outcome', async () => {
      await expect(
        pool.query(
          `INSERT INTO call_topics (client_id, call_id, topic, outcome, language)
           VALUES ('c', 'x', 'hours', 'maybe', 'ja')`,
        ),
      ).rejects.toThrow(/check constraint/);
    });

    test('the repository records a topic once per call — a repeat is ignored', async () => {
      const repo = new PgCallTopicRepository(pool);
      const topic = {
        clientId: 'c',
        callId: 'call-1',
        topic: 'hours',
        outcome: 'resolved',
        language: 'ja',
      } as const;

      await repo.record(topic);
      await repo.record({ ...topic, topic: 'fees' });

      const { rows } = await pool.query('SELECT topic FROM call_topics');
      expect(rows).toEqual([{ topic: 'hours' }]);
    });
  });

  describe('callback_requests schema', () => {
    test('has exactly the expected columns', async () => {
      expect(await columnsOf('callback_requests')).toEqual(CALLBACK_REQUESTS_COLUMNS);
    });

    test('the repository lands each field in the right column, as pending', async () => {
      const repo = new PgCallbackRequestRepository(pool);

      const saved = await repo.create({
        clientId: 'sakura-seikotsuin',
        callId: 'call-9',
        language: 'ja',
        callerName: 'Hanako Yamada',
        callerPhone: '090-1234-5678',
        reason: 'Asked about a treatment',
      });

      const { rows } = await pool.query('SELECT * FROM callback_requests WHERE id = $1', [
        saved.id,
      ]);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        client_id: 'sakura-seikotsuin',
        call_id: 'call-9',
        language: 'ja',
        caller_name: 'Hanako Yamada',
        caller_phone: '090-1234-5678',
        reason: 'Asked about a treatment',
        status: 'pending',
        handled_at: null,
      });
      expect(saved.createdAt).toBeInstanceOf(Date);
    });

    test('stores a null reason', async () => {
      const repo = new PgCallbackRequestRepository(pool);

      const saved = await repo.create({
        clientId: 'c',
        callId: 'k',
        language: 'en',
        callerName: 'A',
        callerPhone: '0312345678',
        reason: null,
      });

      const { rows } = await pool.query('SELECT reason FROM callback_requests WHERE id = $1', [
        saved.id,
      ]);
      expect(rows[0]).toEqual({ reason: null });
    });

    test('refuses a row with no client_id, and an unknown status', async () => {
      await expect(
        pool.query(
          `INSERT INTO callback_requests (call_id, language, caller_name, caller_phone)
           VALUES ('k', 'ja', 'A', '0312345678')`,
        ),
      ).rejects.toThrow(/null value/);
      await expect(
        pool.query(
          `INSERT INTO callback_requests (client_id, call_id, language, caller_name, caller_phone, status)
           VALUES ('c', 'k', 'ja', 'A', '0312345678', 'lost')`,
        ),
      ).rejects.toThrow(/check constraint/);
    });

    test('handled_at is set exactly when the status is handled', async () => {
      const insert = (status: string, handledAt: string | null) =>
        pool.query(
          `INSERT INTO callback_requests (client_id, call_id, language, caller_name, caller_phone, status, handled_at)
           VALUES ('c', 'k', 'ja', 'A', '0312345678', $1, $2)`,
          [status, handledAt],
        );

      await expect(insert('handled', null)).rejects.toThrow(/check constraint/);
      await expect(insert('pending', '2026-01-01')).rejects.toThrow(/check constraint/);
      await expect(insert('handled', '2026-01-01')).resolves.toBeDefined();
    });
  });
});

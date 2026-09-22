/**
 * Needs a real Postgres (TEST_DATABASE_URL); skipped otherwise, like
 * tests/db/callTables.test.ts and tests/db/migrate.test.ts.
 * Runs the repo's own migrations in a throwaway schema.
 */
import connectPgSimple from 'connect-pg-simple';
import session from 'express-session';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { runMigrations } from '../../src/db/migrate.js';
import { hashPassword } from '../../src/lib/auth.js';
import { PgCallbackRequestRepository } from '../../src/repositories/callbackRequestRepository.js';
import { PgStaffUserRepository } from '../../src/repositories/staffUserRepository.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

const STAFF_USERS_COLUMNS = [
  'client_id',
  'created_at',
  'email',
  'id',
  'must_change_password',
  'password_hash',
  'role',
];

const SESSION_COLUMNS = ['expire', 'sess', 'sid'];

describe.skipIf(!TEST_DATABASE_URL)(
  'staff_users, session and the dashboard repository (real Postgres)',
  () => {
    const schema = `tmvp_staff_${Date.now()}_${Math.floor(Math.random() * 10_000)}`;
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
      await pool.query('DELETE FROM staff_users');
      await pool.query('DELETE FROM callback_requests');
      await pool.query('DELETE FROM session');
    });

    describe('staff_users schema', () => {
      test('has exactly the expected columns', async () => {
        expect(await columnsOf('staff_users')).toEqual(STAFF_USERS_COLUMNS);
      });

      test('defaults role to admin and must_change_password to true', async () => {
        const { rows } = await pool.query(
          `INSERT INTO staff_users (client_id, email, password_hash) VALUES ('c', 'a@example.com', 'hash')
         RETURNING role, must_change_password`,
        );
        expect(rows[0]).toEqual({ role: 'admin', must_change_password: true });
      });

      test('refuses two accounts with the same email, case-insensitively', async () => {
        await pool.query(
          `INSERT INTO staff_users (client_id, email, password_hash) VALUES ('c', 'a@example.com', 'hash')`,
        );
        await expect(
          pool.query(
            `INSERT INTO staff_users (client_id, email, password_hash) VALUES ('c', 'A@EXAMPLE.com', 'hash')`,
          ),
        ).rejects.toThrow(/unique constraint/);
      });
    });

    describe('session schema (connect-pg-simple)', () => {
      test('has exactly the columns connect-pg-simple expects', async () => {
        expect(await columnsOf('session')).toEqual(SESSION_COLUMNS);
      });

      test('a real connect-pg-simple store can set, get and destroy a session against this table', async () => {
        const PgSession = connectPgSimple(session);
        const store = new PgSession({ pool, tableName: 'session' });

        await new Promise<void>((resolve, reject) => {
          store.set(
            'sid-1',
            { cookie: { originalMaxAge: null }, staffUserId: 'staff-1' },
            (error) => (error ? reject(error as Error) : resolve()),
          );
        });

        const loaded = await new Promise<unknown>((resolve, reject) => {
          store.get('sid-1', (error, sessionData) =>
            error ? reject(error as Error) : resolve(sessionData),
          );
        });
        expect((loaded as { staffUserId?: string } | null | undefined)?.staffUserId).toBe(
          'staff-1',
        );

        await new Promise<void>((resolve, reject) => {
          store.destroy('sid-1', (error) => (error ? reject(error as Error) : resolve()));
        });
        const { rows } = await pool.query('SELECT * FROM session WHERE sid = $1', ['sid-1']);
        expect(rows).toHaveLength(0);

        store.close();
      });
    });

    describe('PgStaffUserRepository', () => {
      test('create/findByEmail/findById round-trip, and completePasswordChange flips the flag in one statement', async () => {
        const repo = new PgStaffUserRepository(pool);
        const passwordHash = await hashPassword('a-temporary-password-123');

        const created = await repo.create({
          clientId: 'sakura-seikotsuin',
          email: 'Owner@Example.com',
          passwordHash,
        });
        expect(created.mustChangePassword).toBe(true);
        expect(created.role).toBe('admin');

        const byEmail = await repo.findByEmail('owner@example.com');
        expect(byEmail?.id).toBe(created.id);

        const byId = await repo.findById(created.id);
        expect(byId?.email).toBe('Owner@Example.com');

        const newHash = await hashPassword('a-real-new-password-456');
        await repo.completePasswordChange(created.id, newHash);

        const updated = await repo.findById(created.id);
        expect(updated?.mustChangePassword).toBe(false);
        expect(updated?.passwordHash).toBe(newHash);
      });

      test('findByEmail/findById return undefined, not throw, for an unknown account', async () => {
        const repo = new PgStaffUserRepository(pool);

        expect(await repo.findByEmail('nobody@example.com')).toBeUndefined();
        expect(await repo.findById('00000000-0000-0000-0000-000000000000')).toBeUndefined();
      });
    });

    describe('PgCallbackRequestRepository — dashboard admin methods', () => {
      const insertCallback = (
        clientId: string,
        callId: string,
        status: 'pending' | 'handled' = 'pending',
      ) =>
        pool.query(
          `INSERT INTO callback_requests (client_id, call_id, language, caller_name, caller_phone, reason, status, handled_at)
         VALUES ($1, $2, 'ja', 'Hanako Yamada', '090-1234-5678', 'Asked about a treatment', $3, $4)
         RETURNING id`,
          [clientId, callId, status, status === 'handled' ? new Date() : null],
        );

      test('listByClient only returns rows for that client, newest first', async () => {
        await insertCallback('sakura-seikotsuin', 'call-1');
        await new Promise((resolve) => setTimeout(resolve, 5));
        await insertCallback('sakura-seikotsuin', 'call-2');
        await insertCallback('other-clinic', 'call-3');

        const repo = new PgCallbackRequestRepository(pool);
        const rows = await repo.listByClient('sakura-seikotsuin');

        expect(rows.map((row) => row.callId)).toEqual(['call-2', 'call-1']);
        expect(rows.every((row) => row.clientId === 'sakura-seikotsuin')).toBe(true);
      });

      test('markHandled sets status and handled_at, and is rejected for a different client', async () => {
        const { rows } = await insertCallback('sakura-seikotsuin', 'call-1');
        const id = (rows[0] as { id: string }).id;
        const repo = new PgCallbackRequestRepository(pool);

        const wrongClient = await repo.markHandled(id, 'other-clinic');
        expect(wrongClient).toBe(false);
        const stillPending = await pool.query(
          'SELECT status, handled_at FROM callback_requests WHERE id = $1',
          [id],
        );
        expect(stillPending.rows[0]).toMatchObject({ status: 'pending', handled_at: null });

        const rightClient = await repo.markHandled(id, 'sakura-seikotsuin');
        expect(rightClient).toBe(true);
        const nowHandled = await pool.query(
          'SELECT status, handled_at FROM callback_requests WHERE id = $1',
          [id],
        );
        expect(nowHandled.rows[0]?.status).toBe('handled');
        expect(nowHandled.rows[0]?.handled_at).toBeInstanceOf(Date);
      });

      test('markHandled on an unknown id returns false', async () => {
        const repo = new PgCallbackRequestRepository(pool);

        expect(
          await repo.markHandled('00000000-0000-0000-0000-000000000000', 'sakura-seikotsuin'),
        ).toBe(false);
      });
    });
  },
);

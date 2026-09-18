import { describe, expect, test } from 'vitest';

import { createPool, isDatabaseReachable, type Queryable } from '../../src/db/pool.js';

describe('isDatabaseReachable', () => {
  test('is true when the query succeeds', async () => {
    const db: Queryable = { query: () => Promise.resolve({ rows: [{ ok: 1 }] }) };

    await expect(isDatabaseReachable(db)).resolves.toBe(true);
  });

  test('is false — not thrown — when the query fails', async () => {
    const db: Queryable = { query: () => Promise.reject(new Error('ECONNREFUSED')) };

    await expect(isDatabaseReachable(db)).resolves.toBe(false);
  });
});

describe('createPool', () => {
  test('applies safe defaults so an unreachable database fails instead of hanging', async () => {
    const pool = createPool({ connectionString: 'postgres://user@localhost:1/db' });

    try {
      expect(pool.options.connectionTimeoutMillis).toBe(5_000);
      expect(pool.options.max).toBe(10);
    } finally {
      await pool.end();
    }
  });

  test('lets the caller override the timeout and pool size', async () => {
    const pool = createPool({
      connectionString: 'postgres://user@localhost:1/db',
      connectionTimeoutMillis: 250,
      max: 3,
    });

    try {
      expect(pool.options.connectionTimeoutMillis).toBe(250);
      expect(pool.options.max).toBe(3);
    } finally {
      await pool.end();
    }
  });
});

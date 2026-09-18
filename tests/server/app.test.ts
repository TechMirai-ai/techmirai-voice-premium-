import { describe, expect, test, vi } from 'vitest';
import request from 'supertest';

import { createApp } from '../../src/app.js';
import type { Queryable } from '../../src/db/pool.js';

const healthyDb: Queryable = { query: () => Promise.resolve({ rows: [{ '?column?': 1 }] }) };
const brokenDb: Queryable = {
  query: () => Promise.reject(new Error('connection refused')),
};

const app = (db: Queryable = healthyDb, isProduction = false) => createApp({ db, isProduction });

describe('GET /healthz', () => {
  test('returns 200 and {"status":"ok"} when the database answers', async () => {
    const response = await request(app()).get('/healthz');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
  });

  test('checks the database with SELECT 1', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });

    await request(app({ query })).get('/healthz');

    expect(query).toHaveBeenCalledWith('SELECT 1');
  });

  test('returns 503 when the database query fails', async () => {
    const response = await request(app(brokenDb)).get('/healthz');

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ status: 'error', error: 'database_unavailable' });
  });
});

describe('the app skeleton', () => {
  test('returns JSON 404 for an unknown route', async () => {
    const response = await request(app()).get('/no-such-route');

    expect(response.status).toBe(404);
    expect(response.headers['content-type']).toMatch(/application\/json/);
    expect(response.body).toEqual({ status: 'error', error: 'not_found' });
  });

  test('sets the helmet security headers', async () => {
    const response = await request(app()).get('/healthz');

    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-powered-by']).toBeUndefined();
  });

  test('rejects a JSON body larger than the 100kb limit', async () => {
    const response = await request(app())
      .post('/healthz')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ padding: 'x'.repeat(200_000) }));

    expect(response.status).toBe(413);
  });

  test('never leaks a stack trace when NODE_ENV=production', async () => {
    const response = await request(app(healthyDb, true))
      .post('/healthz')
      .set('Content-Type', 'application/json')
      .send('{ this is not json');

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ status: 'error', error: 'bad_request' });
    expect(JSON.stringify(response.body)).not.toMatch(/at .*\.ts/);
  });

  test('includes the message outside production, to help local debugging', async () => {
    const response = await request(app(healthyDb, false))
      .post('/healthz')
      .set('Content-Type', 'application/json')
      .send('{ this is not json');

    expect(response.status).toBe(400);
    expect((response.body as { message?: string }).message).toBeTruthy();
  });
});

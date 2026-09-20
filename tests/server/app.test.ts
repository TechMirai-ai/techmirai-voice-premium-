import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import request from 'supertest';

import { createApp } from '../../src/app.js';
import type { Queryable } from '../../src/db/pool.js';
import { writeState } from '../../src/vapi/stateStore.js';

const healthyDb: Queryable = { query: () => Promise.resolve({ rows: [{ '?column?': 1 }] }) };
const brokenDb: Queryable = {
  query: () => Promise.reject(new Error('connection refused')),
};

const VAPI_PUBLIC_KEY = 'test-vapi-public-key';

const app = (db: Queryable = healthyDb, isProduction = false, vapiStateRepoRoot?: string) =>
  createApp({
    db,
    isProduction,
    vapiPublicKey: VAPI_PUBLIC_KEY,
    ...(vapiStateRepoRoot ? { vapiStateRepoRoot } : {}),
  });

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

describe('GET /vapi-test-call', () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(path.join(tmpdir(), 'tmvp-app-state-'));
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  test('is not mounted in production, even with valid params', async () => {
    const response = await request(app(healthyDb, true, repoRoot)).get(
      '/vapi-test-call?clientId=test-clinic&language=ja',
    );

    expect(response.status).toBe(404);
  });

  test('returns 400 for a clientId that is not a valid slug (rejects injection attempts)', async () => {
    const response = await request(app(healthyDb, false, repoRoot)).get(
      '/vapi-test-call?clientId=<script>alert(1)</script>&language=ja',
    );

    expect(response.status).toBe(400);
  });

  test('renders the page, referencing the bootstrap script by src, not synced state', async () => {
    const response = await request(app(healthyDb, false, repoRoot)).get(
      '/vapi-test-call?clientId=test-clinic&language=ja',
    );

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/text\/html/);
    expect(response.text).toContain('/vapi-test-call.js?clientId=test-clinic&amp;language=ja');
  });

  test("widens the CSP script-src to allow the Vapi widget's CDN and Daily's call-object bundle, without adding unsafe-inline", async () => {
    const response = await request(app(healthyDb, false, repoRoot)).get(
      '/vapi-test-call?clientId=test-clinic&language=ja',
    );

    const csp = response.headers['content-security-policy'] as string;
    const scriptSrc = csp.split(';').find((directive) => directive.startsWith('script-src '));
    expect(scriptSrc).toBe(
      "script-src 'self' https://cdn.jsdelivr.net https://*.daily.co https://*.dailywebrtc.com https://*.dailywebrtc.net",
    );
    expect(scriptSrc).not.toContain('unsafe-inline');
    expect(scriptSrc).not.toContain('unsafe-eval');
  });

  test("widens the CSP img-src to allow the widget's icon CDN", async () => {
    const response = await request(app(healthyDb, false, repoRoot)).get(
      '/vapi-test-call?clientId=test-clinic&language=ja',
    );

    const csp = response.headers['content-security-policy'] as string;
    const imgSrc = csp.split(';').find((directive) => directive.startsWith('img-src '));
    expect(imgSrc).toBe("img-src 'self' data: https://unpkg.com");
  });

  test('widens the CSP connect-src to allow placing a Vapi web call over Daily', async () => {
    const response = await request(app(healthyDb, false, repoRoot)).get(
      '/vapi-test-call?clientId=test-clinic&language=ja',
    );

    const csp = response.headers['content-security-policy'] as string;
    const connectSrc = csp.split(';').find((directive) => directive.startsWith('connect-src '));
    expect(connectSrc).toBe(
      "connect-src 'self' https://api.vapi.ai https://*.daily.co https://*.dailywebrtc.com " +
        'https://*.dailywebrtc.net wss://*.daily.co wss://*.dailywebrtc.com ' +
        'wss://*.dailywebrtc.net https://*.ingest.sentry.io',
    );
  });

  test('widens the CSP worker-src for Daily audio-processing workers', async () => {
    const response = await request(app(healthyDb, false, repoRoot)).get(
      '/vapi-test-call?clientId=test-clinic&language=ja',
    );

    const csp = response.headers['content-security-policy'] as string;
    const workerSrc = csp.split(';').find((directive) => directive.startsWith('worker-src '));
    expect(workerSrc).toBe("worker-src 'self' blob:");
  });

  test('every other route keeps the strict default CSP unwidened', async () => {
    const response = await request(app()).get('/healthz');
    const csp = response.headers['content-security-policy'] as string;

    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain('cdn.jsdelivr.net');
    expect(csp).not.toContain('daily.co');
    expect(csp).not.toContain('sentry.io');
    expect(csp).toContain("img-src 'self' data:");
    expect(csp).not.toContain('unpkg.com');
    expect(csp).not.toContain('connect-src');
    expect(csp).not.toContain('worker-src');
    expect(csp).not.toContain('api.vapi.ai');
  });
});

describe('GET /vapi-test-call.js', () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(path.join(tmpdir(), 'tmvp-app-state-'));
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  test('is not mounted in production, even with valid params', async () => {
    writeState(
      'test-clinic',
      { tools: {}, assistants: { 'test-clinic--ja': 'assistant-uuid' } },
      { repoRoot },
    );

    const response = await request(app(healthyDb, true, repoRoot)).get(
      '/vapi-test-call.js?clientId=test-clinic&language=ja',
    );

    expect(response.status).toBe(404);
  });

  test('returns 400 for invalid query params', async () => {
    const response = await request(app(healthyDb, false, repoRoot)).get(
      '/vapi-test-call.js?clientId=<script>&language=ja',
    );

    expect(response.status).toBe(400);
  });

  test('returns 404 with guidance when no assistant has been synced yet', async () => {
    const response = await request(app(healthyDb, false, repoRoot)).get(
      '/vapi-test-call.js?clientId=test-clinic&language=ja',
    );

    expect(response.status).toBe(404);
    expect(response.text).toContain('vapi:sync');
  });

  test('serves the bootstrap script with the resolved assistant id and public key when synced', async () => {
    writeState(
      'test-clinic',
      { tools: {}, assistants: { 'test-clinic--ja': 'assistant-uuid' } },
      { repoRoot },
    );

    const response = await request(app(healthyDb, false, repoRoot)).get(
      '/vapi-test-call.js?clientId=test-clinic&language=ja',
    );

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/javascript/);
    expect(response.text).toContain('assistant-uuid');
    expect(response.text).toContain(VAPI_PUBLIC_KEY);
  });
});

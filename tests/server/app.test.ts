import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import request from 'supertest';

import { createApp } from '../../src/app.js';
import type { Queryable } from '../../src/db/pool.js';
import { generateTestPage } from '../../src/vapi/generateTestPage.js';
import { writeState } from '../../src/vapi/stateStore.js';

const healthyDb: Queryable = { query: () => Promise.resolve({ rows: [{ '?column?': 1 }] }) };
const brokenDb: Queryable = {
  query: () => Promise.reject(new Error('connection refused')),
};

const VAPI_PUBLIC_KEY = 'test-vapi-public-key';

const app = (db: Queryable = healthyDb, isProduction = false, vapiTestPageDir?: string) =>
  createApp({
    db,
    isProduction,
    ...(vapiTestPageDir ? { vapiTestPageDir } : {}),
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

describe('static /vapi-test-call', () => {
  let testPageDir: string;
  const pagePath = '/vapi-test-call/test-clinic--ja.html';

  beforeEach(() => {
    const repoRoot = mkdtempSync(path.join(tmpdir(), 'tmvp-app-state-'));
    testPageDir = path.join(repoRoot, 'public', 'vapi-test-call');
    writeState(
      'test-clinic',
      { tools: {}, assistants: { 'test-clinic--ja': 'assistant-uuid' } },
      { repoRoot },
    );
    generateTestPage({
      clientId: 'test-clinic',
      language: 'ja',
      publicKey: VAPI_PUBLIC_KEY,
      repoRoot,
      outDir: testPageDir,
    });
  });

  afterEach(() => {
    rmSync(path.dirname(path.dirname(testPageDir)), { recursive: true, force: true });
  });

  test('is not mounted in production, even for a file that exists', async () => {
    const response = await request(app(healthyDb, true, testPageDir)).get(pagePath);

    expect(response.status).toBe(404);
  });

  test('serves the pre-generated page as a static file, referencing its script by src', async () => {
    const response = await request(app(healthyDb, false, testPageDir)).get(pagePath);

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/text\/html/);
    expect(response.text).toContain('/vapi-test-call/test-clinic--ja.js');
  });

  test('serves the pre-generated bootstrap script with the baked-in assistant id and public key', async () => {
    const response = await request(app(healthyDb, false, testPageDir)).get(
      '/vapi-test-call/test-clinic--ja.js',
    );

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/javascript/);
    expect(response.text).toContain('"assistant-uuid"');
    expect(response.text).toContain(`"${VAPI_PUBLIC_KEY}"`);
  });

  test('returns the JSON 404 for a page that has not been generated', async () => {
    const response = await request(app(healthyDb, false, testPageDir)).get(
      '/vapi-test-call/other-clinic--ja.html',
    );

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ status: 'error', error: 'not_found' });
  });

  test('no longer has the old dynamic query-string routes', async () => {
    const page = await request(app(healthyDb, false, testPageDir)).get(
      '/vapi-test-call?clientId=test-clinic&language=ja',
    );
    const script = await request(app(healthyDb, false, testPageDir)).get(
      '/vapi-test-call.js?clientId=test-clinic&language=ja',
    );

    expect(page.status).toBe(404);
    expect(script.status).toBe(404);
  });

  test("widens the CSP script-src to allow the Vapi widget's CDN and Daily's call-object bundle, without adding unsafe-inline", async () => {
    const response = await request(app(healthyDb, false, testPageDir)).get(pagePath);

    const csp = response.headers['content-security-policy'] as string;
    const scriptSrc = csp.split(';').find((directive) => directive.startsWith('script-src '));
    expect(scriptSrc).toBe(
      "script-src 'self' https://cdn.jsdelivr.net https://*.daily.co https://*.dailywebrtc.com https://*.dailywebrtc.net",
    );
    expect(scriptSrc).not.toContain('unsafe-inline');
    expect(scriptSrc).not.toContain('unsafe-eval');
  });

  test("widens the CSP img-src to allow the widget's icon CDN", async () => {
    const response = await request(app(healthyDb, false, testPageDir)).get(pagePath);

    const csp = response.headers['content-security-policy'] as string;
    const imgSrc = csp.split(';').find((directive) => directive.startsWith('img-src '));
    expect(imgSrc).toBe("img-src 'self' data: https://unpkg.com");
  });

  test('widens the CSP connect-src to allow placing a Vapi web call over Daily', async () => {
    const response = await request(app(healthyDb, false, testPageDir)).get(pagePath);

    const csp = response.headers['content-security-policy'] as string;
    const connectSrc = csp.split(';').find((directive) => directive.startsWith('connect-src '));
    expect(connectSrc).toBe(
      "connect-src 'self' https://api.vapi.ai https://*.daily.co https://*.dailywebrtc.com " +
        'https://*.dailywebrtc.net wss://*.daily.co wss://*.dailywebrtc.com ' +
        'wss://*.dailywebrtc.net https://*.ingest.sentry.io',
    );
  });

  test('widens the CSP worker-src for Daily audio-processing workers', async () => {
    const response = await request(app(healthyDb, false, testPageDir)).get(pagePath);

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

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import request from 'supertest';

import { createApp } from '../../src/app.js';
import type { Queryable } from '../../src/db/pool.js';
import { generateTestPage } from '../../src/vapi/generateTestPage.js';
import { writeState } from '../../src/vapi/stateStore.js';
import { buildVoiceApp } from '../helpers/voiceFixtures.js';
import { buildStaffOptions } from '../helpers/staffFixtures.js';

const healthyDb: Queryable = { query: () => Promise.resolve({ rows: [{ '?column?': 1 }] }) };
const brokenDb: Queryable = {
  query: () => Promise.reject(new Error('connection refused')),
};

const VAPI_PUBLIC_KEY = 'test-vapi-public-key';

const app = (db: Queryable = healthyDb, isProduction = false, vapiTestPageDir?: string) =>
  createApp({
    db,
    isProduction,
    voice: buildVoiceApp().voiceOptions,
    staff: buildStaffOptions(),
    talk: { publicKey: VAPI_PUBLIC_KEY },
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
      { tools: {}, assistants: { 'test-clinic--ja': 'assistant-uuid' }, squads: {} },
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

  // A CSP on this page broke the Daily web-call join (VAPI-FACTS.md, KNOWN
  // ISSUE steps 12-13); deliberately none is sent. Guards against a
  // well-meaning "add security headers back" change silently breaking calls.
  test('sends NO Content-Security-Policy on the test-call page or script', async () => {
    const page = await request(app(healthyDb, false, testPageDir)).get(pagePath);
    const script = await request(app(healthyDb, false, testPageDir)).get(
      '/vapi-test-call/test-clinic--ja.js',
    );

    expect(page.headers['content-security-policy']).toBeUndefined();
    expect(script.headers['content-security-policy']).toBeUndefined();
  });

  test("still sends helmet's other security headers on the test-call page", async () => {
    const response = await request(app(healthyDb, false, testPageDir)).get(pagePath);

    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['cross-origin-opener-policy']).toBe('same-origin');
    expect(response.headers['x-powered-by']).toBeUndefined();
  });

  test('every other route keeps the strict default CSP', async () => {
    const health = await request(app()).get('/healthz');
    const missing = await request(app(healthyDb, false, testPageDir)).get(
      '/vapi-test-call/other-clinic--ja.html',
    );

    for (const response of [health, missing]) {
      const csp = response.headers['content-security-policy'] as string;
      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain("script-src 'self'");
      expect(csp).not.toContain('cdn.jsdelivr.net');
      expect(csp).not.toContain('daily.co');
    }
  });
});

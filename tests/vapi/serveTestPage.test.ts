import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import request from 'supertest';

import { createTestPageServer } from '../../src/vapi/serveTestPage.js';

describe('createTestPageServer', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'tmvp-servepage-'));
    writeFileSync(path.join(dir, 'test-clinic--ja.html'), '<html>page</html>');
    writeFileSync(path.join(dir, 'test-clinic--ja.js'), 'window.x = "assistant-uuid";');
    writeFileSync(path.join(dir, 'secret.txt'), 'nope');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('serves the generated page with an HTML content type', async () => {
    const response = await request(createTestPageServer(dir)).get(
      '/vapi-test-call/test-clinic--ja.html',
    );

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(response.text).toBe('<html>page</html>');
  });

  test('serves the bootstrap script with a JavaScript content type', async () => {
    const response = await request(createTestPageServer(dir)).get(
      '/vapi-test-call/test-clinic--ja.js',
    );

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/javascript/);
    expect(response.text).toContain('assistant-uuid');
  });

  test('sends no Express/helmet headers — no CSP, no ETag', async () => {
    const response = await request(createTestPageServer(dir)).get(
      '/vapi-test-call/test-clinic--ja.html',
    );

    expect(response.headers['content-security-policy']).toBeUndefined();
    expect(response.headers['etag']).toBeUndefined();
    expect(response.headers['x-powered-by']).toBeUndefined();
  });

  test('returns 404 with guidance for a page that has not been generated', async () => {
    const response = await request(createTestPageServer(dir)).get(
      '/vapi-test-call/other-clinic--ja.html',
    );

    expect(response.status).toBe(404);
    expect(response.text).toContain('vapi:test-page');
  });

  test('refuses anything outside the flat generated file names (traversal, other extensions)', async () => {
    const server = createTestPageServer(dir);

    for (const url of [
      '/vapi-test-call/secret.txt',
      '/vapi-test-call/../secret.txt',
      '/vapi-test-call/..%2Fsecret.txt',
      '/vapi-test-call/',
      '/etc/passwd',
      '/',
    ]) {
      const response = await request(server).get(url);
      expect(response.status, url).toBe(404);
    }
  });

  test('rejects non-GET/HEAD methods', async () => {
    const response = await request(createTestPageServer(dir)).post(
      '/vapi-test-call/test-clinic--ja.html',
    );

    expect(response.status).toBe(405);
  });
});

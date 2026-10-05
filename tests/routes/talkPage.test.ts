import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import request from 'supertest';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { createApp } from '../../src/app.js';
import type { Queryable } from '../../src/db/pool.js';
import { writeState } from '../../src/vapi/stateStore.js';
import { buildStaffOptions } from '../helpers/staffFixtures.js';
import { buildVoiceApp } from '../helpers/voiceFixtures.js';
import { readSakuraDocument, withChanges, writeClientFixture } from '../helpers/clientFixtures.js';

const healthyDb: Queryable = { query: () => Promise.resolve({ rows: [{ ok: 1 }] }) };
const PUBLIC_KEY = 'test-vapi-public-key';
const JA_ASSISTANT_ID = 'ja-assistant-uuid';
const EN_ASSISTANT_ID = 'en-assistant-uuid';

describe('GET /talk', () => {
  let clientsDir: string;
  let cleanupClient: () => void;
  let repoRoot: string;

  beforeEach(() => {
    const document = withChanges(readSakuraDocument(), (draft) => {
      draft.clientId = 'demo-clinic';
      draft.business.name = { ja: 'テスト整骨院', en: 'Test Clinic' };
    });
    const fixture = writeClientFixture('demo-clinic', document);
    clientsDir = fixture.clientsDir;
    cleanupClient = fixture.cleanup;

    repoRoot = mkdtempSync(path.join(tmpdir(), 'tmvp-talk-state-'));
    writeState(
      'demo-clinic',
      {
        tools: {},
        assistants: {
          'demo-clinic--ja': JA_ASSISTANT_ID,
          'demo-clinic--en': EN_ASSISTANT_ID,
        },
        squads: {},
      },
      { repoRoot },
    );
  });

  afterEach(() => {
    cleanupClient();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const app = (isProduction = false, stateRepoRoot: string = repoRoot) =>
    createApp({
      db: healthyDb,
      isProduction,
      voice: buildVoiceApp().voiceOptions,
      staff: buildStaffOptions(),
      talk: { publicKey: PUBLIC_KEY, clientsDir, repoRoot: stateRepoRoot },
    });

  test("renders the clinic's own name and a Talk button", async () => {
    const response = await request(app()).get('/talk/demo-clinic/ja');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/text\/html/);
    expect(response.text).toContain('テスト整骨院');
    expect(response.text).toContain('id="talk-button"');
  });

  test('never shows the internal clientId slug in the page title, heading, or link text — only in the shareable URL itself', async () => {
    const response = await request(app()).get('/talk/demo-clinic/ja');

    const title = response.text.match(/<title>(.*?)<\/title>/)?.[1] ?? '';
    const heading = response.text.match(/<h1>(.*?)<\/h1>/)?.[1] ?? '';
    const linkText = [...response.text.matchAll(/<a[^>]*>(.*?)<\/a>/g)].map((m) => m[1]).join(' ');

    expect(`${title} ${heading} ${linkText}`).not.toContain('demo-clinic');
  });

  test('links to the other supported language, labeled with its own clinic name', async () => {
    const response = await request(app()).get('/talk/demo-clinic/ja');

    expect(response.text).toContain('href="/talk/demo-clinic/en"');
    expect(response.text).toContain('Test Clinic');
  });

  test('serves the bootstrap script with the real assistant id and public key', async () => {
    const response = await request(app()).get('/talk/demo-clinic/ja/bootstrap.js');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/javascript/);
    expect(response.text).toContain(`"${JA_ASSISTANT_ID}"`);
    expect(response.text).toContain(`"${PUBLIC_KEY}"`);
  });

  test('serves the other language from the same clientId, with its own assistant id', async () => {
    const response = await request(app()).get('/talk/demo-clinic/en/bootstrap.js');

    expect(response.status).toBe(200);
    expect(response.text).toContain(`"${EN_ASSISTANT_ID}"`);
  });

  test('works identically when isProduction is true — unlike the internal QA page', async () => {
    const page = await request(app(true)).get('/talk/demo-clinic/ja');
    const script = await request(app(true)).get('/talk/demo-clinic/ja/bootstrap.js');

    expect(page.status).toBe(200);
    expect(script.status).toBe(200);
  });

  test('returns the JSON 404 for an unknown clientId', async () => {
    const response = await request(app()).get('/talk/no-such-clinic/ja');

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ status: 'error', error: 'not_found' });
  });

  test('returns the JSON 404 for a language the client does not support', async () => {
    const response = await request(app()).get('/talk/demo-clinic/fr');

    expect(response.status).toBe(404);
  });

  test('returns the JSON 404 for a supported language that has not been synced yet', async () => {
    const unsyncedRepoRoot = mkdtempSync(path.join(tmpdir(), 'tmvp-talk-unsynced-'));
    // No writeState() call at all — demo-clinic is configured for ja+en, but
    // neither has ever been synced to Vapi, so the state file is absent.
    try {
      const response = await request(app(false, unsyncedRepoRoot)).get('/talk/demo-clinic/en');
      expect(response.status).toBe(404);
    } finally {
      rmSync(unsyncedRepoRoot, { recursive: true, force: true });
    }
  });

  test('sends NO Content-Security-Policy on the talk page or its script', async () => {
    const page = await request(app()).get('/talk/demo-clinic/ja');
    const script = await request(app()).get('/talk/demo-clinic/ja/bootstrap.js');

    expect(page.headers['content-security-policy']).toBeUndefined();
    expect(script.headers['content-security-policy']).toBeUndefined();
  });

  test("still sends helmet's other security headers on the talk page", async () => {
    const response = await request(app()).get('/talk/demo-clinic/ja');

    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-powered-by']).toBeUndefined();
  });

  test('every other route keeps the strict default CSP', async () => {
    const response = await request(app()).get('/healthz');

    const csp = response.headers['content-security-policy'] as string;
    expect(csp).toContain("default-src 'self'");
  });
});

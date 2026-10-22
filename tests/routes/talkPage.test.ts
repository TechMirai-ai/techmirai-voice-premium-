import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import request from 'supertest';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { createApp } from '../../src/app.js';
import type { Queryable } from '../../src/db/pool.js';
import { writeState } from '../../src/vapi/stateStore.js';
import { MemoryPriorCalls } from '../helpers/priorCallFixtures.js';
import { buildStaffOptions } from '../helpers/staffFixtures.js';
import { buildVoiceApp } from '../helpers/voiceFixtures.js';
import { readSakuraDocument, withChanges, writeClientFixture } from '../helpers/clientFixtures.js';

const healthyDb: Queryable = { query: () => Promise.resolve({ rows: [{ ok: 1 }] }) };
const PUBLIC_KEY = 'test-vapi-public-key';
const JA_ASSISTANT_ID = 'ja-assistant-uuid';
const EN_ASSISTANT_ID = 'en-assistant-uuid';
const RATE_LIMIT_SECRET = 'test-talk-rate-limit-secret-0123456789';
const BYPASS_KEY = 'test-talk-bypass-key';
const PHONE_BODY = { callerPhone: '090-1234-5678' };
const NORMALISED_PHONE = '09012345678';

describe('GET /talk', () => {
  let clientsDir: string;
  let cleanupClient: () => void;
  let repoRoot: string;
  let priorCalls: MemoryPriorCalls;

  beforeEach(() => {
    priorCalls = new MemoryPriorCalls();
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
        structuredOutputs: {},
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
      talk: {
        publicKey: PUBLIC_KEY,
        rateLimitSecret: RATE_LIMIT_SECRET,
        bypassKey: BYPASS_KEY,
        isProduction,
        callLogs: priorCalls,
        clientsDir,
        repoRoot: stateRepoRoot,
      },
    });

  test('renders a required phone field before the Talk button, on the public and the key link', async () => {
    for (const url of ['/talk/demo-clinic/ja', `/talk/demo-clinic/ja?key=${BYPASS_KEY}`]) {
      const { text } = await request(app()).get(url);
      expect(text).toContain('id="caller-phone"');
      expect(text).toMatch(/<input[^>]*id="caller-phone"[^>]*type="tel"/);
      expect(text.indexOf('id="caller-phone"')).toBeLessThan(text.indexOf('id="talk-button"'));
    }
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

  test('serves the bootstrap script with the public key and the gated calls URL — never a raw assistant id', async () => {
    const response = await request(app()).get('/talk/demo-clinic/ja/bootstrap.js');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/javascript/);
    expect(response.text).toContain(`"${PUBLIC_KEY}"`);
    expect(response.text).toContain('"/talk/demo-clinic/ja/calls"');
    expect(response.text).not.toContain(JA_ASSISTANT_ID);
    expect(response.text).not.toContain(EN_ASSISTANT_ID);
  });

  test('serves the other language from the same clientId, with its own calls URL', async () => {
    const response = await request(app()).get('/talk/demo-clinic/en/bootstrap.js');

    expect(response.status).toBe(200);
    expect(response.text).toContain('"/talk/demo-clinic/en/calls"');
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

  describe('POST /talk/:clientId/:language/calls', () => {
    test('a fresh visitor is allowed and gets the real assistant id plus the maximum Vapi call duration (no 5-minute cap)', async () => {
      const response = await request(app()).post('/talk/demo-clinic/ja/calls').send(PHONE_BODY);

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        assistantId: JA_ASSISTANT_ID,
        maxDurationSeconds: 43200,
        callsRemaining: 3,
        variableValues: { callerPhone: NORMALISED_PHONE, priorCall: 'none' },
      });
      expect(response.headers['set-cookie']?.[0]).toContain('tmvp_talk_calls_demo-clinic=');
    });

    test('reports one fewer remaining call after each call, down to 0 on the last allowed one', async () => {
      const agent = request.agent(app());
      const remaining: number[] = [];
      for (let i = 0; i < 4; i++) {
        const ok = await agent.post('/talk/demo-clinic/ja/calls').send(PHONE_BODY);
        remaining.push(ok.body.callsRemaining);
      }

      expect(remaining).toEqual([3, 2, 1, 0]);
    });

    test('the bypass link gets no callsRemaining (no cap applies)', async () => {
      const response = await request(app())
        .post(`/talk/demo-clinic/ja/calls?key=${BYPASS_KEY}`)
        .send(PHONE_BODY);

      expect(response.body).not.toHaveProperty('callsRemaining');
    });

    test('the page shows the calls left for this browser, updating as calls are used', async () => {
      const agent = request.agent(app());
      const fresh = await agent.get('/talk/demo-clinic/en');
      await agent.post('/talk/demo-clinic/en/calls').send(PHONE_BODY);
      await agent.post('/talk/demo-clinic/en/calls').send(PHONE_BODY);
      const afterTwo = await agent.get('/talk/demo-clinic/en');
      const bypass = await request(app()).get(`/talk/demo-clinic/en?key=${BYPASS_KEY}`);

      expect(fresh.text).toContain('4 of 4 demo calls remaining');
      expect(afterTwo.text).toContain('2 of 4 demo calls remaining');
      expect(bypass.text).not.toContain('demo calls remaining');
    });

    test('blocks the 5th call once the cookie shows the cap already reached, with no cookie set', async () => {
      const agent = request.agent(app());
      for (let i = 0; i < 4; i++) {
        const ok = await agent.post('/talk/demo-clinic/ja/calls').send(PHONE_BODY);
        expect(ok.status).toBe(200);
      }

      const blocked = await agent.post('/talk/demo-clinic/ja/calls').send(PHONE_BODY);

      expect(blocked.status).toBe(429);
      expect(blocked.body).toEqual({ status: 'error', error: 'rate_limited', callsRemaining: 0 });
      expect(blocked.headers['set-cookie']).toBeUndefined();
    });

    test('the cap is shared across languages for the same clinic (switching ja/en does not reset it)', async () => {
      const agent = request.agent(app());
      await agent.post('/talk/demo-clinic/ja/calls').send(PHONE_BODY);
      await agent.post('/talk/demo-clinic/en/calls').send(PHONE_BODY);
      await agent.post('/talk/demo-clinic/ja/calls').send(PHONE_BODY);
      await agent.post('/talk/demo-clinic/en/calls').send(PHONE_BODY);

      const blocked = await agent.post('/talk/demo-clinic/ja/calls').send(PHONE_BODY);

      expect(blocked.status).toBe(429);
    });

    test('the owner/staff bypass key skips the cap entirely, even after it has been reached', async () => {
      const agent = request.agent(app());
      for (let i = 0; i < 4; i++) {
        await agent.post('/talk/demo-clinic/ja/calls').send(PHONE_BODY);
      }

      const bypassed = await agent
        .post(`/talk/demo-clinic/ja/calls?key=${BYPASS_KEY}`)
        .send(PHONE_BODY);

      expect(bypassed.status).toBe(200);
      expect(bypassed.body.assistantId).toBe(JA_ASSISTANT_ID);
    });

    test('a wrong key is rejected and falls back to the normal cap check', async () => {
      const response = await request(app())
        .post('/talk/demo-clinic/ja/calls?key=not-the-real-key')
        .send(PHONE_BODY);

      expect(response.status).toBe(200);
      expect(response.headers['set-cookie']?.[0]).toContain('tmvp_talk_calls_demo-clinic=');
    });

    describe('caller phone and returning-caller lookup (VP-15)', () => {
      test('rejects a missing or malformed number with 400 and does NOT use up a call', async () => {
        const agent = request.agent(app());
        for (const body of [
          undefined,
          {},
          { callerPhone: '' },
          { callerPhone: 'abc' },
          { callerPhone: 123 },
        ]) {
          const response = await agent.post('/talk/demo-clinic/ja/calls').send(body);
          expect(response.status).toBe(400);
          expect(response.body).toEqual({ status: 'error', error: 'invalid_phone' });
          expect(response.headers['set-cookie']).toBeUndefined();
        }
        for (let i = 0; i < 4; i++) {
          expect((await agent.post('/talk/demo-clinic/ja/calls').send(PHONE_BODY)).status).toBe(
            200,
          );
        }
      });

      test('a number with an earlier call gets its status and summary as the priorCall variable', async () => {
        priorCalls.seed('demo-clinic', NORMALISED_PHONE, {
          status: 'needs_callback',
          summary: 'asked about hours, requested staff follow-up',
          occurredAt: new Date('2026-10-10T03:00:00Z'),
        });

        const response = await request(app()).post('/talk/demo-clinic/ja/calls').send(PHONE_BODY);

        expect(response.body.variableValues).toEqual({
          callerPhone: NORMALISED_PHONE,
          priorCall:
            'Last call: 2026-10-10, status: needs_callback, summary: asked about hours, requested staff follow-up',
        });
        expect(priorCalls.lookups).toEqual([
          { clientId: 'demo-clinic', callerPhone: NORMALISED_PHONE },
        ]);
      });

      test('a returning caller gets the welcome-back greeting as a per-call firstMessage override, clinic name filled, no topic', async () => {
        priorCalls.seed('demo-clinic', NORMALISED_PHONE, {
          status: 'needs_callback',
          summary: 'asked about opening hours',
          occurredAt: new Date('2026-10-10T03:00:00Z'),
        });

        const ja = await request(app()).post('/talk/demo-clinic/ja/calls').send(PHONE_BODY);
        const en = await request(app()).post('/talk/demo-clinic/en/calls').send(PHONE_BODY);

        expect(ja.body.firstMessage).toContain('再度のお電話ありがとうございます');
        expect(ja.body.firstMessage).toContain('テスト整骨院');
        expect(en.body.firstMessage).toContain('Welcome back to');
        expect(en.body.firstMessage).toContain('This call is recorded');
        for (const body of [ja.body, en.body]) {
          expect(body.firstMessage).not.toMatch(/\[\[|opening hours|callback/i);
        }
      });

      test('a new caller gets no firstMessage override (the saved greeting plays unchanged)', async () => {
        const response = await request(app()).post('/talk/demo-clinic/ja/calls').send(PHONE_BODY);
        expect(response.body).not.toHaveProperty('firstMessage');
      });

      test("a different number does not see someone else's call", async () => {
        priorCalls.seed('demo-clinic', NORMALISED_PHONE, {
          status: 'resolved_by_ai',
          summary: 'x',
          occurredAt: new Date(),
        });

        const response = await request(app())
          .post('/talk/demo-clinic/ja/calls')
          .send({ callerPhone: '080-0000-1111' });

        expect(response.body.variableValues.priorCall).toBe('none');
      });

      test('the bypass-key link collects and looks up the number the same way', async () => {
        const response = await request(app())
          .post(`/talk/demo-clinic/ja/calls?key=${BYPASS_KEY}`)
          .send(PHONE_BODY);
        expect(response.body.variableValues.callerPhone).toBe(NORMALISED_PHONE);
      });

      test('a failing lookup never blocks the call: the caller is treated as new', async () => {
        priorCalls.failWith = new Error('db down');

        const response = await request(app()).post('/talk/demo-clinic/ja/calls').send(PHONE_BODY);

        expect(response.status).toBe(200);
        expect(response.body.variableValues.priorCall).toBe('none');
      });
    });

    test('returns the JSON 404 for an unknown clientId', async () => {
      const response = await request(app()).post('/talk/no-such-clinic/ja/calls').send(PHONE_BODY);

      expect(response.status).toBe(404);
    });
  });
});

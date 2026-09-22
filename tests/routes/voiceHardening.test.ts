import request from 'supertest';
import { describe, expect, test } from 'vitest';

import { MAX_TOOL_CALLS_PER_REQUEST } from '../../src/routes/voiceWebhook.js';
import { createApp } from '../../src/app.js';
import { loadEnv } from '../../src/env.js';
import {
  AUTH,
  buildVoiceApp,
  CALLER_NAME,
  CALLER_PHONE,
  healthyDb,
  toolCallsBody,
  WEBHOOK_SECRET,
} from '../helpers/voiceFixtures.js';
import { buildStaffOptions } from '../helpers/staffFixtures.js';

const CALLBACK = '/api/voice/callback-request';
const args = { callerName: CALLER_NAME, callerPhone: CALLER_PHONE };

describe('voice route hardening (security review)', () => {
  test('a bare secret with no Bearer scheme is rejected', async () => {
    const { app } = buildVoiceApp();

    const response = await request(app)
      .post(CALLBACK)
      .set('Authorization', WEBHOOK_SECRET)
      .send(toolCallsBody('request_callback', args));

    expect(response.status).toBe(401);
  });

  test('bad JSON is throttled and 401s before it is parsed — a flood of it hits the limiter', async () => {
    const { app } = buildVoiceApp({ rateLimit: { max: 2, windowMs: 60_000 } });
    const send = () =>
      request(app).post(CALLBACK).set('Content-Type', 'application/json').send('{ not json');

    const statuses = [(await send()).status, (await send()).status, (await send()).status];

    expect(statuses).toEqual([401, 401, 429]);
  });

  test('a real-sized tool-calls payload (30kb) is accepted, not refused', async () => {
    const { app } = buildVoiceApp();

    const response = await request(app)
      .post(CALLBACK)
      .set(AUTH)
      .set('Content-Type', 'application/json')
      .send(toolCallsBody('request_callback', { ...args, reason: 'x'.repeat(30_000) }));

    expect(response.status).not.toBe(413);
  });

  test('a body over the 2mb ceiling is refused even when authenticated', async () => {
    const { app } = buildVoiceApp();

    const response = await request(app)
      .post(CALLBACK)
      .set(AUTH)
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ pad: 'x'.repeat(3_000_000) }));

    expect(response.status).toBe(413);
  });

  test('a resolver that throws still yields an error result in Vapi shape, not a 500', async () => {
    const { voiceOptions, callbacks } = buildVoiceApp();
    const app = createApp({
      db: healthyDb,
      isProduction: false,
      voice: {
        ...voiceOptions,
        resolver: {
          resolve: () => {
            throw new SyntaxError('corrupt state file');
          },
        },
      },
      staff: buildStaffOptions(),
    });

    const response = await request(app)
      .post(CALLBACK)
      .set(AUTH)
      .send(toolCallsBody('request_callback', args));

    expect(response.status).toBe(200);
    expect(response.body.results[0].error).toBeDefined();
    expect(callbacks.saved).toEqual([]);
  });

  test('an oversized tool-call list is capped', async () => {
    const { app, callbacks } = buildVoiceApp();
    const body = toolCallsBody('request_callback', args);
    const one = body.message.toolCallList[0]!;
    body.message.toolCallList = Array.from({ length: 50 }, (_, index) => ({
      ...one,
      id: `tc-${index}`,
    }));

    const response = await request(app).post(CALLBACK).set(AUTH).send(body);

    expect(response.body.results).toHaveLength(MAX_TOOL_CALLS_PER_REQUEST);
    expect(callbacks.saved).toHaveLength(MAX_TOOL_CALLS_PER_REQUEST);
  });
});

describe('production must declare its proxy topology', () => {
  const base = {
    NODE_ENV: 'production',
    PORT: '3000',
    DATABASE_URL: 'postgres://x',
    PUBLIC_BASE_URL: 'https://example.com',
    VAPI_API_KEY: 'k',
    VAPI_PUBLIC_KEY: 'p',
    VAPI_WEBHOOK_SECRET: 'a-long-enough-secret-value',
    VAPI_SERVER_CREDENTIAL_ID: 'c',
    SESSION_SECRET: 'test-session-secret-0123456789-0123456789',
  };

  test('fails at startup without TRUST_PROXY_HOPS', () => {
    expect(() => loadEnv(base, { readDotenvFile: false })).toThrow(/TRUST_PROXY_HOPS/);
  });

  test('accepts 0 explicitly', () => {
    expect(
      loadEnv({ ...base, TRUST_PROXY_HOPS: '0' }, { readDotenvFile: false }).TRUST_PROXY_HOPS,
    ).toBe(0);
  });
});

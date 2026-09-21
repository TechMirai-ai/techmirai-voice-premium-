import request from 'supertest';
import { describe, expect, test } from 'vitest';

import {
  AUTH,
  buildVoiceApp,
  CALL_ID,
  CALLER_NAME,
  CALLER_PHONE,
  CLIENT_ID,
  toolCallsBody,
  TOOL_CALL_ID,
  WEBHOOK_SECRET,
} from '../helpers/voiceFixtures.js';

const CALLBACK = '/api/voice/callback-request';
const TOPIC = '/api/voice/call-topic';

const callbackArgs = {
  callerName: CALLER_NAME,
  callerPhone: CALLER_PHONE,
  reason: 'Asked about a treatment we do not list',
};

describe.each([
  ['callback-request', CALLBACK, 'request_callback', callbackArgs],
  ['call-topic', TOPIC, 'log_call_topic', { topic: 'hours', outcome: 'resolved' }],
])('authentication — %s', (_label, path, tool, args) => {
  const body = toolCallsBody(tool, args);

  test('rejects a request with no credentials', async () => {
    const { app } = buildVoiceApp();

    const response = await request(app).post(path).send(body);

    expect(response.status).toBe(401);
  });

  test('rejects a wrong bearer token', async () => {
    const { app } = buildVoiceApp();

    const response = await request(app)
      .post(path)
      .set('Authorization', 'Bearer not-the-secret')
      .send(body);

    expect(response.status).toBe(401);
  });

  test('rejects an empty bearer token', async () => {
    const { app } = buildVoiceApp();

    const response = await request(app).post(path).set('Authorization', 'Bearer ').send(body);

    expect(response.status).toBe(401);
  });

  test('accepts the correct bearer token', async () => {
    const { app } = buildVoiceApp();

    const response = await request(app).post(path).set(AUTH).send(body);

    expect(response.status).toBe(200);
  });

  test('never touches the database when unauthenticated', async () => {
    const { app, callbacks, topics } = buildVoiceApp();

    await request(app).post(path).send(body);

    expect(callbacks.saved).toEqual([]);
    expect(topics.recorded).toEqual([]);
  });
});

describe.each([
  ['callback-request', CALLBACK],
  ['call-topic', TOPIC],
])('malformed payloads — %s', (_label, path) => {
  test.each([
    ['an empty object', {}],
    ['a non-tool-calls message', { message: { type: 'status-update', call: { id: 'c' } } }],
    ['a message with no call id', { message: { type: 'tool-calls' } }],
    ['an array', []],
  ])('answers %s with a 400, not a crash', async (_name, body) => {
    const { app } = buildVoiceApp();

    const response = await request(app).post(path).set(AUTH).send(body);

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ status: 'error', error: 'bad_request' });
  });

  test('answers unparseable JSON with a 400', async () => {
    const { app } = buildVoiceApp();

    const response = await request(app)
      .post(path)
      .set(AUTH)
      .set('Content-Type', 'application/json')
      .send('{ not json');

    expect(response.status).toBe(400);
  });
});

describe('POST /api/voice/callback-request', () => {
  test.each(['sdk', 'docs'] as const)(
    "saves the callback and answers in Vapi's shape (%s envelope)",
    async (shape) => {
      const { app, callbacks } = buildVoiceApp();

      const response = await request(app)
        .post(CALLBACK)
        .set(AUTH)
        .send(toolCallsBody('request_callback', callbackArgs, shape));

      expect(response.status).toBe(200);
      expect(response.body.results).toHaveLength(1);
      expect(response.body.results[0]).toMatchObject({
        name: 'request_callback',
        toolCallId: TOOL_CALL_ID,
      });
      expect(response.body.results[0].result).toMatch(/saved/i);
      expect(response.body.results[0].result).not.toMatch(/[\r\n]/);
      expect(callbacks.saved).toEqual([
        {
          clientId: CLIENT_ID,
          callId: CALL_ID,
          language: 'ja',
          callerName: CALLER_NAME,
          callerPhone: CALLER_PHONE,
          reason: callbackArgs.reason,
        },
      ]);
    },
  );

  test('derives client, language and call id from the webhook, ignoring any model-supplied ones', async () => {
    const { app, callbacks } = buildVoiceApp();

    await request(app)
      .post(CALLBACK)
      .set(AUTH)
      .send(
        toolCallsBody('request_callback', {
          ...callbackArgs,
          clientId: 'someone-else',
          language: 'en',
          callId: 'forged',
        }),
      );

    expect(callbacks.saved[0]).toMatchObject({
      clientId: CLIENT_ID,
      language: 'ja',
      callId: CALL_ID,
    });
  });

  test('resolves the assistant by name alone when its id is absent', async () => {
    const { app, callbacks } = buildVoiceApp();

    await request(app)
      .post(CALLBACK)
      .set(AUTH)
      .send(
        toolCallsBody('request_callback', callbackArgs, 'sdk', {
          assistant: { name: 'sakura-seikotsuin--ja' },
        }),
      );

    expect(callbacks.saved).toHaveLength(1);
  });

  test('normalizes full-width digits and stores a null reason when none is given', async () => {
    const { app, callbacks } = buildVoiceApp();

    await request(app)
      .post(CALLBACK)
      .set(AUTH)
      .send(
        toolCallsBody('request_callback', {
          callerName: '山田 花子',
          callerPhone: '０９０－１２３４－５６７８',
        }),
      );

    expect(callbacks.saved[0]).toMatchObject({
      callerName: '山田 花子',
      callerPhone: '090-1234-5678',
      reason: null,
    });
  });

  test.each([
    ['a missing name', { callerPhone: CALLER_PHONE }, 'callerName'],
    ['a blank name', { callerName: '   ', callerPhone: CALLER_PHONE }, 'callerName'],
    ['a missing phone', { callerName: CALLER_NAME }, 'callerPhone'],
    ['a too-short phone', { callerName: CALLER_NAME, callerPhone: '123' }, 'callerPhone'],
    [
      'a phone with letters only',
      { callerName: CALLER_NAME, callerPhone: 'call me' },
      'callerPhone',
    ],
  ])(
    'answers %s with an error result telling the model to re-ask, and saves nothing',
    async (_n, args, field) => {
      const { app, callbacks } = buildVoiceApp();

      const response = await request(app)
        .post(CALLBACK)
        .set(AUTH)
        .send(toolCallsBody('request_callback', args));

      expect(response.status).toBe(200);
      expect(response.body.results[0].error).toContain(field);
      expect(response.body.results[0].result).toBeUndefined();
      expect(callbacks.saved).toEqual([]);
    },
  );

  test('a database failure still answers 200 with an error result, never a raw 500', async () => {
    const { app, callbacks } = buildVoiceApp();
    callbacks.failWith = new Error('connection terminated unexpectedly');

    const response = await request(app)
      .post(CALLBACK)
      .set(AUTH)
      .send(toolCallsBody('request_callback', callbackArgs));

    expect(response.status).toBe(200);
    expect(response.body.results).toEqual([
      {
        name: 'request_callback',
        toolCallId: TOOL_CALL_ID,
        error: expect.any(String),
      },
    ]);
    expect(response.body.results[0].error).not.toMatch(/connection terminated/);
  });

  test('an unrecognised assistant gets an error result and nothing is saved', async () => {
    const { app, callbacks } = buildVoiceApp();

    const response = await request(app)
      .post(CALLBACK)
      .set(AUTH)
      .send(
        toolCallsBody('request_callback', callbackArgs, 'sdk', {
          assistant: { id: 'unknown', name: 'other--ja' },
        }),
      );

    expect(response.status).toBe(200);
    expect(response.body.results[0].error).toBeDefined();
    expect(callbacks.saved).toEqual([]);
  });

  test('a request naming a different tool produces no result for it', async () => {
    const { app, callbacks } = buildVoiceApp();

    const response = await request(app)
      .post(CALLBACK)
      .set(AUTH)
      .send(toolCallsBody('something_else', callbackArgs));

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ results: [] });
    expect(callbacks.saved).toEqual([]);
  });

  test('notifies after saving', async () => {
    const { app, notifier } = buildVoiceApp();

    await request(app)
      .post(CALLBACK)
      .set(AUTH)
      .send(toolCallsBody('request_callback', callbackArgs));
    await new Promise((resolve) => setImmediate(resolve));

    expect(notifier.notified).toHaveLength(1);
    expect(notifier.notified[0]).toMatchObject({ clientId: CLIENT_ID, callId: CALL_ID });
  });

  test('the callback is still saved and answered successfully when the notifier throws', async () => {
    const { app, callbacks, notifier } = buildVoiceApp();
    notifier.failWith = new Error('smtp down');

    const response = await request(app)
      .post(CALLBACK)
      .set(AUTH)
      .send(toolCallsBody('request_callback', callbackArgs));

    expect(response.status).toBe(200);
    expect(response.body.results[0].result).toMatch(/saved/i);
    expect(callbacks.saved).toHaveLength(1);
  });
});

describe('POST /api/voice/call-topic', () => {
  test.each([
    ['a FAQ id', 'insurance', 'resolved'],
    ['other', 'other', 'resolved'],
    ['unresolved', 'unresolved', 'unresolved'],
    ['emergency', 'emergency', 'emergency'],
  ])('records %s', async (_label, topic, outcome) => {
    const { app, topics } = buildVoiceApp();

    const response = await request(app)
      .post(TOPIC)
      .set(AUTH)
      .send(toolCallsBody('log_call_topic', { topic, outcome }));

    expect(response.status).toBe(200);
    expect(response.body.results[0]).toMatchObject({ toolCallId: TOOL_CALL_ID, result: 'Logged.' });
    expect(topics.recorded).toEqual([
      { clientId: CLIENT_ID, callId: CALL_ID, topic, outcome, language: 'ja' },
    ]);
  });

  test.each([
    ['a topic that is not a FAQ id', { topic: 'astrology', outcome: 'resolved' }],
    [
      'free text in place of a topic',
      { topic: 'Hanako called about her knee', outcome: 'resolved' },
    ],
    ['an unknown outcome', { topic: 'hours', outcome: 'maybe' }],
    ['a missing outcome', { topic: 'hours' }],
  ])('rejects %s and logs nothing', async (_label, args) => {
    const { app, topics } = buildVoiceApp();

    const response = await request(app)
      .post(TOPIC)
      .set(AUTH)
      .send(toolCallsBody('log_call_topic', args));

    expect(response.status).toBe(200);
    expect(response.body.results[0].error).toBeDefined();
    expect(topics.recorded).toEqual([]);
  });

  test('ignores personal-data fields a model might add — only topic and outcome are stored', async () => {
    const { app, topics } = buildVoiceApp();

    await request(app)
      .post(TOPIC)
      .set(AUTH)
      .send(
        toolCallsBody('log_call_topic', {
          topic: 'hours',
          outcome: 'resolved',
          callerName: CALLER_NAME,
          callerPhone: CALLER_PHONE,
        }),
      );

    expect(Object.keys(topics.recorded[0] ?? {}).sort()).toEqual(
      ['callId', 'clientId', 'language', 'outcome', 'topic'].sort(),
    );
    expect(JSON.stringify(topics.recorded)).not.toContain(CALLER_NAME);
  });

  test('a database failure still answers 200 with an error result', async () => {
    const { app, topics } = buildVoiceApp();
    topics.failWith = new Error('db down');

    const response = await request(app)
      .post(TOPIC)
      .set(AUTH)
      .send(toolCallsBody('log_call_topic', { topic: 'hours', outcome: 'resolved' }));

    expect(response.status).toBe(200);
    expect(response.body.results[0].error).toBeDefined();
  });
});

describe('rate limiting', () => {
  test('answers 429 once a burst exceeds the limit, on both routes', async () => {
    const { app } = buildVoiceApp({ rateLimit: { max: 5, windowMs: 60_000 } });
    const body = toolCallsBody('log_call_topic', { topic: 'hours', outcome: 'resolved' });

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const path = attempt % 2 === 0 ? TOPIC : CALLBACK;
      statuses.push((await request(app).post(path).set(AUTH).send(body)).status);
    }

    expect(statuses.slice(0, 5).every((status) => status === 200)).toBe(true);
    expect(statuses.slice(5)).toEqual([429, 429, 429]);
  });

  test('throttles unauthenticated guessing too (limit applies before auth)', async () => {
    const { app } = buildVoiceApp({ rateLimit: { max: 3, windowMs: 60_000 } });

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      statuses.push(
        (await request(app).post(CALLBACK).set('Authorization', `Bearer guess-${attempt}`).send({}))
          .status,
      );
    }

    expect(statuses).toEqual([401, 401, 401, 429, 429]);
  });

  test('does not rate limit /healthz', async () => {
    const { app } = buildVoiceApp({ rateLimit: { max: 1, windowMs: 60_000 } });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await request(app).get('/healthz')).status).toBe(200);
    }
  });
});

test('the webhook secret constant is long enough to satisfy the env rule', () => {
  expect(WEBHOOK_SECRET.length).toBeGreaterThanOrEqual(16);
});

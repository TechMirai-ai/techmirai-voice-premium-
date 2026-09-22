/**
 * VP-4 §6 test 5: nothing logged around either route ever contains a raw
 * caller name or phone number — on the happy path or any failure path.
 * The logger is replaced by a recorder; whatever reaches it is what would be
 * passed to redactPersonalData, so we also run each record through the real
 * redactor, exactly as src/lib/logger.ts does.
 */
import request from 'supertest';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { redactPersonalData } from '../../src/lib/redact.js';
import {
  AUTH,
  buildVoiceApp,
  CALLER_NAME,
  CALLER_PHONE,
  toolCallsBody,
} from '../helpers/voiceFixtures.js';

const records: unknown[] = [];

vi.mock('../../src/lib/logger.js', () => {
  const record = (level: string) => (message: string, context?: unknown) => {
    records.push({ level, message, context });
  };
  return {
    logger: {
      debug: record('debug'),
      info: record('info'),
      warn: record('warn'),
      error: record('error'),
    },
  };
});

/** What actually reaches a log sink: every record passed through the real redactor. */
const logged = (): string => JSON.stringify(records.map((entry) => redactPersonalData(entry)));

const sensitive = [CALLER_NAME, CALLER_PHONE, CALLER_PHONE.replaceAll('-', '')];
const args = { callerName: CALLER_NAME, callerPhone: CALLER_PHONE, reason: 'knee pain' };

beforeEach(() => {
  records.length = 0;
});

describe('logging around the voice routes', () => {
  test('a successful callback logs identifiers but no name or phone', async () => {
    const { app } = buildVoiceApp();

    await request(app)
      .post('/api/voice/callback-request')
      .set(AUTH)
      .send(toolCallsBody('request_callback', args));

    expect(records.length).toBeGreaterThan(0);
    for (const value of sensitive) expect(logged()).not.toContain(value);
  });

  test('a database failure logs nothing personal, even if the driver error echoed it', async () => {
    const { app, callbacks } = buildVoiceApp();
    callbacks.failWith = new Error(`Failing row contains (${CALLER_NAME}, ${CALLER_PHONE})`);

    await request(app)
      .post('/api/voice/callback-request')
      .set(AUTH)
      .send(toolCallsBody('request_callback', args));

    expect(logged()).toContain('webhook handler failed');
    // The phone number is caught by shape anywhere; the name is not (redact.ts's stated limit),
    // so the route must not put a driver error message that may hold it into the log.
    expect(logged()).not.toContain(CALLER_PHONE);
    expect(logged()).not.toContain(CALLER_NAME);
  });

  test('unparseable JSON that quotes a caller name does not leak it into the log', async () => {
    const { app } = buildVoiceApp();

    await request(app)
      .post('/api/voice/callback-request')
      .set(AUTH)
      .set('Content-Type', 'application/json')
      .send(`${CALLER_NAME} wants a callback, not json`);

    expect(logged()).toContain('request failed');
    expect(logged()).not.toContain(CALLER_NAME);
  });

  test('a rejected argument logs the field name, never its value', async () => {
    const { app } = buildVoiceApp();

    await request(app)
      .post('/api/voice/callback-request')
      .set(AUTH)
      .send(toolCallsBody('request_callback', { callerName: CALLER_NAME, callerPhone: '12' }));

    expect(logged()).toContain('callerPhone');
    expect(logged()).not.toContain(CALLER_NAME);
  });

  test('an unauthenticated request logs no body content', async () => {
    const { app } = buildVoiceApp();

    await request(app)
      .post('/api/voice/callback-request')
      .send(toolCallsBody('request_callback', args));

    for (const value of sensitive) expect(logged()).not.toContain(value);
  });

  test('a malformed body logs nothing from the body', async () => {
    const { app } = buildVoiceApp();

    await request(app)
      .post('/api/voice/callback-request')
      .set(AUTH)
      .send({ message: { type: 'nope' }, callerName: CALLER_NAME, callerPhone: CALLER_PHONE });

    for (const value of sensitive) expect(logged()).not.toContain(value);
  });

  test('a notifier failure logs no personal data', async () => {
    const { app, notifier } = buildVoiceApp();
    notifier.failWith = new Error('smtp down');

    await request(app)
      .post('/api/voice/callback-request')
      .set(AUTH)
      .send(toolCallsBody('request_callback', args));
    await new Promise((resolve) => setImmediate(resolve));

    expect(logged()).toContain('callback notification failed');
    for (const value of sensitive) expect(logged()).not.toContain(value);
  });
});

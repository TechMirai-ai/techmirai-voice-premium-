/**
 * VP-24: POST /api/voice/transfer-to-staff. The model asks; the server decides. Nothing here makes
 * a real call: `fetchImpl` stands in for Vapi's Live Call Control address.
 */
import request from 'supertest';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { loadClient } from '../../src/config/loadClient.js';
import { redactPersonalData } from '../../src/lib/redact.js';
import { fillClinicPlaceholders, pick } from '../../src/vapi/promptShared.js';
import { AUTH, buildVoiceApp, CLIENT_ID, toolCallsBody } from '../helpers/voiceFixtures.js';

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

const PATH = '/api/voice/transfer-to-staff';
const CONTROL_URL = 'https://aws-us-west-2-production1-phone-call-websocket.vapi.ai/abc/control';
const STAFF = '+81312345678';
const ENV_NAME = 'TRANSFER_STAFF_NUMBER_SAKURA';
/** Monday 10:00 JST: the clinic is open. */
const OPEN = () => new Date('2026-11-09T10:00:00+09:00');
/** Sunday 12:00 JST: closed. */
const CLOSED = () => new Date('2026-11-08T12:00:00+09:00');

const logged = (): string => JSON.stringify(records.map((entry) => redactPersonalData(entry)));
/** What the route actually passed to the logger, BEFORE the real logger's redaction. */
const rawLogged = (): string => JSON.stringify(records);

function transferBody(overrides: { controlUrl?: string | null; callId?: string } = {}) {
  const body = toolCallsBody('transfer_to_staff', {}, 'sdk', {
    ...(overrides.callId ? { callId: overrides.callId } : {}),
  });
  const controlUrl = overrides.controlUrl === undefined ? CONTROL_URL : overrides.controlUrl;
  return controlUrl
    ? {
        message: {
          ...body.message,
          call: { ...body.message.call, monitor: { controlUrl } },
        },
      }
    : body;
}

const okFetch = () =>
  vi.fn<typeof fetch>(() => Promise.resolve(new Response('{"status":"ok"}', { status: 200 })));

const envWithNumber = (name: string): string | undefined => (name === ENV_NAME ? STAFF : undefined);

function build(options: Parameters<typeof buildVoiceApp>[0] = {}) {
  const fetchImpl = options.fetchImpl ?? okFetch();
  return {
    fetchImpl: fetchImpl as ReturnType<typeof okFetch>,
    ...buildVoiceApp({ transferEnv: envWithNumber, now: OPEN, ...options, fetchImpl }),
  };
}

const post = (app: Parameters<typeof request>[0], body: object = transferBody()) =>
  request(app).post(PATH).set(AUTH).send(body);

beforeEach(() => {
  records.length = 0;
});

describe('POST /api/voice/transfer-to-staff (VP-24)', () => {
  test('requires the shared webhook credential', async () => {
    const { app, fetchImpl } = build();

    const response = await request(app).post(PATH).send(transferBody());

    expect(response.status).toBe(401);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('inside opening hours it sends ONE transfer command to the call control address, with the spoken line', async () => {
    const { app, fetchImpl } = build();

    const response = await post(app);

    expect(response.status).toBe(200);
    expect(response.body.results[0].result).toMatch(/started/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(CONTROL_URL);
    expect(init?.method).toBe('POST');
    const config = loadClient(CLIENT_ID);
    expect(JSON.parse(init?.body as string)).toEqual({
      type: 'transfer',
      destination: { type: 'number', number: STAFF },
      content: fillClinicPlaceholders(
        config,
        'ja',
        pick(config.transfer!.scripts.transferring, 'ja'),
      ),
    });
  });

  test('never tells the model the number, and never logs it', async () => {
    const { app } = build();

    const response = await post(app);

    expect(JSON.stringify(response.body)).not.toContain(STAFF);
    expect(JSON.stringify(response.body)).not.toContain('312345678');
    // Raw, not redacted: the real logger would mask a number, so a redacted copy proves nothing.
    expect(rawLogged()).not.toContain('312345678');
    expect(rawLogged()).toContain('transfer started');
  });

  test('outside opening hours the server refuses even though the model asked (the hard gate)', async () => {
    const { app, fetchImpl } = build({ now: CLOSED });

    const response = await post(app);

    expect(response.status).toBe(200);
    expect(response.body.results[0].error).toMatch(/not available/);
    expect(response.body.results[0].error).toMatch(/callback/);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(logged()).toContain('closed');
  });

  test('the closing buffer is enforced: 18:55 is refused, 18:49 is allowed', async () => {
    const late = build({ now: () => new Date('2026-11-09T18:55:00+09:00') });
    const lastCall = build({ now: () => new Date('2026-11-09T18:49:00+09:00') });

    expect((await post(late.app)).body.results[0].error).toBeDefined();
    expect(late.fetchImpl).not.toHaveBeenCalled();
    expect((await post(lastCall.app)).body.results[0].result).toBeDefined();
    expect(lastCall.fetchImpl).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['unset', () => undefined],
    ['malformed', () => '03-1234-5678'],
    ['outside the allowed countries', () => '+14155550100'],
  ])('a staff number that is %s refuses every transfer', async (_label, transferEnv) => {
    const { app, fetchImpl } = build({ transferEnv });

    const response = await post(app);

    expect(response.body.results[0].error).toMatch(/not available/);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(logged()).toContain('destination_unavailable');
  });

  test('over the daily cap the server refuses (fails closed, goes to the callback)', async () => {
    const atLimit = build({ transferCounts: { countTransfersSince: () => Promise.resolve(10) } });
    const underLimit = build({ transferCounts: { countTransfersSince: () => Promise.resolve(9) } });

    expect((await post(atLimit.app)).body.results[0].error).toMatch(/not available/);
    expect(atLimit.fetchImpl).not.toHaveBeenCalled();
    expect((await post(underLimit.app)).body.results[0].result).toBeDefined();
  });

  test('asks the store for transfers in the last 24 hours, for this client only', async () => {
    const countTransfersSince = vi.fn(() => Promise.resolve(0));
    const { app } = build({ transferCounts: { countTransfersSince } });

    await post(app);

    expect(countTransfersSince).toHaveBeenCalledWith(
      CLIENT_ID,
      new Date(OPEN().getTime() - 24 * 60 * 60_000),
    );
  });

  test('an unreadable count is a refusal, never "no limit"', async () => {
    const { app, fetchImpl } = build({
      transferCounts: { countTransfersSince: () => Promise.reject(new Error('db down')) },
    });

    const response = await post(app);

    expect(response.body.results[0].error).toMatch(/not available/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('transfers this instance already started count toward the cap before their reports are stored', async () => {
    const { app, fetchImpl } = build({
      transferCounts: { countTransfersSince: () => Promise.resolve(9) },
    });

    const first = await post(app, transferBody({ callId: 'call-a' }));
    const second = await post(app, transferBody({ callId: 'call-b' }));

    expect(first.body.results[0].result).toBeDefined();
    expect(second.body.results[0].error).toMatch(/not available/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('a call can be transferred only once: a repeated request for the same call is refused', async () => {
    const { app, fetchImpl } = build();

    await post(app, transferBody({ callId: 'call-x' }));
    const again = await post(app, transferBody({ callId: 'call-x' }));

    expect(again.body.results[0].error).toMatch(/not available/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(logged()).toContain('call_already_transferred');
  });

  test('a rejected control command is an error result, and the attempt still counts for the call', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response('{"error":"nope"}', { status: 400 })),
    );
    const { app } = build({ fetchImpl });

    const first = await post(app, transferBody({ callId: 'call-y' }));
    const second = await post(app, transferBody({ callId: 'call-y' }));

    expect(first.body.results[0].error).toMatch(/not available/);
    expect(second.body.results[0].error).toMatch(/not available/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(logged()).toContain('transfer control request failed');
  });

  test('never follows a redirect: it would replay the staff number to another host', async () => {
    const { app, fetchImpl } = build();

    await post(app);

    expect(fetchImpl.mock.calls[0]?.[1]?.redirect).toBe('error');
  });

  test('a timeout is logged apart from other failures, because the transfer may still happen', async () => {
    const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.reject(timeout));
    const { app } = build({ fetchImpl });

    const response = await post(app);

    expect(response.body.results[0].error).toMatch(/not available/);
    expect(rawLogged()).toContain('timeout (transfer may still happen)');
  });

  test('a network failure reaching Vapi is an error result, not a crash', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.reject(new Error('socket hang up')));
    const { app } = build({ fetchImpl });

    const response = await post(app);

    expect(response.status).toBe(200);
    expect(response.body.results[0].error).toMatch(/not available/);
  });

  test.each([
    ['has no control address', null],
    ['has a control address that is not on vapi.ai', 'https://evil.example.com/control'],
    ['has a plain-http control address', 'http://call.vapi.ai/control'],
  ])('a call that %s is refused and nothing is requested', async (_label, controlUrl) => {
    const { app, fetchImpl } = build();

    const response = await post(app, transferBody({ controlUrl }));

    expect(response.body.results[0].error).toMatch(/not available/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('an unknown assistant is answered with an error result, never a transfer', async () => {
    const { app, fetchImpl } = build();
    const body = toolCallsBody('transfer_to_staff', {}, 'sdk', { assistant: null });

    const response = await post(app, body);

    expect(response.body.results[0].error).toBeDefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

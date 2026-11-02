import { describe, expect, test } from 'vitest';

import {
  NotificationDeliveryError,
  deliveryErrorCode,
} from '../../src/notifications/deliveryError.js';
import {
  LINE_PUSH_URL,
  LineMessagingPusher,
  type LinePushMessage,
} from '../../src/notifications/linePush.js';
import {
  TELNYX_MESSAGES_URL,
  TelnyxSmsSender,
  type SmsMessage,
} from '../../src/notifications/telnyxSms.js';

interface RecordedCall {
  url: string;
  init: RequestInit;
}

function fakeFetch(respond: () => Response | Promise<Response>) {
  const calls: RecordedCall[] = [];
  const fn = ((url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(respond());
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const headersOf = (call: RecordedCall | undefined) =>
  (call?.init.headers ?? {}) as Record<string, string>;
const bodyOf = (call: RecordedCall | undefined): unknown =>
  JSON.parse(typeof call?.init.body === 'string' ? call.init.body : '');

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(NotificationDeliveryError);
    return deliveryErrorCode(error);
  }
  throw new Error('expected a delivery error');
}

/** A fetch that never answers, but honours its abort signal like the real one. */
const hangingFetch = ((_url: string, init: RequestInit) =>
  new Promise((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => reject(init.signal?.reason as Error));
  })) as unknown as typeof fetch;

const failingFetch = (() =>
  Promise.reject(new TypeError('fetch failed'))) as unknown as typeof fetch;

const sms: SmsMessage = {
  apiKey: 'test-telnyx-key',
  messagingProfileId: 'profile-1',
  from: 'Sakura',
  to: '+819012345678',
  text: 'hello',
  idempotencyKey: 'booking-appt-1-sms',
};

const linePush: LinePushMessage = {
  accessToken: 'test-line-token',
  to: `U${'a'.repeat(32)}`,
  text: 'hello staff',
  retryKey: '5f1d3a2e-0000-4000-8000-000000000001',
};

describe('TelnyxSmsSender', () => {
  test('POSTs the documented body to /v2/messages with Bearer auth and an idempotency key', async () => {
    const { fn, calls } = fakeFetch(() =>
      json({ data: { id: 'msg-1', to: [{ status: 'queued' }] } }),
    );

    const result = await new TelnyxSmsSender(fn).send(sms);

    expect(result).toEqual({ messageId: 'msg-1' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(TELNYX_MESSAGES_URL);
    expect(calls[0]?.init.method).toBe('POST');
    expect(headersOf(calls[0])).toMatchObject({
      Authorization: 'Bearer test-telnyx-key',
      'Idempotency-Key': 'booking-appt-1-sms',
    });
    expect(bodyOf(calls[0])).toEqual({
      from: 'Sakura',
      to: '+819012345678',
      text: 'hello',
      messaging_profile_id: 'profile-1',
      type: 'SMS',
    });
  });

  test('reports the HTTP status and Telnyx numeric error code — never the response text', async () => {
    const { fn } = fakeFetch(() =>
      json({ errors: [{ code: '40310', detail: 'bad number +819012345678' }] }, 400),
    );

    const code = await codeOf(new TelnyxSmsSender(fn).send(sms));

    expect(code).toBe('http_400_40310');
    expect(code).not.toContain('9012345678');
  });

  test('falls back to the bare status when the error body has no numeric code', async () => {
    const { fn } = fakeFetch(() => json({ errors: [{ code: 'weird <script>' }] }, 401));

    expect(await codeOf(new TelnyxSmsSender(fn).send(sms))).toBe('http_401');
  });

  test('treats an unparseable error body as just the status', async () => {
    const { fn } = fakeFetch(() => new Response('<html>gateway</html>', { status: 502 }));

    expect(await codeOf(new TelnyxSmsSender(fn).send(sms))).toBe('http_502');
  });

  test('rejects a 200 that carries no message id', async () => {
    const { fn } = fakeFetch(() => json({ data: {} }));

    expect(await codeOf(new TelnyxSmsSender(fn).send(sms))).toBe('bad_response');
  });

  test('maps a transport failure to network_error', async () => {
    expect(await codeOf(new TelnyxSmsSender(failingFetch).send(sms))).toBe('network_error');
  });

  test('gives up after the timeout instead of holding the caller on the line', async () => {
    expect(await codeOf(new TelnyxSmsSender(hangingFetch, 20).send(sms))).toBe('timeout');
  });
});

describe('LineMessagingPusher', () => {
  test('POSTs a text message to the push endpoint (not broadcast) with Bearer auth', async () => {
    const { fn, calls } = fakeFetch(() => json({ sentMessages: [{ id: 'line-1' }] }));

    const result = await new LineMessagingPusher(fn).push(linePush);

    expect(result).toEqual({ messageId: 'line-1' });
    expect(calls[0]?.url).toBe(LINE_PUSH_URL);
    expect(LINE_PUSH_URL).toBe('https://api.line.me/v2/bot/message/push');
    expect(headersOf(calls[0])).toMatchObject({
      Authorization: 'Bearer test-line-token',
      'X-Line-Retry-Key': '5f1d3a2e-0000-4000-8000-000000000001',
    });
    expect(bodyOf(calls[0])).toEqual({
      to: `U${'a'.repeat(32)}`,
      messages: [{ type: 'text', text: 'hello staff' }],
    });
  });

  test('still succeeds when the 200 body has no message id', async () => {
    const { fn } = fakeFetch(() => json({}));

    expect(await new LineMessagingPusher(fn).push(linePush)).toEqual({});
  });

  test('reports only the HTTP status on failure — LINE error text can quote the recipient', async () => {
    const { fn } = fakeFetch(() => json({ message: `Failed to send to U${'a'.repeat(32)}` }, 400));

    expect(await codeOf(new LineMessagingPusher(fn).push(linePush))).toBe('http_400');
  });

  test('maps a transport failure to network_error', async () => {
    expect(await codeOf(new LineMessagingPusher(failingFetch).push(linePush))).toBe(
      'network_error',
    );
  });

  test('gives up after the timeout', async () => {
    expect(await codeOf(new LineMessagingPusher(hangingFetch, 20).push(linePush))).toBe('timeout');
  });
});

describe('deliveryErrorCode', () => {
  test('gives a generic code to anything that is not a delivery error', () => {
    expect(deliveryErrorCode(new Error('contains +819012345678'))).toBe('unexpected_error');
    expect(deliveryErrorCode('x')).toBe('unexpected_error');
  });
});

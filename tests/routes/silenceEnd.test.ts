import request from 'supertest';
import { describe, expect, test, vi } from 'vitest';

import { loadClient } from '../../src/config/loadClient.js';
import { isVapiControlUrl } from '../../src/routes/silenceEnd.js';
import { silenceEndingLine } from '../../src/vapi/callEnding.js';
import { AUTH, buildVoiceApp, CLIENT_ID, toolCallsBody } from '../helpers/voiceFixtures.js';

const PATH = '/api/voice/silence-end';
const CONTROL_URL = 'https://aws-us-west-2-production1-phone-call-websocket.vapi.ai/abc/control';

function silenceEndBody(controlUrl?: string) {
  const body = toolCallsBody('silence_end_call', {});
  return controlUrl
    ? { message: { ...body.message, call: { ...body.message.call, monitor: { controlUrl } } } }
    : body;
}

const okFetch = () =>
  vi.fn<typeof fetch>(() => Promise.resolve(new Response('{}', { status: 200 })));

describe('POST /api/voice/silence-end (VP-16 R3)', () => {
  test('requires the shared webhook credential', async () => {
    const { app } = buildVoiceApp({ fetchImpl: okFetch() });

    const response = await request(app).post(PATH).send(silenceEndBody(CONTROL_URL));

    expect(response.status).toBe(401);
  });

  test('speaks the announcement AND ends the call in one control command — exactly one closing line', async () => {
    const fetchImpl = okFetch();
    const { app } = buildVoiceApp({ fetchImpl });

    const response = await request(app).post(PATH).set(AUTH).send(silenceEndBody(CONTROL_URL));

    expect(response.status).toBe(200);
    expect(response.body.results[0].result).toBeDefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(CONTROL_URL);
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual({
      type: 'say',
      content: silenceEndingLine(loadClient(CLIENT_ID), 'ja'),
      endCallAfterSpoken: true,
    });
  });

  test('answers with an error result (still HTTP 200) when the call has no control address', async () => {
    const fetchImpl = okFetch();
    const { app } = buildVoiceApp({ fetchImpl });

    const response = await request(app).post(PATH).set(AUTH).send(silenceEndBody());

    expect(response.status).toBe(200);
    expect(response.body.results[0].error).toBeDefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('never calls a control address outside Vapi (SSRF guard)', async () => {
    const fetchImpl = okFetch();
    const { app } = buildVoiceApp({ fetchImpl });

    const response = await request(app)
      .post(PATH)
      .set(AUTH)
      .send(silenceEndBody('https://evil.example.com/control'));

    expect(response.body.results[0].error).toBeDefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('reports an error result when Vapi rejects the control command', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response('no', { status: 500 })),
    );
    const { app } = buildVoiceApp({ fetchImpl });

    const response = await request(app).post(PATH).set(AUTH).send(silenceEndBody(CONTROL_URL));

    expect(response.status).toBe(200);
    expect(response.body.results[0].error).toBeDefined();
  });
});

describe('isVapiControlUrl', () => {
  test.each([
    [CONTROL_URL, true],
    ['http://aws.vapi.ai/control', false],
    ['https://vapi.ai.evil.com/control', false],
    ['https://evil.com/?x=.vapi.ai', false],
    ['not a url', false],
  ])('%s -> %s', (value, expected) => {
    expect(isVapiControlUrl(value)).toBe(expected);
  });
});

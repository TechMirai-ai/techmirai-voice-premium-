import { describe, expect, test, vi } from 'vitest';

import { MAX_AUDIO_BYTES, buildArchiveSource, fetchCallData } from '../../src/google/vapiSource.js';
import { requestUrl } from '../../src/google/http.js';

interface Call {
  url: string;
  authorization: string | null;
}

/** A fake fetch routed by URL; each route gives a response (or throws). */
function fakeFetch(routes: Record<string, () => Response>) {
  const calls: Call[] = [];
  const fetchFn = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = requestUrl(input);
    calls.push({ url, authorization: new Headers(init?.headers).get('authorization') });
    const route = routes[url];
    if (!route) throw new Error(`unexpected request: ${url}`);
    return Promise.resolve(route());
  });
  return { fetchFn: fetchFn as unknown as typeof fetch, calls };
}

const bytes = (...values: number[]) => new Uint8Array(values);
const audio = (body: Uint8Array, type = 'audio/wav', status = 200) =>
  new Response(body, { status, headers: { 'content-type': type } });

const MONO = 'https://api.vapi.ai/call/call-1/mono-recording';
const PRESIGNED = 'https://signed.example/call-1.wav?sig=abc';
const options = (fetchFn: typeof fetch) => ({ apiKey: 'vapi-key', fetch: fetchFn });

describe('fetchCallData', () => {
  test('reads the transcript, timing and presigned link from GET /call/{id}', async () => {
    const { fetchFn, calls } = fakeFetch({
      'https://api.vapi.ai/call/call-1': () =>
        Response.json({
          startedAt: '2026-10-12T01:00:00.000Z',
          endedReason: 'assistant-ended-call',
          artifact: { transcript: 'AI: hi', presignedMonoUrl: PRESIGNED },
        }),
    });

    const data = await fetchCallData('call-1', options(fetchFn));

    expect(data).toEqual({
      transcript: 'AI: hi',
      startedAt: '2026-10-12T01:00:00.000Z',
      endedReason: 'assistant-ended-call',
      presignedMonoUrl: PRESIGNED,
    });
    expect(calls[0]?.authorization).toBe('Bearer vapi-key');
  });

  test('a call with no transcript yet still yields an empty one', async () => {
    const { fetchFn } = fakeFetch({ 'https://api.vapi.ai/call/call-1': () => Response.json({}) });
    expect((await fetchCallData('call-1', options(fetchFn))).transcript).toBe('');
  });

  test('a failed request throws without the API key in the message', async () => {
    const { fetchFn } = fakeFetch({
      'https://api.vapi.ai/call/call-1': () => new Response('nope', { status: 500 }),
    });
    const failure = (await fetchCallData('call-1', options(fetchFn)).catch(
      (e: unknown) => e,
    )) as Error;
    expect(failure.message).toMatch(/500/);
    expect(failure.message).not.toContain('vapi-key');
  });
});

describe('buildArchiveSource → fetchAudio', () => {
  const data = { transcript: 'AI: hi', startedAt: '2026-10-12T01:00:00.000Z' };

  test('downloads the presigned link first (no auth header — it is self-authenticating)', async () => {
    const { fetchFn, calls } = fakeFetch({ [PRESIGNED]: () => audio(bytes(1, 2, 3)) });
    const source = buildArchiveSource(
      'call-1',
      { ...data, presignedMonoUrl: PRESIGNED },
      options(fetchFn),
    );

    expect(await source.fetchAudio()).toEqual({ bytes: bytes(1, 2, 3), mimeType: 'audio/wav' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.authorization).toBeNull();
  });

  test('an EXPIRED presigned link falls back to the authenticated mono-recording endpoint', async () => {
    const { fetchFn, calls } = fakeFetch({
      [PRESIGNED]: () => new Response('expired', { status: 403 }),
      [MONO]: () => audio(bytes(9, 9)),
    });
    const source = buildArchiveSource(
      'call-1',
      { ...data, presignedMonoUrl: PRESIGNED },
      options(fetchFn),
    );

    expect((await source.fetchAudio())?.bytes).toEqual(bytes(9, 9));
    expect(calls[1]?.url).toBe(MONO);
    expect(calls[1]?.authorization).toBe('Bearer vapi-key');
  });

  test('with no presigned link at all, goes straight to the authenticated endpoint', async () => {
    const { fetchFn, calls } = fakeFetch({ [MONO]: () => audio(bytes(5), 'audio/mpeg') });

    const result = await buildArchiveSource('call-1', data, options(fetchFn)).fetchAudio();

    expect(result).toEqual({ bytes: bytes(5), mimeType: 'audio/mpeg' });
    expect(calls).toHaveLength(1);
  });

  test('keeps only the media type, dropping parameters such as charset', async () => {
    const { fetchFn } = fakeFetch({ [MONO]: () => audio(bytes(1), 'audio/wav; charset=binary') });
    expect(
      (await buildArchiveSource('call-1', data, options(fetchFn)).fetchAudio())?.mimeType,
    ).toBe('audio/wav');
  });

  test('a call with no recording (404 from Vapi) is "no audio", not an error', async () => {
    const { fetchFn } = fakeFetch({ [MONO]: () => new Response('', { status: 404 }) });
    expect(await buildArchiveSource('call-1', data, options(fetchFn)).fetchAudio()).toBeUndefined();
  });

  test('any other failure throws so the job is retried — with no key or URL in the message', async () => {
    const { fetchFn } = fakeFetch({
      [PRESIGNED]: () => new Response('', { status: 500 }),
      [MONO]: () => new Response('', { status: 502 }),
    });
    const source = buildArchiveSource(
      'call-1',
      { ...data, presignedMonoUrl: PRESIGNED },
      options(fetchFn),
    );

    const failure = (await source.fetchAudio().catch((e: unknown) => e)) as Error;

    expect(failure.message).toMatch(/502/);
    expect(failure.message).not.toContain('vapi-key');
    expect(failure.message).not.toContain('sig=abc');
  });

  test('refuses a recording larger than the cap rather than exhausting memory', async () => {
    const { fetchFn } = fakeFetch({
      [MONO]: () =>
        new Response(bytes(1), {
          headers: { 'content-type': 'audio/wav', 'content-length': String(MAX_AUDIO_BYTES + 1) },
        }),
    });

    await expect(buildArchiveSource('call-1', data, options(fetchFn)).fetchAudio()).rejects.toThrow(
      /too large/i,
    );
  });
});

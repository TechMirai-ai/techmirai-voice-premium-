import { createPublicKey, createVerify, generateKeyPairSync } from 'node:crypto';

import { describe, expect, test, vi } from 'vitest';

import {
  CachedTokenProvider,
  GoogleAuthError,
  parseServiceAccountJson,
  refreshTokenProvider,
  serviceAccountProvider,
} from '../../src/google/auth.js';
import { requestBodyText, requestUrl } from '../../src/google/http.js';

interface Recorded {
  url: string;
  body: URLSearchParams;
}

/** A fake token endpoint: answers each request from `responses`, in order, and records what it got. */
function fakeTokenEndpoint(responses: Array<{ status?: number; json: unknown }>) {
  const calls: Recorded[] = [];
  const queue = [...responses];
  const fetchFn = vi.fn((url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: requestUrl(url), body: new URLSearchParams(requestBodyText(init)) });
    const next = queue.shift();
    if (!next) throw new Error('unexpected extra token request');
    return Promise.resolve(
      new Response(JSON.stringify(next.json), {
        status: next.status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  });
  return { fetchFn: fetchFn as unknown as typeof fetch, calls };
}

const token = (value: string, expiresIn = 3600) => ({
  json: { access_token: value, expires_in: expiresIn, token_type: 'Bearer' },
});

describe('refreshTokenProvider (Option B: the stored secret is the REFRESH token)', () => {
  const credentials = { clientId: 'cid', clientSecret: 'csecret', refreshToken: 'rtoken' };

  test('exchanges the refresh token for an access token', async () => {
    const { fetchFn, calls } = fakeTokenEndpoint([token('access-1')]);
    const provider = refreshTokenProvider({ ...credentials, fetch: fetchFn });

    expect(await provider.getAccessToken()).toBe('access-1');
    expect(calls[0]?.url).toBe('https://oauth2.googleapis.com/token');
    expect(Object.fromEntries(calls[0]!.body)).toEqual({
      grant_type: 'refresh_token',
      client_id: 'cid',
      client_secret: 'csecret',
      refresh_token: 'rtoken',
    });
  });

  test('reuses the cached access token while it is still valid', async () => {
    const { fetchFn, calls } = fakeTokenEndpoint([token('access-1')]);
    const provider = refreshTokenProvider({ ...credentials, fetch: fetchFn, now: () => 0 });

    await provider.getAccessToken();
    await provider.getAccessToken();

    expect(calls).toHaveLength(1);
  });

  test('RENEWS with the same refresh token once the access token has expired', async () => {
    const { fetchFn, calls } = fakeTokenEndpoint([
      token('access-1', 3600),
      token('access-2', 3600),
    ]);
    let nowMs = 0;
    const provider = refreshTokenProvider({ ...credentials, fetch: fetchFn, now: () => nowMs });

    expect(await provider.getAccessToken()).toBe('access-1');
    nowMs = 3600 * 1000 + 1; // the one-hour access token is now dead
    expect(await provider.getAccessToken()).toBe('access-2');

    expect(calls).toHaveLength(2);
    expect(calls[1]?.body.get('refresh_token')).toBe('rtoken');
  });

  test('renews slightly BEFORE expiry, so a token never dies mid-request', async () => {
    const { fetchFn, calls } = fakeTokenEndpoint([token('a1', 3600), token('a2', 3600)]);
    let nowMs = 0;
    const provider = refreshTokenProvider({ ...credentials, fetch: fetchFn, now: () => nowMs });

    await provider.getAccessToken();
    nowMs = 3600 * 1000 - 30_000; // 30s left: inside the safety margin
    expect(await provider.getAccessToken()).toBe('a2');
    expect(calls).toHaveLength(2);
  });

  test('concurrent callers share one in-flight refresh', async () => {
    const { fetchFn, calls } = fakeTokenEndpoint([token('access-1')]);
    const provider = refreshTokenProvider({ ...credentials, fetch: fetchFn });

    const [a, b] = await Promise.all([provider.getAccessToken(), provider.getAccessToken()]);

    expect(a).toBe('access-1');
    expect(b).toBe('access-1');
    expect(calls).toHaveLength(1);
  });

  test('a revoked or expired refresh token fails LOUDLY as invalid_grant, never silently', async () => {
    const { fetchFn } = fakeTokenEndpoint([
      {
        status: 400,
        json: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' },
      },
    ]);
    const provider = refreshTokenProvider({ ...credentials, fetch: fetchFn });

    const failure = await provider.getAccessToken().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(GoogleAuthError);
    expect((failure as GoogleAuthError).reason).toBe('invalid_grant');
  });

  test('after a failure the next call tries again instead of caching the error', async () => {
    const { fetchFn } = fakeTokenEndpoint([{ status: 500, json: {} }, token('access-2')]);
    const provider = refreshTokenProvider({ ...credentials, fetch: fetchFn });

    await expect(provider.getAccessToken()).rejects.toBeInstanceOf(GoogleAuthError);
    expect(await provider.getAccessToken()).toBe('access-2');
  });

  test('error messages never contain the secrets', async () => {
    const { fetchFn } = fakeTokenEndpoint([{ status: 400, json: { error: 'invalid_grant' } }]);
    const provider = refreshTokenProvider({ ...credentials, fetch: fetchFn });

    const failure = (await provider.getAccessToken().catch((error: unknown) => error)) as Error;

    for (const secret of ['rtoken', 'csecret']) expect(failure.message).not.toContain(secret);
  });

  test('a malformed success response is an error, not an undefined token', async () => {
    const { fetchFn } = fakeTokenEndpoint([{ json: { nope: true } }]);
    const provider = refreshTokenProvider({ ...credentials, fetch: fetchFn });

    await expect(provider.getAccessToken()).rejects.toBeInstanceOf(GoogleAuthError);
  });
});

describe('CachedTokenProvider', () => {
  test('treats a token with no usable lifetime as already expired', async () => {
    const mint = vi.fn(() => Promise.resolve({ accessToken: 't', expiresInSeconds: 0 }));
    const provider = new CachedTokenProvider(mint, () => 0);

    await provider.getAccessToken();
    await provider.getAccessToken();

    expect(mint).toHaveBeenCalledTimes(2);
  });
});

describe('serviceAccountProvider (Sheets)', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });

  test('sends a correctly signed RS256 JWT bearer assertion', async () => {
    const { fetchFn, calls } = fakeTokenEndpoint([token('sa-access')]);
    const provider = serviceAccountProvider({
      clientEmail: 'writer@project.iam.gserviceaccount.com',
      privateKey,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
      fetch: fetchFn,
      now: () => 1_700_000_000_000,
    });

    expect(await provider.getAccessToken()).toBe('sa-access');

    const body = calls[0]!.body;
    expect(body.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    const [header, payload, signature] = body.get('assertion')!.split('.') as [
      string,
      string,
      string,
    ];
    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({
      alg: 'RS256',
      typ: 'JWT',
    });
    expect(JSON.parse(Buffer.from(payload, 'base64url').toString())).toEqual({
      iss: 'writer@project.iam.gserviceaccount.com',
      scope: 'https://www.googleapis.com/auth/spreadsheets',
      aud: 'https://oauth2.googleapis.com/token',
      iat: 1_700_000_000,
      exp: 1_700_003_600,
    });
    const verifier = createVerify('RSA-SHA256').update(`${header}.${payload}`);
    expect(verifier.verify(createPublicKey(publicKey), Buffer.from(signature, 'base64url'))).toBe(
      true,
    );
  });
});

describe('parseServiceAccountJson', () => {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64');

  test('reads the email and private key from the base64 env value', () => {
    const parsed = parseServiceAccountJson(
      encode({ client_email: 'a@b.iam.gserviceaccount.com', private_key: 'KEY', extra: 1 }),
    );
    expect(parsed).toEqual({ clientEmail: 'a@b.iam.gserviceaccount.com', privateKey: 'KEY' });
  });

  test('rejects garbage without echoing it', () => {
    expect(() => parseServiceAccountJson('not-base64-json!!')).toThrow(
      /GOOGLE_SERVICE_ACCOUNT_JSON_B64/,
    );
    expect(() => parseServiceAccountJson(encode({ client_email: 'x' }))).toThrow(
      /GOOGLE_SERVICE_ACCOUNT_JSON_B64/,
    );
  });
});

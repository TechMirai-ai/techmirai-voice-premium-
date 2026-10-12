import { createHash } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import {
  DRIVE_FILE_SCOPE,
  buildConsentUrl,
  exchangeAuthorizationCode,
  generatePkce,
  parseCallback,
} from '../../src/google/consent.js';
import { requestBodyText } from '../../src/google/http.js';

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

describe('buildConsentUrl', () => {
  const url = new URL(
    buildConsentUrl({
      clientId: 'cid',
      redirectUri: 'http://127.0.0.1:5555',
      state: 'st',
      codeChallenge: 'chal',
    }),
  );

  test('asks for offline access and forces a refresh token to be issued', () => {
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('response_type')).toBe('code');
  });

  test('requests only the narrow drive.file scope — never full Drive access', () => {
    expect(url.searchParams.get('scope')).toBe(DRIVE_FILE_SCOPE);
    expect(DRIVE_FILE_SCOPE).toBe('https://www.googleapis.com/auth/drive.file');
  });

  test('uses a loopback redirect, state, and a PKCE S256 challenge', () => {
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:5555');
    expect(url.searchParams.get('state')).toBe('st');
    expect(url.searchParams.get('code_challenge')).toBe('chal');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  });
});

describe('generatePkce', () => {
  test('the challenge is the base64url SHA-256 of the verifier', () => {
    const { verifier, challenge } = generatePkce();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'));
  });

  test('is different every time', () => {
    expect(generatePkce().verifier).not.toBe(generatePkce().verifier);
  });
});

describe('parseCallback', () => {
  test('returns the code when the state matches', () => {
    expect(parseCallback('/?code=abc&state=st', 'st')).toEqual({ code: 'abc' });
  });

  test('rejects a mismatched state (possible forged callback)', () => {
    expect(() => parseCallback('/?code=abc&state=other', 'st')).toThrow(/state/i);
  });

  test('reports the user denying consent', () => {
    expect(() => parseCallback('/?error=access_denied&state=st', 'st')).toThrow(
      /denied|access_denied/i,
    );
  });

  test('rejects a callback with no code', () => {
    expect(() => parseCallback('/?state=st', 'st')).toThrow(/code/i);
  });
});

describe('exchangeAuthorizationCode', () => {
  const input = {
    clientId: 'cid',
    clientSecret: 'csecret',
    code: 'the-code',
    redirectUri: 'http://127.0.0.1:5555',
    codeVerifier: 'verifier',
  };

  test('exchanges the code (with the PKCE verifier) for a refresh token and an access token', async () => {
    let sent = new URLSearchParams();
    const fetchFn = ((_url: string, init?: RequestInit) => {
      sent = new URLSearchParams(requestBodyText(init));
      return Promise.resolve(
        json({
          refresh_token: 'r1',
          access_token: 'a1',
          expires_in: 3599,
          scope: DRIVE_FILE_SCOPE,
        }),
      );
    }) as unknown as typeof fetch;

    const result = await exchangeAuthorizationCode({ ...input, fetch: fetchFn });

    expect(result).toEqual({
      refreshToken: 'r1',
      accessToken: 'a1',
      grantedScope: DRIVE_FILE_SCOPE,
    });
    expect(Object.fromEntries(sent)).toEqual({
      grant_type: 'authorization_code',
      code: 'the-code',
      code_verifier: 'verifier',
      client_id: 'cid',
      client_secret: 'csecret',
      redirect_uri: 'http://127.0.0.1:5555',
    });
  });

  test('explains what to do when Google returns no refresh token', async () => {
    const fetchFn = (() =>
      Promise.resolve(json({ access_token: 'a1', expires_in: 3599 }))) as unknown as typeof fetch;
    await expect(exchangeAuthorizationCode({ ...input, fetch: fetchFn })).rejects.toThrow(
      /refresh token/i,
    );
  });

  test('a rejected exchange does not leak the client secret or code', async () => {
    const fetchFn = (() =>
      Promise.resolve(json({ error: 'invalid_grant' }, 400))) as unknown as typeof fetch;
    const failure = (await exchangeAuthorizationCode({ ...input, fetch: fetchFn }).catch(
      (error: unknown) => error,
    )) as Error;
    expect(failure.message).not.toContain('csecret');
    expect(failure.message).not.toContain('the-code');
  });
});

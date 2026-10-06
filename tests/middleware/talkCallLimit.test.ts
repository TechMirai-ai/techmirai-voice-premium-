import { describe, expect, test } from 'vitest';

import {
  decideTalkCall,
  isBypassKeyValid,
  readCookie,
  talkCallCookieName,
  TALK_CALL_CAP,
} from '../../src/middleware/talkCallLimit.js';

const SECRET = 'test-talk-rate-limit-secret-0123456789';
const BYPASS_KEY = 'test-talk-bypass-key';
const CLIENT_ID = 'demo-clinic';

function cookieHeaderFor(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return `${talkCallCookieName(CLIENT_ID)}=${encodeURIComponent(value)}`;
}

describe('readCookie', () => {
  test('finds the named cookie among several', () => {
    expect(readCookie('a=1; b=2; c=3', 'b')).toBe('2');
  });

  test('returns undefined when the header or the named cookie is absent', () => {
    expect(readCookie(undefined, 'b')).toBeUndefined();
    expect(readCookie('a=1', 'b')).toBeUndefined();
  });
});

describe('isBypassKeyValid', () => {
  test('accepts the exact configured key', () => {
    expect(isBypassKeyValid(BYPASS_KEY, BYPASS_KEY)).toBe(true);
  });

  test('rejects a missing, wrong, or differently-sized key', () => {
    expect(isBypassKeyValid(undefined, BYPASS_KEY)).toBe(false);
    expect(isBypassKeyValid('wrong-key', BYPASS_KEY)).toBe(false);
    expect(isBypassKeyValid(BYPASS_KEY.slice(0, -1), BYPASS_KEY)).toBe(false);
    expect(isBypassKeyValid(BYPASS_KEY + 'x', BYPASS_KEY)).toBe(false);
  });
});

describe('decideTalkCall', () => {
  const options = { rateLimitSecret: SECRET, bypassKey: BYPASS_KEY };

  test('a fresh visitor (no cookie) is allowed and issues a new signed cookie', () => {
    const decision = decideTalkCall(CLIENT_ID, undefined, undefined, options);

    expect(decision.allowed).toBe(true);
    expect(decision.bypassed).toBe(false);
    expect(decision.newCookieValue).toMatch(/^1\.[0-9a-f]{64}$/);
  });

  test('allows calls up to the cap, then blocks the next one', () => {
    let cookieHeader: string | undefined;

    for (let i = 0; i < TALK_CALL_CAP; i++) {
      const decision = decideTalkCall(CLIENT_ID, cookieHeader, undefined, options);
      expect(decision.allowed).toBe(true);
      cookieHeader = cookieHeaderFor(decision.newCookieValue);
    }

    const blocked = decideTalkCall(CLIENT_ID, cookieHeader, undefined, options);
    expect(blocked.allowed).toBe(false);
    expect(blocked.newCookieValue).toBeUndefined();
  });

  test('a tampered cookie (count edited by hand) is treated as a fresh visitor, not unlimited', () => {
    const tampered = cookieHeaderFor('0.deadbeef');

    const decision = decideTalkCall(CLIENT_ID, tampered, undefined, options);

    expect(decision.allowed).toBe(true);
    expect(decision.newCookieValue).toMatch(/^1\./);
  });

  test('a cookie claiming a huge count without a valid signature does not grant unlimited calls', () => {
    const tampered = cookieHeaderFor('999999.notarealsignature');

    const decision = decideTalkCall(CLIENT_ID, tampered, undefined, options);

    expect(decision.allowed).toBe(true);
    expect(decision.newCookieValue).toMatch(/^1\./);
  });

  test('a valid bypass key skips the cap entirely, even once the cap has been reached', () => {
    let cookieHeader: string | undefined;
    for (let i = 0; i < TALK_CALL_CAP; i++) {
      const decision = decideTalkCall(CLIENT_ID, cookieHeader, undefined, options);
      cookieHeader = cookieHeaderFor(decision.newCookieValue);
    }

    const bypassed = decideTalkCall(CLIENT_ID, cookieHeader, BYPASS_KEY, options);

    expect(bypassed.allowed).toBe(true);
    expect(bypassed.bypassed).toBe(true);
    expect(bypassed.newCookieValue).toBeUndefined();
  });

  test('an invalid key falls back to the normal cookie-cap check', () => {
    const decision = decideTalkCall(CLIENT_ID, undefined, 'not-the-real-key', options);

    expect(decision.allowed).toBe(true);
    expect(decision.bypassed).toBe(false);
  });
});

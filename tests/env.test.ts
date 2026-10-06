import { describe, expect, test } from 'vitest';

import { EnvError, isProduction, loadDatabaseUrl, loadEnv } from '../src/env.js';

const base = {
  NODE_ENV: 'test',
  PORT: '3000',
  DATABASE_URL: 'postgres://voice:voice@localhost:5433/techmirai_voice_premium',
  PUBLIC_BASE_URL: 'https://example.ngrok-free.app',
  VAPI_API_KEY: 'test-vapi-api-key',
  VAPI_PUBLIC_KEY: 'test-vapi-public-key',
  VAPI_WEBHOOK_SECRET: 'test-webhook-secret-0123456789',
  VAPI_SERVER_CREDENTIAL_ID: 'test-credential-id',
  SESSION_SECRET: 'test-session-secret-0123456789-0123456789',
  TALK_RATE_LIMIT_SECRET: 'test-talk-rate-limit-secret-0123456789',
  TALK_BYPASS_KEY: 'test-talk-bypass-key',
};

const load = (source: NodeJS.ProcessEnv) => loadEnv(source, { readDotenvFile: false });

describe('loadEnv', () => {
  test('accepts a complete environment and coerces PORT to a number', () => {
    const env = load(base);

    expect(env.PORT).toBe(3000);
    expect(env.NODE_ENV).toBe('test');
  });

  test.each([
    'DATABASE_URL',
    'NODE_ENV',
    'PUBLIC_BASE_URL',
    'VAPI_API_KEY',
    'VAPI_PUBLIC_KEY',
    'VAPI_WEBHOOK_SECRET',
    'VAPI_SERVER_CREDENTIAL_ID',
    'SESSION_SECRET',
    'TALK_RATE_LIMIT_SECRET',
    'TALK_BYPASS_KEY',
  ])('fails fast and names %s when it is missing', (key) => {
    const source = { ...base, [key]: undefined };

    expect(() => load(source)).toThrow(EnvError);
    expect(() => load(source)).toThrow(new RegExp(key));
  });

  test('rejects a webhook secret shorter than 16 characters', () => {
    expect(() => load({ ...base, VAPI_WEBHOOK_SECRET: 'too-short' })).toThrow(
      /VAPI_WEBHOOK_SECRET/,
    );
  });

  test('rejects a session secret shorter than 32 characters', () => {
    expect(() => load({ ...base, SESSION_SECRET: 'too-short' })).toThrow(/SESSION_SECRET/);
  });

  test('rejects a talk rate-limit secret shorter than 32 characters', () => {
    expect(() => load({ ...base, TALK_RATE_LIMIT_SECRET: 'too-short' })).toThrow(
      /TALK_RATE_LIMIT_SECRET/,
    );
  });

  test('rejects a talk bypass key shorter than 16 characters', () => {
    expect(() => load({ ...base, TALK_BYPASS_KEY: 'too-short' })).toThrow(/TALK_BYPASS_KEY/);
  });

  test('treats PORT as optional — api/index.ts (Vercel) never sets it', () => {
    expect(load({ ...base, PORT: undefined }).PORT).toBeUndefined();
    expect(load(base).PORT).toBe(3000);
  });

  test('treats TRUST_PROXY_HOPS as optional and coerces it to a number', () => {
    expect(load(base).TRUST_PROXY_HOPS).toBeUndefined();
    expect(load({ ...base, TRUST_PROXY_HOPS: '1' }).TRUST_PROXY_HOPS).toBe(1);
  });

  test('treats TEST_DATABASE_URL as optional', () => {
    const env = load({ ...base, TEST_DATABASE_URL: '' });

    expect(env.TEST_DATABASE_URL).toBeUndefined();
  });

  test('rejects a PUBLIC_BASE_URL that is not a URL', () => {
    expect(() => load({ ...base, PUBLIC_BASE_URL: 'localhost:3000' })).toThrow(/PUBLIC_BASE_URL/);
  });

  test('rejects an unknown NODE_ENV', () => {
    expect(() => load({ ...base, NODE_ENV: 'staging' })).toThrow(/NODE_ENV/);
  });

  test('isProduction is true only for production', () => {
    expect(isProduction(load({ ...base, NODE_ENV: 'production', TRUST_PROXY_HOPS: '1' }))).toBe(
      true,
    );
    expect(isProduction(load(base))).toBe(false);
  });
});

describe('loadDatabaseUrl', () => {
  const loadDb = (source: NodeJS.ProcessEnv) => loadDatabaseUrl(source, { readDotenvFile: false });

  test('returns DATABASE_URL without requiring the Vapi vars db:migrate has nothing to do with', () => {
    const url = loadDb({ DATABASE_URL: base.DATABASE_URL });

    expect(url).toBe(base.DATABASE_URL);
  });

  test('fails fast and names DATABASE_URL when it is missing', () => {
    expect(() => loadDb({})).toThrow(EnvError);
    expect(() => loadDb({})).toThrow(/DATABASE_URL/);
  });
});

import { describe, expect, test } from 'vitest';

import { EnvError, isProduction, loadDatabaseUrl, loadEnv } from '../src/env.js';

const base = {
  NODE_ENV: 'test',
  PORT: '3000',
  DATABASE_URL: 'postgres://voice:voice@localhost:5433/techmirai_voice_premium',
  PUBLIC_BASE_URL: 'https://example.ngrok-free.app',
  VAPI_API_KEY: 'test-vapi-api-key',
  VAPI_PUBLIC_KEY: 'test-vapi-public-key',
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
    'PORT',
    'NODE_ENV',
    'PUBLIC_BASE_URL',
    'VAPI_API_KEY',
    'VAPI_PUBLIC_KEY',
  ])('fails fast and names %s when it is missing', (key) => {
    const source = { ...base, [key]: undefined };

    expect(() => load(source)).toThrow(EnvError);
    expect(() => load(source)).toThrow(new RegExp(key));
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
    expect(isProduction(load({ ...base, NODE_ENV: 'production' }))).toBe(true);
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

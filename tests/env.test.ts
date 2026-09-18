import { describe, expect, test } from 'vitest';

import { EnvError, isProduction, loadEnv } from '../src/env.js';

const base = {
  NODE_ENV: 'test',
  PORT: '3000',
  DATABASE_URL: 'postgres://voice:voice@localhost:5433/techmirai_voice_premium',
};

const load = (source: NodeJS.ProcessEnv) => loadEnv(source, { readDotenvFile: false });

describe('loadEnv', () => {
  test('accepts a complete environment and coerces PORT to a number', () => {
    const env = load(base);

    expect(env.PORT).toBe(3000);
    expect(env.NODE_ENV).toBe('test');
  });

  test.each(['DATABASE_URL', 'PORT', 'NODE_ENV'])(
    'fails fast and names %s when it is missing',
    (key) => {
      const source = { ...base, [key]: undefined };

      expect(() => load(source)).toThrow(EnvError);
      expect(() => load(source)).toThrow(new RegExp(key));
    },
  );

  test('treats the optional Vapi and tunnel variables as optional', () => {
    const env = load({ ...base, PUBLIC_BASE_URL: '', VAPI_API_KEY: '' });

    expect(env.PUBLIC_BASE_URL).toBeUndefined();
    expect(env.VAPI_API_KEY).toBeUndefined();
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

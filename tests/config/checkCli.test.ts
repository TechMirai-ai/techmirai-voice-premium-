import { afterEach, describe, expect, test, vi } from 'vitest';

import { runCheck } from '../../src/config/checkCli.js';
import { SAKURA_ID } from '../helpers/clientFixtures.js';

const captureOutput = () => {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((line: unknown) => void out.push(String(line)));
  vi.spyOn(console, 'error').mockImplementation((line: unknown) => void err.push(String(line)));
  return { out, err };
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('config:check', () => {
  test('prints OK and a summary for a valid client, exiting 0', () => {
    const { out } = captureOutput();

    const code = runCheck(SAKURA_ID);
    const printed = out.join('\n');

    expect(code).toBe(0);
    expect(printed).toContain(`OK  ${SAKURA_ID}`);
    expect(printed).toMatch(/languages:\s+ja, en \(default: ja\)/);
    expect(printed).toMatch(/scripts:\s+18/);
    expect(printed).toMatch(/FAQ:\s+10/);
  });

  test('prints usage and exits non-zero when no client id is given', () => {
    const { err } = captureOutput();

    expect(runCheck(undefined)).toBe(1);
    expect(err.join('\n')).toContain('Usage: npm run config:check');
  });

  test('prints every problem with its path and exits non-zero', () => {
    const { err } = captureOutput();

    expect(runCheck('no-such-clinic')).toBe(1);
    expect(err.join('\n')).toContain('no config found at');
  });

  test('refuses a client id that tries to escape the clients directory', () => {
    const { err } = captureOutput();

    expect(runCheck('../etc')).toBe(1);
    expect(err.join('\n')).toMatch(/not a valid client id/);
  });
});

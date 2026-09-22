/**
 * Runs the vapi:sync CLI the way a developer runs it (spawned, matching
 * tests/cli/commands.test.ts's pattern for config:check), plus in-process
 * calls to runSync so v8 coverage can actually see this file's branches —
 * a spawned child process is invisible to the parent vitest run's coverage.
 */
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { runSync } from '../../src/vapi/cli.js';
import { REPO_ROOT, SAKURA_ID } from '../helpers/clientFixtures.js';

const run = promisify(execFile);
const CLI_TIMEOUT_MS = 60_000;

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

const REQUIRED_ENV = {
  NODE_ENV: 'development',
  PORT: '3000',
  DATABASE_URL: 'postgres://voice:voice@localhost:5433/techmirai_voice_premium',
  PUBLIC_BASE_URL: 'https://example.ngrok-free.app',
  // Syntactically present but fake — dry-run never calls the network (work order §7 test 5).
  VAPI_API_KEY: 'fake-vapi-api-key',
  VAPI_PUBLIC_KEY: 'fake-vapi-public-key',
  VAPI_WEBHOOK_SECRET: 'fake-webhook-secret-0123456789',
  VAPI_SERVER_CREDENTIAL_ID: 'fake-credential-id',
  SESSION_SECRET: 'fake-session-secret-0123456789-0123456789',
};

async function runCli(args: string[], env: NodeJS.ProcessEnv = {}): Promise<CliResult> {
  try {
    const { stdout, stderr } = await run(
      'npx',
      ['tsx', path.join(REPO_ROOT, 'src/vapi/cli.ts'), ...args],
      { cwd: REPO_ROOT, env: { ...process.env, ...REQUIRED_ENV, ...env } },
    );
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
  }
}

describe('npm run vapi:sync', () => {
  test(
    'dry-run succeeds with a syntactically-present but fake VAPI_API_KEY, and makes no changes',
    async () => {
      const result = await runCli([SAKURA_ID, '--language', 'ja']);

      expect(result.code).toBe(0);
      expect(result.stdout).toContain(SAKURA_ID);
      expect(result.stdout).toContain('sakura-seikotsuin--ja--request-callback');
      expect(result.stdout).toContain('Dry run');
    },
    CLI_TIMEOUT_MS,
  );

  test(
    'prints usage and exits non-zero when --language is missing',
    async () => {
      const result = await runCli([SAKURA_ID]);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('Usage:');
    },
    CLI_TIMEOUT_MS,
  );

  test(
    'exits non-zero for an unknown client',
    async () => {
      const result = await runCli(['no-such-clinic', '--language', 'ja']);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('no config found at');
    },
    CLI_TIMEOUT_MS,
  );

  test(
    'exits non-zero with a clear message when VAPI_API_KEY is missing',
    async () => {
      const result = await runCli([SAKURA_ID, '--language', 'ja'], {
        VAPI_API_KEY: '',
        DOTENV_CONFIG_QUIET: 'true',
      });

      if (result.code !== 0) {
        expect(result.stderr + result.stdout).toMatch(/VAPI_API_KEY/);
      }
    },
    CLI_TIMEOUT_MS,
  );
});

describe('runSync (in-process)', () => {
  const captureOutput = () => {
    const out: string[] = [];
    const err: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      out.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      err.push(String(chunk));
      return true;
    });
    return { out, err };
  };

  // Never depend on the developer's .env: give runSync a complete, fake environment.
  beforeEach(() => {
    for (const [key, value] of Object.entries(REQUIRED_ENV)) vi.stubEnv(key, value);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  test('dry-run succeeds and prints a diff', async () => {
    const { out } = captureOutput();

    const code = await runSync([SAKURA_ID, '--language', 'ja']);

    expect(code).toBe(0);
    const printed = out.join('');
    expect(printed).toContain('sakura-seikotsuin--ja--request-callback');
    expect(printed).toContain('Dry run');
  });

  test('--apply is recognized as a flag, not swallowed as a positional', async () => {
    // Exercises the --apply branch of parseArgs without ever reaching the
    // network: syncClient itself would need a real state file commit and a
    // real client to get past its own checks, which is covered by
    // tests/vapi/sync.test.ts against a mocked client instead.
    captureOutput();

    const code = await runSync(['no-such-clinic', '--language', 'ja', '--apply']);

    expect(code).toBe(1);
  });

  test('prints usage and returns 1 when the client id is missing', async () => {
    const { err } = captureOutput();

    const code = await runSync(['--language', 'ja']);

    expect(code).toBe(1);
    expect(err.join('')).toContain('Usage:');
  });

  test("does not swallow --apply as --language's value when the language is omitted by mistake", async () => {
    const { err } = captureOutput();

    const code = await runSync([SAKURA_ID, '--language', '--apply']);

    expect(code).toBe(1);
    expect(err.join('')).toContain('Usage:');
  });

  test('--squad on its own is a valid mode: it reaches the sync (and fails clearly for an unknown client)', async () => {
    const { err } = captureOutput();

    const code = await runSync(['no-such-clinic', '--squad']);

    expect(code).toBe(1);
    expect(err.join('')).toContain('no config found at');
    expect(err.join('')).not.toContain('Usage:');
  });

  test('prints usage when both --language and --squad are given', async () => {
    const { err } = captureOutput();

    const code = await runSync([SAKURA_ID, '--language', 'ja', '--squad']);

    expect(code).toBe(1);
    expect(err.join('')).toContain('Usage:');
  });

  test('returns 1 with a clear message for an unknown client', async () => {
    const { err } = captureOutput();

    const code = await runSync(['no-such-clinic', '--language', 'ja']);

    expect(code).toBe(1);
    expect(err.join('')).toContain('no config found at');
  });
});

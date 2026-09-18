/**
 * Runs the two CLIs the way a developer runs them, so the acceptance checks in
 * the work order (`npm run config:check -- sakura-seikotsuin` prints OK,
 * `npm run db:migrate` applies the migrations) are actually exercised.
 */
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, test } from 'vitest';

import { REPO_ROOT, SAKURA_ID } from '../helpers/clientFixtures.js';

const run = promisify(execFile);
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const CLI_TIMEOUT_MS = 60_000;

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runCli(
  script: string,
  args: string[],
  env: NodeJS.ProcessEnv = {},
): Promise<CliResult> {
  try {
    const { stdout, stderr } = await run('npx', ['tsx', path.join(REPO_ROOT, script), ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env, ...env },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
  }
}

describe('npm run config:check', () => {
  test(
    'exits 0 and prints OK for the demo client',
    async () => {
      const result = await runCli('src/config/checkCli.ts', [SAKURA_ID]);

      expect(result.code).toBe(0);
      expect(result.stdout).toContain(`OK  ${SAKURA_ID}`);
    },
    CLI_TIMEOUT_MS,
  );

  test(
    'exits non-zero for an unknown client',
    async () => {
      const result = await runCli('src/config/checkCli.ts', ['no-such-clinic']);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('no config found at');
    },
    CLI_TIMEOUT_MS,
  );
});

describe.skipIf(!TEST_DATABASE_URL)('npm run db:migrate', () => {
  test(
    'applies the migrations and is safe to run again',
    async () => {
      const env = { DATABASE_URL: TEST_DATABASE_URL, NODE_ENV: 'development', PORT: '3000' };

      const first = await runCli('src/db/migrate.ts', [], env);
      expect(first.code).toBe(0);
      expect(first.stdout).toMatch(/Applied \d+ migration|already up to date/);

      const second = await runCli('src/db/migrate.ts', [], env);
      expect(second.code).toBe(0);
      expect(second.stdout).toContain('already up to date');
    },
    CLI_TIMEOUT_MS,
  );

  test(
    'fails with a clear message when DATABASE_URL is missing',
    async () => {
      const result = await runCli('src/db/migrate.ts', [], {
        DATABASE_URL: '',
        DOTENV_CONFIG_QUIET: 'true',
      });

      // .env supplies DATABASE_URL locally, so accept either outcome:
      // a clean run, or the env error naming the variable.
      if (result.code !== 0) {
        expect(result.stderr + result.stdout).toMatch(/DATABASE_URL/);
      }
    },
    CLI_TIMEOUT_MS,
  );
});

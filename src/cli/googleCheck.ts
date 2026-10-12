/**
 * `npm run google:check` — runs the developer-archive smoke test (src/google/check.ts) against the
 * real Google APIs using the credentials in `.env`. Exits non-zero if any step fails.
 */
import { config as loadDotenv } from 'dotenv';
import { fileURLToPath } from 'node:url';

import { runGoogleCheck } from '../google/check.js';
import { loadGoogleArchiveConfig } from '../google/config.js';

const SYMBOLS = { pass: 'PASS', warn: 'WARN', fail: 'FAIL' } as const;

function print(text: string): void {
  process.stdout.write(`${text}\n`);
}

export async function runCheckCli(): Promise<number> {
  loadDotenv({ quiet: true });

  const config = loadGoogleArchiveConfig(process.env);
  if (!config) {
    print(
      'No GOOGLE_* variables are set — the archive is not configured. See docs/VP12-GOOGLE-SETUP.md.',
    );
    return 1;
  }

  const result = await runGoogleCheck(config);
  for (const step of result.steps) {
    print(`[${SYMBOLS[step.status]}] ${step.name}\n       ${step.detail}`);
  }
  print(
    result.ok ? '\nAll checks passed (see any WARN lines above).' : '\nThe archive is NOT ready.',
  );
  return result.ok ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runCheckCli().then(
    (code) => process.exit(code),
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : 'Check failed.'}\n`);
      process.exit(1);
    },
  );
}

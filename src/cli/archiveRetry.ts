/**
 * `npm run archive:retry` — one manual pass over the developer-archive job queue (VP-12): the same
 * work the cron-called /api/internal/archive-retry does, run from your own machine. Prints counts
 * only (never transcripts, ids or error text). Exits non-zero if the Google archive is not
 * configured or any job in this run failed.
 */
import { fileURLToPath } from 'node:url';

import { createPool } from '../db/pool.js';
import { loadEnv } from '../env.js';
import { createArchive } from '../google/createArchive.js';

function print(text: string): void {
  process.stdout.write(`${text}\n`);
}

export async function runArchiveRetry(): Promise<number> {
  const env = loadEnv();
  const pool = createPool({ connectionString: env.DATABASE_URL });
  try {
    const archive = createArchive({ db: pool, vapiApiKey: env.VAPI_API_KEY });
    if (!archive) {
      print(
        'The Google archive is not configured (no GOOGLE_* variables). See docs/VP12-GOOGLE-SETUP.md.',
      );
      return 1;
    }

    const summary = await archive.service.retryPending();
    print(`Claimed ${summary.claimed}: ${summary.done} done, ${summary.failed} failed this run.`);
    print(
      `Queue now: ${summary.queue.pending} pending, ${summary.queue.done} done, ${summary.queue.failed} gave up.`,
    );
    return summary.failed > 0 ? 1 : 0;
  } finally {
    await pool.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runArchiveRetry().then(
    (code) => process.exit(code),
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : 'Archive retry failed.'}\n`);
      process.exit(1);
    },
  );
}

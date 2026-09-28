/**
 * `npm run vapi:sync -- <clientId> --language <code> [--apply]`   one language's tools + assistant
 * `npm run vapi:sync -- <clientId> --squad [--apply]`              the Squad (run after every language)
 *
 * Dry-run is the default — prints the diff and makes zero API calls unless
 * --apply is passed explicitly (work order §3: apply must never be the
 * default). Exits non-zero on any failure.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createPool } from '../db/pool.js';
import { loadEnv } from '../env.js';
import { PgReservationServiceRepository } from '../repositories/reservationServiceRepository.js';
import { createVapiClient } from './client.js';
import { syncClient, syncSquad } from './sync.js';

// Writes directly to the streams rather than using console.log/error — this
// is a CLI entry point (same class of exception checkCli.ts gets from
// eslint's no-console override), and process.stdout/stderr avoids needing a
// second file added to that override list.
function printLine(text: string): void {
  process.stdout.write(`${text}\n`);
}

function printError(text: string): void {
  process.stderr.write(`${text}\n`);
}

interface ParsedArgs {
  clientId?: string;
  language?: string;
  squad: boolean;
  apply: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = { apply: false, squad: false };
  const positionals: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') {
      args.apply = true;
    } else if (arg === '--squad') {
      args.squad = true;
    } else if (arg === '--language') {
      // Never treat the next flag as this flag's value — leaves args.language
      // unset so the "Usage" error fires, instead of e.g. --apply silently
      // becoming the language code and never being recognized as a flag.
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith('--')) {
        args.language = next;
        index += 1;
      }
    } else if (arg !== undefined) {
      positionals.push(arg);
    }
  }

  const [clientId] = positionals;
  if (clientId !== undefined) args.clientId = clientId;
  return args;
}

const USAGE =
  'Usage: npm run vapi:sync -- <clientId> --language <code> [--apply]\n' +
  '       npm run vapi:sync -- <clientId> --squad [--apply]';

export async function runSync(argv: string[]): Promise<number> {
  const { clientId, language, squad, apply } = parseArgs(argv);

  // Exactly one of --language / --squad.
  if (!clientId || (language === undefined) === !squad) {
    printError(USAGE);
    return 1;
  }

  // Only --language needs a database connection (VP-8: the reservation
  // services list is fetched per-language render, not for the squad sync).
  const env = loadEnv();
  const pool = squad ? undefined : createPool({ connectionString: env.DATABASE_URL });

  try {
    const client = createVapiClient(env.VAPI_API_KEY);

    const result = squad
      ? await syncSquad(clientId, { dryRun: !apply, client })
      : await syncClient(clientId, language ?? '', {
          dryRun: !apply,
          client,
          baseUrl: env.PUBLIC_BASE_URL,
          credentialId: env.VAPI_SERVER_CREDENTIAL_ID,
          services: new PgReservationServiceRepository(pool!),
        });

    for (const line of result.diffLines) {
      printLine(line);
    }

    printLine('');
    printLine(
      result.dryRun
        ? 'Dry run — no changes were made. Re-run with --apply to sync for real.'
        : 'Synced.',
    );

    if (!result.dryRun) {
      printLine(
        squad
          ? `Reminder: regenerate the test page (it targets the squad): npm run vapi:test-page -- ${clientId}`
          : `Reminder: once every language is synced (a new assistant gets a new id), sync the squad: npm run vapi:sync -- ${clientId} --squad --apply`,
      );
    }

    return 0;
  } catch (error) {
    printError(error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    if (pool) await pool.end();
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  runSync(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      printError(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}

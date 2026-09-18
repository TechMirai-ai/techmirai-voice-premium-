/**
 * `npm run vapi:sync -- <clientId> --language <code> [--apply]`
 *
 * Dry-run is the default — prints the diff and makes zero API calls unless
 * --apply is passed explicitly (work order §3: apply must never be the
 * default). Exits non-zero on any failure.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadEnv } from '../env.js';
import { createVapiClient } from './client.js';
import { syncClient } from './sync.js';

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
  apply: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = { apply: false };
  const positionals: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') {
      args.apply = true;
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

export async function runSync(argv: string[]): Promise<number> {
  const { clientId, language, apply } = parseArgs(argv);

  if (!clientId || !language) {
    printError('Usage: npm run vapi:sync -- <clientId> --language <code> [--apply]');
    return 1;
  }

  try {
    const env = loadEnv();
    const client = createVapiClient(env.VAPI_API_KEY);

    const result = await syncClient(clientId, language, {
      dryRun: !apply,
      client,
      baseUrl: env.PUBLIC_BASE_URL,
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

    return 0;
  } catch (error) {
    printError(error instanceof Error ? error.message : String(error));
    return 1;
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

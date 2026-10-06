/**
 * `npm run staff:create -- <email> <clientId>`
 *
 * Creates one staff account with a random temporary password, printed once
 * and never stored anywhere else. There is no public signup route (VP-5 §3)
 * — this CLI is how every real account is created, including the owner's
 * own first login (§4.5).
 *
 * Writes directly to the streams rather than console.log/error, same as
 * src/vapi/cli.ts — a CLI entry point, and process.stdout/stderr avoids
 * needing an eslint no-console override.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createPool } from '../db/pool.js';
import { loadDatabaseUrl } from '../env.js';
import { generateTemporaryPassword, hashPassword } from '../lib/auth.js';
import {
  PgStaffUserRepository,
  type StaffUserRepository,
} from '../repositories/staffUserRepository.js';

function printLine(text: string): void {
  process.stdout.write(`${text}\n`);
}
function printError(text: string): void {
  process.stderr.write(`${text}\n`);
}

const USAGE = 'Usage: npm run staff:create -- <email> <clientId>';
const UNIQUE_VIOLATION = '23505';

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === UNIQUE_VIOLATION
  );
}

export interface CreateStaffUserDeps {
  staffUsers: StaffUserRepository;
}

export async function runCreateStaffUser(
  argv: string[],
  deps: CreateStaffUserDeps,
): Promise<number> {
  const [email, clientId] = argv;
  if (!email || !clientId) {
    printError(USAGE);
    return 1;
  }

  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);

  try {
    const staffUser = await deps.staffUsers.create({ clientId, email, passwordHash });
    printLine(`Created staff account ${staffUser.email} (client: ${staffUser.clientId}).`);
    printLine('Temporary password (shown once — it is not stored anywhere else):');
    printLine(`  ${temporaryPassword}`);
    printLine('They must set a new password the first time they log in.');
    return 0;
  } catch (error) {
    if (isUniqueViolation(error)) {
      printError(`A staff account with the email "${email}" already exists.`);
      return 1;
    }
    printError(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  (async () => {
    const databaseUrl = loadDatabaseUrl();
    const pool = createPool({ connectionString: databaseUrl });
    try {
      process.exitCode = await runCreateStaffUser(process.argv.slice(2), {
        staffUsers: new PgStaffUserRepository(pool),
      });
    } finally {
      await pool.end();
    }
  })().catch((error: unknown) => {
    printError(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

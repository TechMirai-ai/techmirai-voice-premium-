/**
 * `npm run demo:clear-calls -- <clientId> [--commit] [--allow-live]`
 *
 * Wipes ONE client's call history so a test run starts fresh: that client's rows in call_logs,
 * appointment_changes, appointments (their notification_log rows go with them — ON DELETE CASCADE),
 * callback_requests, call_topics, call_archive_jobs and consultation_requests, plus the client's
 * notification_log rows that belong to no appointment (consultation SMS/LINE deliveries and the
 * daily-cap notice; they would otherwise keep counting toward the daily caps). Every statement is
 * filtered by client_id, and the id must be a client that exists under clients/.
 *
 * A client with `status: live` in its client.yaml is refused unless BOTH --commit and --allow-live
 * are given (src/cli/clientScopedCommand.ts). Preview works for any client.
 *
 * Preview by default: without --commit the transaction is rolled back, so the first run only shows
 * the row counts that WOULD be deleted. Nothing but counts is printed. Run it deliberately, by
 * hand; the app, the tests and migrations never run it, and a commit cannot be undone.
 *
 * Not touched: staff users and sessions, the reservation services/demo patients, the archived
 * Google Sheet/Drive files, and the Vapi call records themselves.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createPool } from '../db/pool.js';
import { loadDatabaseUrl } from '../env.js';
import {
  affectedRows,
  runClientScopedCommand,
  type ClientScopedAction,
} from './clientScopedCommand.js';

export const CLEAR_DEMO_CALLS_USAGE =
  'Usage: npm run demo:clear-calls -- <clientId> [--commit] [--allow-live]';

/** Order matters: rows that reference appointments go before appointments. */
const TABLES = [
  'call_logs',
  'appointment_changes',
  'appointments',
  'callback_requests',
  'call_topics',
  'call_archive_jobs',
  'consultation_requests',
] as const;

export const clearDemoCallsAction: ClientScopedAction = {
  usage: CLEAR_DEMO_CALLS_USAGE,
  async apply(db, clientId) {
    const counts: Record<string, number> = {};
    for (const table of TABLES) {
      counts[table] = await affectedRows(
        db,
        `DELETE FROM ${table} WHERE client_id = $1 RETURNING 1`,
        [clientId],
      );
    }
    // Consultation deliveries belong to no appointment, so the cascade above does not reach them.
    counts.notification_log_without_appointment = await affectedRows(
      db,
      'DELETE FROM notification_log WHERE client_id = $1 AND appointment_id IS NULL RETURNING 1',
      [clientId],
    );
    return counts;
  },
};

function printLine(text: string): void {
  process.stdout.write(`${text}\n`);
}
function printError(text: string): void {
  process.stderr.write(`${text}\n`);
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  (async () => {
    const pool = createPool({ connectionString: loadDatabaseUrl() });
    // One dedicated connection: BEGIN … COMMIT/ROLLBACK must all run on the same session.
    const client = await pool.connect();
    try {
      process.exitCode = await runClientScopedCommand(process.argv.slice(2), clearDemoCallsAction, {
        db: client,
        print: printLine,
        printError,
      });
    } finally {
      client.release();
      await pool.end();
    }
  })().catch((error: unknown) => {
    printError(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

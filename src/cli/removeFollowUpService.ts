/**
 * `npm run services:remove-follow-up -- <clientId> [--commit]`
 *
 * Removes one client's "Follow-up" service (id 'follow-up') from reservation_services so it is no
 * longer offered. The demo seed only INSERTs, so deleting it from the seed file does not remove an
 * already-seeded row — this does. Replaces scripts/remove-follow-up-service.sql.
 *
 * Existing appointments that booked Follow-up keep their service_name snapshot ("Follow-up") for
 * history; only their service_id link is cleared, because appointments.service_id is a foreign key
 * to reservation_services and the row cannot be deleted while anything points at it. Every
 * statement is filtered by client_id, and the id must be a client that exists under clients/.
 *
 * Preview by default: without --commit the transaction is rolled back, so the first run only shows
 * the counts. Only counts are printed. After a commit, run `npm run vapi:sync` — the service list
 * is baked into the assistant prompt and the book_appointment tool's serviceId enum at sync time,
 * so the live assistants keep offering Follow-up until you sync.
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

export const REMOVE_FOLLOW_UP_USAGE =
  'Usage: npm run services:remove-follow-up -- <clientId> [--commit]';

const SERVICE_ID = 'follow-up';

export const removeFollowUpAction: ClientScopedAction = {
  usage: REMOVE_FOLLOW_UP_USAGE,
  async apply(db, clientId) {
    // Appointments first: they point at the service.
    const appointmentsUnlinked = await affectedRows(
      db,
      `UPDATE appointments SET service_id = NULL
       WHERE service_id = $2 AND client_id = $1 RETURNING 1`,
      [clientId, SERVICE_ID],
    );
    const servicesDeleted = await affectedRows(
      db,
      `DELETE FROM reservation_services WHERE id = $2 AND client_id = $1 RETURNING 1`,
      [clientId, SERVICE_ID],
    );
    return { appointments_unlinked: appointmentsUnlinked, services_deleted: servicesDeleted };
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
      process.exitCode = await runClientScopedCommand(process.argv.slice(2), removeFollowUpAction, {
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

/**
 * Shared front half of the destructive, single-client CLIs (demo:clear-calls,
 * services:remove-follow-up): argument parsing, the known-client guard, and a
 * preview-by-default transaction that prints row counts only.
 */
import type { LoadClientOptions } from '../config/loadClient.js';
import { isKnownClient, unknownClientMessage } from '../config/knownClient.js';
import type { Queryable } from '../db/pool.js';

export const COMMIT_FLAG = '--commit';

export type ParsedArgs =
  { ok: true; clientId: string; commit: boolean } | { ok: false; error: string };

/** `<clientId> [--commit]`, in any order. A missing id, an extra argument or a typo'd flag fails. */
export function parseClientScopedArgs(argv: string[], usage: string): ParsedArgs {
  const commit = argv.includes(COMMIT_FLAG);
  const positional = argv.filter((arg) => arg !== COMMIT_FLAG);
  const [clientId, ...extra] = positional;
  if (!clientId || extra.length > 0 || clientId.startsWith('-')) {
    return { ok: false, error: usage };
  }
  return { ok: true, clientId, commit };
}

export interface ClientScopedDeps {
  /** A single connection (one transaction), e.g. a pg PoolClient. */
  db: Queryable;
  /** Overrides the clients directory (tests). */
  clientsOptions?: LoadClientOptions;
  print(line: string): void;
  printError(line: string): void;
}

/** Row counts by label — the only thing these commands ever print about data. */
export type Counts = Record<string, number>;

export interface ClientScopedAction {
  usage: string;
  /** Runs the changes inside the open transaction and returns how many rows each affected. */
  apply(db: Queryable, clientId: string): Promise<Counts>;
}

/** `WITH d AS (<delete/update … RETURNING 1>) SELECT count(*)` — a statement's affected-row count. */
export async function affectedRows(db: Queryable, sql: string, values: unknown[]): Promise<number> {
  const { rows } = await db.query(`WITH d AS (${sql}) SELECT count(*)::int AS n FROM d`, values);
  return (rows[0] as { n: number } | undefined)?.n ?? 0;
}

export async function runClientScopedCommand(
  argv: string[],
  action: ClientScopedAction,
  deps: ClientScopedDeps,
): Promise<number> {
  const parsed = parseClientScopedArgs(argv, action.usage);
  if (!parsed.ok) {
    deps.printError(parsed.error);
    return 1;
  }
  const { clientId, commit } = parsed;
  if (!isKnownClient(clientId, deps.clientsOptions)) {
    deps.printError(unknownClientMessage(clientId));
    return 1;
  }

  await deps.db.query('BEGIN');
  try {
    const counts = await action.apply(deps.db, clientId);
    await deps.db.query(commit ? 'COMMIT' : 'ROLLBACK');
    deps.print(`Client: ${clientId}`);
    for (const [label, count] of Object.entries(counts)) deps.print(`  ${label}: ${count}`);
    deps.print(
      commit
        ? 'Committed.'
        : `Preview only — nothing was changed. Run again with ${COMMIT_FLAG} to apply.`,
    );
    return 0;
  } catch (error) {
    await deps.db.query('ROLLBACK').catch(() => undefined);
    deps.printError(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

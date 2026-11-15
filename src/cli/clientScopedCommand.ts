/**
 * Shared front half of the destructive, single-client CLIs (demo:clear-calls,
 * services:remove-follow-up): argument parsing, the known-client guard, and a
 * preview-by-default transaction that prints row counts only.
 */
import { loadClient, type LoadClientOptions } from '../config/loadClient.js';
import { isKnownClient, unknownClientMessage } from '../config/knownClient.js';
import type { Queryable } from '../db/pool.js';

export const COMMIT_FLAG = '--commit';
/** Needed, on top of --commit, to change a client whose client.yaml says `status: live`. */
export const ALLOW_LIVE_FLAG = '--allow-live';

export type ParsedArgs =
  | { ok: true; clientId: string; commit: boolean; allowLive: boolean }
  | { ok: false; error: string };

/** `<clientId> [--commit] [--allow-live]`, in any order. A missing id, an extra argument or a typo'd flag fails. */
export function parseClientScopedArgs(argv: string[], usage: string): ParsedArgs {
  const commit = argv.includes(COMMIT_FLAG);
  const allowLive = argv.includes(ALLOW_LIVE_FLAG);
  const positional = argv.filter((arg) => arg !== COMMIT_FLAG && arg !== ALLOW_LIVE_FLAG);
  const [clientId, ...extra] = positional;
  if (!clientId || extra.length > 0 || clientId.startsWith('-')) {
    return { ok: false, error: usage };
  }
  return { ok: true, clientId, commit, allowLive };
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
  const { clientId, commit, allowLive } = parsed;
  if (!isKnownClient(clientId, deps.clientsOptions)) {
    deps.printError(unknownClientMessage(clientId));
    return 1;
  }

  // A client whose config says `status: live` holds real data: changing it needs --allow-live as
  // well as --commit. A preview changes nothing, so it always works. An unreadable config fails
  // closed: we cannot tell whether the client is live.
  let live: boolean;
  try {
    live = loadClient(clientId, deps.clientsOptions).status === 'live';
  } catch {
    deps.printError(
      `Cannot read clients/${clientId}/client.yaml, so I cannot tell whether it is live. Nothing was changed.`,
    );
    return 1;
  }
  if (commit && live && !allowLive) {
    deps.printError(
      `Refused: ${clientId} is a LIVE client (status: live in its client.yaml). Nothing was changed. ` +
        `Preview without ${COMMIT_FLAG} to see the counts; to really change live data, add ${ALLOW_LIVE_FLAG}.`,
    );
    return 1;
  }

  await deps.db.query('BEGIN');
  try {
    const counts = await action.apply(deps.db, clientId);
    await deps.db.query(commit ? 'COMMIT' : 'ROLLBACK');
    deps.print(`Client: ${clientId}${live ? ' (LIVE)' : ''}`);
    for (const [label, count] of Object.entries(counts)) deps.print(`  ${label}: ${count}`);
    deps.print(
      commit
        ? 'Committed.'
        : `Preview only — nothing was changed. Run again with ${COMMIT_FLAG}${live ? ` ${ALLOW_LIVE_FLAG}` : ''} to apply.`,
    );
    return 0;
  } catch (error) {
    await deps.db.query('ROLLBACK').catch(() => undefined);
    deps.printError(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

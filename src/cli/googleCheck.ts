/**
 * `npm run google:check -- <clientId>` or `npm run google:check -- --all` — runs the archive smoke
 * test (src/google/check.ts) against the real Google APIs, once per client, using the credentials in
 * `.env`. Each client is checked against ITS OWN Sheet and Drive folders (its `archive` block in
 * client.yaml): the Sheet is reachable and has the expected header row, and both folders accept a
 * test upload. A client whose archive variables are unset is reported as a FAILURE and no Google
 * call is made for it. `--all` additionally fails if two clients resolve to the same Sheet or folder.
 * Exits non-zero if any step fails.
 */
import { config as loadDotenv } from 'dotenv';
import { fileURLToPath } from 'node:url';

import { listClientIds } from '../config/knownClient.js';
import { loadClient } from '../config/loadClient.js';
import type { ClientConfig } from '../config/schema.js';
import {
  resolveArchiveDestination,
  type ArchiveDestination,
} from '../google/archiveDestination.js';
import { runGoogleCheck, type CheckResult } from '../google/check.js';
import { loadGoogleArchiveConfig, type GoogleArchiveConfig } from '../google/config.js';

const SYMBOLS = { pass: 'PASS', warn: 'WARN', fail: 'FAIL' } as const;
const ALL_FLAG = '--all';
const USAGE = 'Usage: npm run google:check -- <clientId>   or   npm run google:check -- --all';

function print(text: string): void {
  process.stdout.write(`${text}\n`);
}

export interface CheckCliDeps {
  env?: NodeJS.ProcessEnv;
  loadClientConfig?: (clientId: string) => ClientConfig;
  listClients?: () => string[];
  /** For tests; defaults to the real check against Google. */
  runCheck?: (config: GoogleArchiveConfig, destination: ArchiveDestination) => Promise<CheckResult>;
}

/** Ids that more than one client points at, as "<id-kind> is shared by: clientA, clientB" lines. */
function sharedDestinations(destinations: ReadonlyMap<string, ArchiveDestination>): string[] {
  const owners = new Map<string, string[]>();
  for (const [clientId, destination] of destinations) {
    for (const [kind, id] of Object.entries(destination)) {
      const key = `${kind}\u0000${id}`;
      owners.set(key, [...(owners.get(key) ?? []), clientId]);
    }
  }
  return [...owners]
    .filter(([, clients]) => clients.length > 1)
    .map(([key, clients]) => `${key.split('\u0000')[0]} is shared by: ${clients.join(', ')}`);
}

function printResult(clientId: string, result: CheckResult): void {
  print(`\n=== ${clientId} ===`);
  for (const step of result.steps) {
    print(`[${SYMBOLS[step.status]}] ${step.name}\n       ${step.detail}`);
  }
}

export async function runCheckCli(
  argv: readonly string[] = process.argv.slice(2),
  deps: CheckCliDeps = {},
): Promise<number> {
  const env = deps.env ?? process.env;
  const listClients = deps.listClients ?? listClientIds;
  const loadClientConfig = deps.loadClientConfig ?? loadClient;
  const runCheck = deps.runCheck ?? ((config, destination) => runGoogleCheck(config, destination));

  const all = argv.includes(ALL_FLAG);
  const named = argv.filter((arg) => arg !== ALL_FLAG);
  if ((all && named.length > 0) || (!all && named.length !== 1)) {
    print(`${USAGE}\nKnown clients: ${listClients().join(', ')}`);
    return 1;
  }
  const clientIds = all ? listClients() : named;

  const config = loadGoogleArchiveConfig(env);
  if (!config) {
    print(
      'No GOOGLE_* credential variables are set — the archive is not configured. See docs/VP12-GOOGLE-SETUP.md.',
    );
    return 1;
  }

  let ok = true;
  const destinations = new Map<string, ArchiveDestination>();
  for (const clientId of clientIds) {
    const target = resolveArchiveDestination(clientId, loadClientConfig, env);
    if (!target.ok) {
      print(`\n=== ${clientId} ===\n[FAIL] Archive destination\n       ${target.message}`);
      ok = false;
      continue;
    }
    destinations.set(clientId, target.destination);
    const result = await runCheck(config, target.destination);
    printResult(clientId, result);
    ok = ok && result.ok;
  }

  const shared = sharedDestinations(destinations);
  if (shared.length > 0) {
    print('\n=== Isolation ===');
    for (const line of shared) {
      print(`[FAIL] ${line}\n       Each client needs its own Sheet and folders.`);
    }
    ok = false;
  }

  print(ok ? '\nAll checks passed (see any WARN lines above).' : '\nThe archive is NOT ready.');
  return ok ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  loadDotenv({ quiet: true });
  runCheckCli().then(
    (code) => process.exit(code),
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : 'Check failed.'}\n`);
      process.exit(1);
    },
  );
}

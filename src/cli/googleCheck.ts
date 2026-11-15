/**
 * `npm run google:check -- <clientId>` or `npm run google:check -- --all` — runs the archive smoke
 * test (src/google/check.ts) against the real Google APIs using the credentials in `.env`. Each
 * client is checked against the Sheet and Drive folders named by ITS `archive` block in client.yaml:
 * the Sheet is reachable and has the expected header row, and both folders accept a test upload.
 * A client whose archive variables are unset is reported as a FAILURE and no Google call is made
 * for it.
 *
 * `--all` also enforces isolation (src/config/archiveSharing.ts): two clients pointing at the same
 * variable name or the same Sheet/folder id FAIL, unless every client involved carries
 * `archive.sharedDemoArchive: true` — then it is only an INFO line, and the shared Sheet and
 * folders are checked once, not once per demo client. Exits non-zero if any step fails.
 */
import { config as loadDotenv } from 'dotenv';
import { fileURLToPath } from 'node:url';

import { analyzeSharing, type SharingEntry, type SharingGroup } from '../config/archiveSharing.js';
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

interface Checkable {
  clientId: string;
  destination: ArchiveDestination;
}

function printResult(label: string, result: CheckResult): void {
  print(`\n=== ${label} ===`);
  for (const step of result.steps) {
    print(`[${SYMBOLS[step.status]}] ${step.name}\n       ${step.detail}`);
  }
}

/** The sharing-rule entry for one client: its variable names, plus its resolved ids when known. */
function sharingEntry(
  clientId: string,
  loadClientConfig: (clientId: string) => ClientConfig,
  destination: ArchiveDestination | undefined,
): SharingEntry | undefined {
  try {
    const { archive } = loadClientConfig(clientId);
    const keys = [archive.sheetIdEnv, archive.audioFolderIdEnv, archive.transcriptFolderIdEnv].map(
      (name) => `env ${name}`,
    );
    if (destination) {
      keys.push(
        `sheetId ${destination.sheetId}`,
        `audioFolderId ${destination.audioFolderId}`,
        `transcriptFolderId ${destination.transcriptFolderId}`,
      );
    }
    return { clientId, shared: archive.sharedDemoArchive === true, keys };
  } catch {
    return undefined; // unknown client: reported as "not configured" by the destination step
  }
}

/** One line per distinct client set, so a shared Sheet + two folders is not three lines. */
function groupByClients(groups: readonly SharingGroup[]): Array<[string, string[]]> {
  const byClients = new Map<string, string[]>();
  for (const { key, clients } of groups) {
    const label = clients.join(', ');
    const kind = key.split(' ')[0]!;
    byClients.set(label, [
      ...(byClients.get(label) ?? []),
      kind === 'env' ? 'variable names' : kind,
    ]);
  }
  return [...byClients];
}

function reportSharing(entries: readonly SharingEntry[]): boolean {
  const { conflicts, sharedByDemo } = analyzeSharing(entries);
  if (conflicts.length === 0 && sharedByDemo.length === 0) return true;

  print('\n=== Isolation ===');
  for (const [clients, kinds] of groupByClients(sharedByDemo)) {
    print(`[INFO] shared by demo clients: ${clients} (${[...new Set(kinds)].join(', ')})`);
  }
  for (const [clients, kinds] of groupByClients(conflicts)) {
    print(
      `[FAIL] ${clients} share ${[...new Set(kinds)].join(', ')}\n       Sharing is allowed only when every client involved sets archive.sharedDemoArchive: true (demo clients). A real client needs its own Sheet and folders.`,
    );
  }
  return conflicts.length === 0;
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
  const checkable: Checkable[] = [];
  const entries: SharingEntry[] = [];
  for (const clientId of clientIds) {
    const target = resolveArchiveDestination(clientId, loadClientConfig, env);
    if (!target.ok) {
      print(`\n=== ${clientId} ===\n[FAIL] Archive destination\n       ${target.message}`);
      ok = false;
    } else {
      checkable.push({ clientId, destination: target.destination });
    }
    const entry = sharingEntry(
      clientId,
      loadClientConfig,
      target.ok ? target.destination : undefined,
    );
    if (entry) entries.push(entry);
  }

  // Clients that resolve to the identical Sheet + folders are checked once (the demo archive).
  const byDestination = new Map<string, Checkable[]>();
  for (const item of checkable) {
    const { sheetId, audioFolderId, transcriptFolderId } = item.destination;
    const key = JSON.stringify([sheetId, audioFolderId, transcriptFolderId]);
    byDestination.set(key, [...(byDestination.get(key) ?? []), item]);
  }
  for (const group of byDestination.values()) {
    const result = await runCheck(config, group[0]!.destination);
    const label = group.map((item) => item.clientId).join(', ');
    printResult(group.length > 1 ? `${label} (shared destination, checked once)` : label, result);
    ok = ok && result.ok;
  }

  if (all) ok = reportSharing(entries) && ok;

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

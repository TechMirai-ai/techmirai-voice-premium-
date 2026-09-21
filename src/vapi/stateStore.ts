/**
 * Reads and writes `.vapi-state.<clientId>.json` at the repo root.
 *
 * This file is committed to git in plain text — it holds only resource names
 * mapped to Vapi UUIDs, nothing secret (see CLAUDE.md / VP-2 work order §3).
 * Because it's committed, git itself is the rollback mechanism: `sync.ts`
 * refuses to run a real sync while this file has uncommitted changes, using
 * `getStateFileGitStatus` below.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

import { defaultClientsDir } from '../config/loadClient.js';

export interface VapiState {
  tools: Record<string, string>;
  assistants: Record<string, string>;
  squads: Record<string, string>;
}

export interface StateStoreOptions {
  /** Overrides the repo root the state file is resolved against. Tests use a temp dir. */
  repoRoot?: string;
}

function repoRoot(options: StateStoreOptions): string {
  return options.repoRoot ?? path.dirname(defaultClientsDir());
}

export function stateFilePath(clientId: string, options: StateStoreOptions = {}): string {
  return path.join(repoRoot(options), `.vapi-state.${clientId}.json`);
}

/** Empty state — the shape a client gets on its first-ever sync. */
function emptyState(): VapiState {
  return { tools: {}, assistants: {}, squads: {} };
}

/** Never throws on a missing file: absence means "nothing synced yet". */
export function readState(clientId: string, options: StateStoreOptions = {}): VapiState {
  const file = stateFilePath(clientId, options);
  if (!existsSync(file)) return emptyState();

  const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<VapiState>;
  return {
    tools: { ...(parsed.tools ?? {}) },
    assistants: { ...(parsed.assistants ?? {}) },
    squads: { ...(parsed.squads ?? {}) },
  };
}

export function writeState(
  clientId: string,
  state: VapiState,
  options: StateStoreOptions = {},
): void {
  const file = stateFilePath(clientId, options);
  writeFileSync(file, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

export interface StateFileGitStatus {
  /** False on a client's first-ever sync, before the file has been created. */
  fileExists: boolean;
  /** True for untracked, modified, or staged-but-uncommitted state — sync.ts must refuse in all three cases. */
  hasUncommittedChanges: boolean;
}

/**
 * Runs `git status --porcelain` scoped to just the state file. Uses
 * `execFileSync` with an argument array (never a shell string built from
 * `clientId` or a path) so nothing here is vulnerable to command injection.
 */
export function getStateFileGitStatus(
  clientId: string,
  options: StateStoreOptions = {},
): StateFileGitStatus {
  const root = repoRoot(options);
  const file = stateFilePath(clientId, options);

  if (!existsSync(file)) {
    return { fileExists: false, hasUncommittedChanges: false };
  }

  const relativePath = path.relative(root, file);
  const output = execFileSync('git', ['status', '--porcelain', '--', relativePath], {
    cwd: root,
    encoding: 'utf8',
  });

  return { fileExists: true, hasUncommittedChanges: output.trim().length > 0 };
}

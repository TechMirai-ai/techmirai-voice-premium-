/**
 * Resolves WHERE one client's calls are archived: its Google Sheet and its two Drive folders.
 *
 * The client's `archive` block in client.yaml names three env vars; their values are read from the
 * environment here, and only here. FAIL CLOSED: an unknown client, an unreadable config, or any
 * unset / blank variable yields `ok: false` — never another client's destination, never a default.
 * The caller makes no Google call for a job without a destination.
 *
 * The failure message names the client and the env var NAMES that are unset (never values), so it is
 * safe to store in `call_archive_jobs.last_error`.
 */
import type { ClientConfig } from '../config/schema.js';

export interface ArchiveDestination {
  sheetId: string;
  audioFolderId: string;
  transcriptFolderId: string;
}

export type DestinationResult =
  { ok: true; destination: ArchiveDestination } | { ok: false; message: string };

export type DestinationResolver = (clientId: string) => DestinationResult;

/** The distinct, greppable wording of the failure; also what the job's `last_error` starts with. */
export function destinationNotConfigured(clientId: string, reason: string): string {
  return `archive destination not configured for ${clientId} (${reason})`;
}

export function resolveArchiveDestination(
  clientId: string,
  loadClientConfig: (clientId: string) => ClientConfig,
  env: NodeJS.ProcessEnv,
): DestinationResult {
  let archive: ClientConfig['archive'] | undefined;
  try {
    archive = loadClientConfig(clientId).archive;
  } catch {
    return {
      ok: false,
      message: destinationNotConfigured(clientId, 'no readable client config'),
    };
  }
  if (!archive) {
    return { ok: false, message: destinationNotConfigured(clientId, 'no archive block') };
  }

  const read = (name: string): string => (env[name] ?? '').trim();
  const sheetId = read(archive.sheetIdEnv);
  const audioFolderId = read(archive.audioFolderIdEnv);
  const transcriptFolderId = read(archive.transcriptFolderIdEnv);

  const unset = [
    sheetId ? undefined : archive.sheetIdEnv,
    audioFolderId ? undefined : archive.audioFolderIdEnv,
    transcriptFolderId ? undefined : archive.transcriptFolderIdEnv,
  ].filter((name): name is string => name !== undefined);
  if (unset.length > 0) {
    return {
      ok: false,
      message: destinationNotConfigured(clientId, `unset: ${unset.join(', ')}`),
    };
  }

  return { ok: true, destination: { sheetId, audioFolderId, transcriptFolderId } };
}

/** Resolver bound to a client loader and an environment (what the service and factory share). */
export function destinationResolver(
  loadClientConfig: (clientId: string) => ClientConfig,
  env: NodeJS.ProcessEnv,
): DestinationResolver {
  return (clientId) => resolveArchiveDestination(clientId, loadClientConfig, env);
}

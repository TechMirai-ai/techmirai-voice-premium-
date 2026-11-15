/**
 * "Is this a client we actually have?" — true only when `clients/<clientId>/client.yaml` exists.
 * Used by the CLIs that write or delete client-scoped rows, so a typo can never create or wipe rows
 * under an id that belongs to no client. It checks existence only; `npm run config:check` is the
 * command that validates the file's contents.
 *
 * A non-slug id (path separators, uppercase, …) is simply "not known": `clientDir` rejects it
 * before it can touch the filesystem.
 */
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

import {
  CLIENT_CONFIG_FILENAME,
  clientDir,
  defaultClientsDir,
  type LoadClientOptions,
} from './loadClient.js';

export function isKnownClient(clientId: string, options: LoadClientOptions = {}): boolean {
  try {
    return existsSync(path.join(clientDir(clientId, options), CLIENT_CONFIG_FILENAME));
  } catch {
    return false;
  }
}

/** Every client id that has a `clients/<id>/client.yaml`, sorted. */
export function listClientIds(options: LoadClientOptions = {}): string[] {
  const root = options.clientsDir ?? defaultClientsDir();
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && isKnownClient(entry.name, options))
    .map((entry) => entry.name)
    .sort();
}

/** The message every guarded CLI prints for an id that is not a client. */
export function unknownClientMessage(clientId: string): string {
  return `Unknown client "${clientId}": there is no clients/${clientId}/${CLIENT_CONFIG_FILENAME}. Nothing was changed.`;
}

/**
 * Loads and validates one client's `clients/<clientId>/client.yaml`.
 *
 * `clientId` is untrusted input (it can arrive from a CLI argument or, later,
 * from an HTTP request), so it is matched against the slug pattern before it
 * ever touches the filesystem, and the resolved path is checked to be inside
 * the clients directory.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse as parseYaml } from 'yaml';

import { ClientConfigError } from './issues.js';
import type { ClientConfig, ParsedClientConfig } from './schema.js';
import { parseClientConfig, SLUG_PATTERN } from './schema.js';

export const CLIENT_CONFIG_FILENAME = 'client.yaml';

export interface LoadClientOptions {
  /** Overrides the clients directory. Used by tests with fixture configs. */
  clientsDir?: string;
}

/**
 * Walks up from this module until it finds the repo root (the directory that
 * holds both `package.json` and `clients/`), so the loader works when run from
 * source via tsx and when run from `dist/`.
 */
function findClientsDir(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));

  for (let depth = 0; depth < 6; depth += 1) {
    if (existsSync(path.join(dir, 'package.json')) && existsSync(path.join(dir, 'clients'))) {
      return path.join(dir, 'clients');
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  throw new Error('Could not locate the "clients" directory from ' + import.meta.url);
}

let cachedClientsDir: string | undefined;

export function defaultClientsDir(): string {
  cachedClientsDir ??= findClientsDir();
  return cachedClientsDir;
}

/** Resolves the folder for a client id, rejecting anything that is not a slug. */
export function clientDir(clientId: string, options: LoadClientOptions = {}): string {
  if (typeof clientId !== 'string' || !SLUG_PATTERN.test(clientId)) {
    throw new ClientConfigError(clientId, [
      {
        path: 'clientId',
        message: `"${clientId}" is not a valid client id — expected a lowercase slug such as "example-clinic"`,
      },
    ]);
  }

  const root = path.resolve(options.clientsDir ?? defaultClientsDir());
  const resolved = path.resolve(root, clientId);

  // Belt and braces: the slug pattern already excludes "." "/" and "\".
  if (resolved !== path.join(root, clientId) || !resolved.startsWith(root + path.sep)) {
    throw new ClientConfigError(clientId, [
      { path: 'clientId', message: 'resolves outside the clients directory' },
    ]);
  }

  return resolved;
}

/** Loads a client config and returns it together with any non-fatal warnings. */
export function loadClientWithWarnings(
  clientId: string,
  options: LoadClientOptions = {},
): ParsedClientConfig {
  const file = path.join(clientDir(clientId, options), CLIENT_CONFIG_FILENAME);

  if (!existsSync(file)) {
    throw new ClientConfigError(clientId, [
      { path: '(file)', message: `no config found at ${file}` },
    ]);
  }

  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(file, 'utf8'));
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new ClientConfigError(clientId, [
      { path: '(file)', message: `invalid YAML — ${message}` },
    ]);
  }

  return parseClientConfig(raw, clientId);
}

/** Loads a client config. Throws `ClientConfigError` if anything is wrong. */
export function loadClient(clientId: string, options: LoadClientOptions = {}): ClientConfig {
  return loadClientWithWarnings(clientId, options).config;
}

export { ClientConfigError };

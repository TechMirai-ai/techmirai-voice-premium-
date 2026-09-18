/** Helpers for building throwaway client configs in tests. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import { ClientConfigError } from '../../src/config/issues.js';
import type { ConfigIssue } from '../../src/config/issues.js';

export const SAKURA_ID = 'sakura-seikotsuin';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const REAL_CLIENTS_DIR = path.join(REPO_ROOT, 'clients');

/** The real Sakura config, parsed as a plain object tests can copy and edit. */
export function readSakuraDocument(): Record<string, any> {
  const file = path.join(REAL_CLIENTS_DIR, SAKURA_ID, 'client.yaml');
  return parseYaml(readFileSync(file, 'utf8')) as Record<string, any>;
}

/** Returns a deep copy with `mutate` applied — the original is never changed. */
export function withChanges(
  document: Record<string, any>,
  mutate: (draft: Record<string, any>) => void,
): Record<string, any> {
  const copy = structuredClone(document);
  mutate(copy);
  return copy;
}

export interface ClientFixture {
  clientsDir: string;
  cleanup: () => void;
}

/** Writes `clients/<clientId>/client.yaml` into a temporary directory. */
export function writeClientFixture(clientId: string, document: unknown): ClientFixture {
  const clientsDir = mkdtempSync(path.join(tmpdir(), 'tmvp-clients-'));
  mkdirSync(path.join(clientsDir, clientId), { recursive: true });
  writeFileSync(path.join(clientsDir, clientId, 'client.yaml'), stringifyYaml(document), 'utf8');

  return {
    clientsDir,
    cleanup: () => rmSync(clientsDir, { recursive: true, force: true }),
  };
}

/** Runs `fn`, expects it to throw ClientConfigError, and returns the issues. */
export function captureIssues(fn: () => unknown): { issues: ConfigIssue[]; message: string } {
  try {
    fn();
  } catch (error) {
    if (error instanceof ClientConfigError) {
      return { issues: error.issues, message: error.message };
    }
    throw error;
  }
  throw new Error('expected validation to fail, but it succeeded');
}

/** The message for a given path, or undefined if that path had no problem. */
export function issueAt(issues: ConfigIssue[], targetPath: string): string | undefined {
  return issues.find((issue) => issue.path === targetPath)?.message;
}

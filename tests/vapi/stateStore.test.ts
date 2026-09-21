import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  getStateFileGitStatus,
  readState,
  stateFilePath,
  writeState,
  type VapiState,
} from '../../src/vapi/stateStore.js';

const CLIENT_ID = 'sakura-seikotsuin';

let repoRoot: string;

function git(...args: string[]): void {
  execFileSync('git', args, { cwd: repoRoot });
}

beforeEach(() => {
  repoRoot = mkdtempSync(path.join(tmpdir(), 'tmvp-state-'));
  git('init', '--quiet');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
});

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true });
});

describe('readState', () => {
  test('returns empty tools/assistants/squads when no state file exists yet', () => {
    expect(readState(CLIENT_ID, { repoRoot })).toEqual({ tools: {}, assistants: {}, squads: {} });
  });

  test('round-trips whatever writeState wrote', () => {
    const state: VapiState = {
      tools: { 'sakura-seikotsuin--ja--request-callback': '00000000-0000-0000-0000-000000000000' },
      assistants: { 'sakura-seikotsuin--ja': '11111111-1111-1111-1111-111111111111' },
      squads: { 'sakura-seikotsuin--squad': '22222222-2222-2222-2222-222222222222' },
    };

    writeState(CLIENT_ID, state, { repoRoot });

    expect(readState(CLIENT_ID, { repoRoot })).toEqual(state);
  });
});

describe('readState — older files', () => {
  test('a state file written before VP-3 (no squads key) reads as having no squads', () => {
    writeFileSync(
      stateFilePath(CLIENT_ID, { repoRoot }),
      JSON.stringify({ tools: { a: '1' }, assistants: { b: '2' } }),
      'utf8',
    );

    expect(readState(CLIENT_ID, { repoRoot })).toEqual({
      tools: { a: '1' },
      assistants: { b: '2' },
      squads: {},
    });
  });
});

describe('stateFilePath', () => {
  test('names the file after the client id, at the repo root', () => {
    expect(stateFilePath(CLIENT_ID, { repoRoot })).toBe(
      path.join(repoRoot, `.vapi-state.${CLIENT_ID}.json`),
    );
  });
});

describe('getStateFileGitStatus', () => {
  test('fileExists is false before the first sync', () => {
    expect(getStateFileGitStatus(CLIENT_ID, { repoRoot })).toEqual({
      fileExists: false,
      hasUncommittedChanges: false,
    });
  });

  test('hasUncommittedChanges is true for an untracked state file', () => {
    writeState(CLIENT_ID, { tools: {}, assistants: {}, squads: {} }, { repoRoot });

    expect(getStateFileGitStatus(CLIENT_ID, { repoRoot })).toEqual({
      fileExists: true,
      hasUncommittedChanges: true,
    });
  });

  test('hasUncommittedChanges is false once the state file is committed', () => {
    writeState(CLIENT_ID, { tools: {}, assistants: {}, squads: {} }, { repoRoot });
    git('add', `.vapi-state.${CLIENT_ID}.json`);
    git('commit', '--quiet', '-m', 'sync state');

    expect(getStateFileGitStatus(CLIENT_ID, { repoRoot })).toEqual({
      fileExists: true,
      hasUncommittedChanges: false,
    });
  });

  test('hasUncommittedChanges is true again after a committed file is edited', () => {
    writeState(CLIENT_ID, { tools: {}, assistants: {}, squads: {} }, { repoRoot });
    git('add', `.vapi-state.${CLIENT_ID}.json`);
    git('commit', '--quiet', '-m', 'sync state');

    writeFileSync(
      stateFilePath(CLIENT_ID, { repoRoot }),
      JSON.stringify({ tools: { extra: 'uuid' }, assistants: {} }),
    );

    expect(getStateFileGitStatus(CLIENT_ID, { repoRoot }).hasUncommittedChanges).toBe(true);
  });

  test('is scoped to the state file — unrelated uncommitted files do not trip it', () => {
    writeState(CLIENT_ID, { tools: {}, assistants: {}, squads: {} }, { repoRoot });
    git('add', `.vapi-state.${CLIENT_ID}.json`);
    git('commit', '--quiet', '-m', 'sync state');

    writeFileSync(path.join(repoRoot, 'unrelated.txt'), 'noise');

    expect(getStateFileGitStatus(CLIENT_ID, { repoRoot })).toEqual({
      fileExists: true,
      hasUncommittedChanges: false,
    });
  });
});

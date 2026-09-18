import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { VapiSyncClient } from '../../src/vapi/client.js';
import { UncommittedStateFileError, syncClient } from '../../src/vapi/sync.js';
import { readState } from '../../src/vapi/stateStore.js';
import {
  readSakuraDocument,
  writeClientFixture,
  type ClientFixture,
} from '../helpers/clientFixtures.js';

const CLIENT_ID = 'sakura-seikotsuin';
const BASE_URL = 'https://example.ngrok-free.app';

let repoRoot: string;
let fixture: ClientFixture;

function git(...args: string[]): void {
  execFileSync('git', args, { cwd: repoRoot });
}

interface MockClient {
  client: VapiSyncClient;
  toolsCreate: ReturnType<typeof vi.fn>;
  toolsUpdate: ReturnType<typeof vi.fn>;
  assistantsCreate: ReturnType<typeof vi.fn>;
  assistantsUpdate: ReturnType<typeof vi.fn>;
}

function createMockClient(): MockClient {
  let counter = 0;
  const toolsCreate = vi.fn(() => Promise.resolve({ id: `tool-${++counter}` }));
  const toolsUpdate = vi.fn((id: string) => Promise.resolve({ id }));
  const assistantsCreate = vi.fn(() => Promise.resolve({ id: `assistant-${++counter}` }));
  const assistantsUpdate = vi.fn((id: string) => Promise.resolve({ id }));

  return {
    client: {
      tools: { create: toolsCreate, update: toolsUpdate },
      assistants: { create: assistantsCreate, update: assistantsUpdate },
    },
    toolsCreate,
    toolsUpdate,
    assistantsCreate,
    assistantsUpdate,
  };
}

function sync(client: VapiSyncClient, dryRun: boolean) {
  return syncClient(CLIENT_ID, 'ja', {
    dryRun,
    client,
    baseUrl: BASE_URL,
    clientsDir: fixture.clientsDir,
    repoRoot,
  });
}

beforeEach(() => {
  repoRoot = mkdtempSync(path.join(tmpdir(), 'tmvp-sync-repo-'));
  git('init', '--quiet');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');

  fixture = writeClientFixture(CLIENT_ID, readSakuraDocument());
});

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true });
  fixture.cleanup();
});

describe('syncClient — dry run', () => {
  test('makes zero client calls and writes no state file', async () => {
    const { client, toolsCreate, assistantsCreate } = createMockClient();

    const result = await sync(client, true);

    expect(result.dryRun).toBe(true);
    expect(result.tool.action).toBe('create');
    expect(result.assistant.action).toBe('create');
    expect(toolsCreate).not.toHaveBeenCalled();
    expect(assistantsCreate).not.toHaveBeenCalled();
    expect(readState(CLIENT_ID, { repoRoot })).toEqual({ tools: {}, assistants: {} });
  });
});

describe('syncClient — apply', () => {
  test('calls create when no state entry exists yet, and writes the resolved ids', async () => {
    const { client, toolsCreate, toolsUpdate, assistantsCreate, assistantsUpdate } =
      createMockClient();

    const result = await sync(client, false);

    expect(result.tool.action).toBe('create');
    expect(result.assistant.action).toBe('create');
    expect(toolsCreate).toHaveBeenCalledTimes(1);
    expect(assistantsCreate).toHaveBeenCalledTimes(1);
    expect(toolsUpdate).not.toHaveBeenCalled();
    expect(assistantsUpdate).not.toHaveBeenCalled();

    const state = readState(CLIENT_ID, { repoRoot });
    expect(state.tools['sakura-seikotsuin--ja--request-callback']).toBe(result.tool.id);
    expect(state.assistants['sakura-seikotsuin--ja']).toBe(result.assistant.id);
  });

  test('calls update when a state entry already exists', async () => {
    const { client, toolsCreate, toolsUpdate, assistantsUpdate } = createMockClient();
    await sync(client, false);
    git('add', `.vapi-state.${CLIENT_ID}.json`);
    git('commit', '--quiet', '-m', 'sync state');

    const result = await sync(client, false);

    expect(result.tool.action).toBe('update');
    expect(result.assistant.action).toBe('update');
    expect(toolsUpdate).toHaveBeenCalledTimes(1);
    expect(assistantsUpdate).toHaveBeenCalledTimes(1);
    expect(toolsCreate).toHaveBeenCalledTimes(1); // only from the first sync
  });

  test("passes the resolved tool id into the assistant payload's model.toolIds", async () => {
    const { client, assistantsCreate } = createMockClient();

    const result = await sync(client, false);

    const sentPayload = assistantsCreate.mock.calls[0]?.[0] as { model: { toolIds: string[] } };
    expect(sentPayload.model.toolIds).toEqual([result.tool.id]);
  });

  test('persists the tool id even if the assistant call fails, so a retry updates instead of duplicating the tool', async () => {
    const { client, toolsCreate, toolsUpdate, assistantsCreate } = createMockClient();
    assistantsCreate.mockRejectedValueOnce(new Error('network blip'));

    await expect(sync(client, false)).rejects.toThrow('network blip');

    const state = readState(CLIENT_ID, { repoRoot });
    expect(state.tools['sakura-seikotsuin--ja--request-callback']).toBeDefined();
    expect(state.assistants['sakura-seikotsuin--ja']).toBeUndefined();

    // Commit the partial state, matching the real workflow, then retry.
    git('add', `.vapi-state.${CLIENT_ID}.json`);
    git('commit', '--quiet', '-m', 'partial sync state');

    await sync(client, false);

    // The retry sees the tool as already-synced (from the persisted partial
    // state) and updates it instead of creating a second, orphaned tool.
    expect(toolsCreate).toHaveBeenCalledTimes(1);
    expect(toolsUpdate).toHaveBeenCalledTimes(1);
  });
});

describe('syncClient — uncommitted state file guard', () => {
  test('refuses to run again when the state file from the previous sync is uncommitted', async () => {
    const { client } = createMockClient();
    await sync(client, false);

    await expect(sync(client, false)).rejects.toThrow(UncommittedStateFileError);
  });

  test('allows the first-ever sync when the state file does not exist yet', async () => {
    const { client } = createMockClient();

    await expect(sync(client, false)).resolves.toBeDefined();
  });

  test('dry run also refuses when the state file is uncommitted', async () => {
    const { client } = createMockClient();
    await sync(client, false);

    await expect(sync(client, true)).rejects.toThrow(UncommittedStateFileError);
  });
});

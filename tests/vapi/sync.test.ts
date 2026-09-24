import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { VapiSyncClient } from '../../src/vapi/client.js';
import {
  SquadPrerequisiteError,
  UncommittedStateFileError,
  syncClient,
  syncSquad,
} from '../../src/vapi/sync.js';
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
  squadsCreate: ReturnType<typeof vi.fn>;
  squadsUpdate: ReturnType<typeof vi.fn>;
  /** Every real API call, in order, e.g. "tools.create", "squads.update". */
  callLog: string[];
}

function createMockClient(): MockClient {
  let counter = 0;
  const callLog: string[] = [];
  const logged = <Args extends unknown[]>(label: string, make: (...args: Args) => { id: string }) =>
    vi.fn((...args: Args) => {
      callLog.push(label);
      return Promise.resolve(make(...args));
    });

  const toolsCreate = logged('tools.create', () => ({ id: `tool-${++counter}` }));
  const toolsUpdate = logged('tools.update', (id: string) => ({ id }));
  const assistantsCreate = logged('assistants.create', () => ({ id: `assistant-${++counter}` }));
  const assistantsUpdate = logged('assistants.update', (id: string) => ({ id }));
  const squadsCreate = logged('squads.create', () => ({ id: `squad-${++counter}` }));
  const squadsUpdate = logged('squads.update', (id: string) => ({ id }));

  return {
    client: {
      tools: { create: toolsCreate, update: toolsUpdate },
      assistants: { create: assistantsCreate, update: assistantsUpdate },
      squads: { create: squadsCreate, update: squadsUpdate },
    },
    toolsCreate,
    toolsUpdate,
    assistantsCreate,
    assistantsUpdate,
    squadsCreate,
    squadsUpdate,
    callLog,
  };
}

function sync(client: VapiSyncClient, dryRun: boolean, language = 'ja') {
  return syncClient(CLIENT_ID, language, {
    dryRun,
    client,
    baseUrl: BASE_URL,
    credentialId: 'credential-uuid',
    clientsDir: fixture.clientsDir,
    repoRoot,
  });
}

function syncTheSquad(client: VapiSyncClient, dryRun: boolean) {
  return syncSquad(CLIENT_ID, { dryRun, client, clientsDir: fixture.clientsDir, repoRoot });
}

/** Commits the state file, matching the real workflow between two syncs. */
function commitState(): void {
  git('add', `.vapi-state.${CLIENT_ID}.json`);
  git('commit', '--quiet', '-m', 'sync state');
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
    const mock = createMockClient();

    const result = await sync(mock.client, true);

    expect(result.dryRun).toBe(true);
    expect(result.tool.action).toBe('create');
    expect(result.handoffTools.map((tool) => tool.name)).toEqual([
      'sakura-seikotsuin--ja--handoff-to-en',
    ]);
    expect(result.assistant.action).toBe('create');
    expect(mock.callLog).toEqual([]);
    expect(readState(CLIENT_ID, { repoRoot })).toEqual({ tools: {}, assistants: {}, squads: {} });
  });
});

describe('syncClient — apply', () => {
  test('creates the callback tool, the handoff tool, then the assistant — and writes every resolved id', async () => {
    const mock = createMockClient();

    const result = await sync(mock.client, false);

    expect(mock.callLog).toEqual([
      'tools.create',
      'tools.create',
      'tools.create',
      'assistants.create',
    ]);
    const state = readState(CLIENT_ID, { repoRoot });
    expect(state.tools['sakura-seikotsuin--ja--request-callback']).toBe(result.tool.id);
    expect(state.tools['sakura-seikotsuin--ja--log-call-topic']).toBe(result.topicTool.id);
    expect(state.tools['sakura-seikotsuin--ja--handoff-to-en']).toBe(result.handoffTools[0]?.id);
    expect(state.assistants['sakura-seikotsuin--ja']).toBe(result.assistant.id);
  });

  test('sends a handoff tool payload to Vapi for the second tool', async () => {
    const mock = createMockClient();

    await sync(mock.client, false);

    const payloads = mock.toolsCreate.mock.calls.map((call) => call[0] as { type: string });
    expect(payloads.map((payload) => payload.type)).toEqual(['function', 'function', 'handoff']);
  });

  test('English: syncs its own tools and assistant, with a handoff tool back to Japanese', async () => {
    const mock = createMockClient();

    const result = await sync(mock.client, false, 'en');

    const state = readState(CLIENT_ID, { repoRoot });
    expect(state.tools['sakura-seikotsuin--en--request-callback']).toBeDefined();
    expect(state.tools['sakura-seikotsuin--en--handoff-to-ja']).toBe(result.handoffTools[0]?.id);
    expect(state.assistants['sakura-seikotsuin--en']).toBe(result.assistant.id);
  });

  test("ja-return (VP-7 R1): syncs as its own independent member, with its own tools distinct from ja's", async () => {
    const mock = createMockClient();

    const result = await sync(mock.client, false, 'ja-return');

    const state = readState(CLIENT_ID, { repoRoot });
    expect(state.tools['sakura-seikotsuin--ja-return--request-callback']).toBeDefined();
    expect(state.tools['sakura-seikotsuin--ja-return--log-call-topic']).toBeDefined();
    expect(state.tools['sakura-seikotsuin--ja-return--handoff-to-en']).toBe(
      result.handoffTools[0]?.id,
    );
    expect(state.assistants['sakura-seikotsuin--ja-return']).toBe(result.assistant.id);
    expect(result.member).toBe('ja-return');
  });

  test('calls update for everything when state entries already exist', async () => {
    const mock = createMockClient();
    await sync(mock.client, false);
    commitState();

    const result = await sync(mock.client, false);

    expect(result.tool.action).toBe('update');
    expect(result.handoffTools[0]?.action).toBe('update');
    expect(result.assistant.action).toBe('update');
    expect(mock.toolsUpdate).toHaveBeenCalledTimes(3);
    expect(mock.assistantsUpdate).toHaveBeenCalledTimes(1);
    expect(mock.toolsCreate).toHaveBeenCalledTimes(3); // only from the first sync
  });

  test("passes both resolved tool ids into the assistant payload's model.toolIds", async () => {
    const mock = createMockClient();

    const result = await sync(mock.client, false);

    const sentPayload = mock.assistantsCreate.mock.calls[0]?.[0] as {
      model: { toolIds: string[] };
    };
    expect(sentPayload.model.toolIds).toEqual([
      result.tool.id,
      result.topicTool.id,
      result.handoffTools[0]?.id,
    ]);
  });

  test('persists every tool id even if the assistant call fails, so a retry updates instead of duplicating tools', async () => {
    const mock = createMockClient();
    mock.assistantsCreate.mockRejectedValueOnce(new Error('network blip'));

    await expect(sync(mock.client, false)).rejects.toThrow('network blip');

    const state = readState(CLIENT_ID, { repoRoot });
    expect(state.tools['sakura-seikotsuin--ja--request-callback']).toBeDefined();
    expect(state.tools['sakura-seikotsuin--ja--handoff-to-en']).toBeDefined();
    expect(state.assistants['sakura-seikotsuin--ja']).toBeUndefined();
    commitState();

    await sync(mock.client, false);

    expect(mock.toolsCreate).toHaveBeenCalledTimes(3);
    expect(mock.toolsUpdate).toHaveBeenCalledTimes(3);
  });

  test('persists the first tool even if the second tool call fails', async () => {
    const mock = createMockClient();
    mock.toolsCreate.mockResolvedValueOnce({ id: 'tool-a' });
    mock.toolsCreate.mockRejectedValueOnce(new Error('handoff tool failed'));

    await expect(sync(mock.client, false)).rejects.toThrow('handoff tool failed');

    const state = readState(CLIENT_ID, { repoRoot });
    expect(state.tools['sakura-seikotsuin--ja--request-callback']).toBe('tool-a');
    expect(state.tools['sakura-seikotsuin--ja--handoff-to-en']).toBeUndefined();
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

describe('syncSquad', () => {
  // Three squad members now: ja, en, and ja-return (VP-7 R1) — every one
  // needs its own tools + assistant synced before the squad can reference it.
  async function syncAllMembers(mock: MockClient): Promise<void> {
    await sync(mock.client, false, 'ja');
    commitState();
    await sync(mock.client, false, 'en');
    commitState();
    await sync(mock.client, false, 'ja-return');
    commitState();
  }

  test('refuses until every squad member has been synced, naming what is missing', async () => {
    const mock = createMockClient();
    await sync(mock.client, false, 'ja');
    commitState();
    mock.callLog.length = 0;

    const attempt = syncTheSquad(mock.client, false);

    await expect(attempt).rejects.toThrow(SquadPrerequisiteError);
    await expect(attempt).rejects.toThrow(/sakura-seikotsuin--en/);
    await expect(attempt).rejects.toThrow(/sakura-seikotsuin--ja-return/);
    expect(mock.callLog).toEqual([]);
  });

  test('creates the squad only after all three members and all nine tools exist', async () => {
    const mock = createMockClient();
    await syncAllMembers(mock);

    const result = await syncTheSquad(mock.client, false);

    expect(mock.callLog).toEqual([
      ...Array(3).fill('tools.create'),
      'assistants.create',
      ...Array(3).fill('tools.create'),
      'assistants.create',
      ...Array(3).fill('tools.create'),
      'assistants.create',
      'squads.create',
    ]);
    expect(result.squad.action).toBe('create');
    expect(readState(CLIENT_ID, { repoRoot }).squads['sakura-seikotsuin--squad']).toBe(
      result.squad.id,
    );
  });

  test('sends the Japanese assistant id first, then English, then ja-return — using the real synced ids', async () => {
    const mock = createMockClient();
    await syncAllMembers(mock);
    const { assistants } = readState(CLIENT_ID, { repoRoot });

    await syncTheSquad(mock.client, false);

    expect(mock.squadsCreate.mock.calls[0]?.[0]).toEqual({
      name: 'sakura-seikotsuin--squad',
      members: [
        { assistantId: assistants['sakura-seikotsuin--ja'] },
        { assistantId: assistants['sakura-seikotsuin--en'] },
        { assistantId: assistants['sakura-seikotsuin--ja-return'] },
      ],
    });
  });

  test('updates the squad in place on a second run', async () => {
    const mock = createMockClient();
    await syncAllMembers(mock);
    await syncTheSquad(mock.client, false);
    commitState();

    const result = await syncTheSquad(mock.client, false);

    expect(result.squad.action).toBe('update');
    expect(mock.squadsCreate).toHaveBeenCalledTimes(1);
    expect(mock.squadsUpdate).toHaveBeenCalledTimes(1);
  });

  test('dry run makes zero client calls and writes nothing', async () => {
    const mock = createMockClient();
    await syncAllMembers(mock);
    const before = readState(CLIENT_ID, { repoRoot });
    mock.callLog.length = 0;

    const result = await syncTheSquad(mock.client, true);

    expect(result.dryRun).toBe(true);
    expect(result.squad.action).toBe('create');
    expect(result.memberNames).toEqual([
      'sakura-seikotsuin--ja',
      'sakura-seikotsuin--en',
      'sakura-seikotsuin--ja-return',
    ]);
    expect(mock.callLog).toEqual([]);
    expect(readState(CLIENT_ID, { repoRoot })).toEqual(before);
  });

  test('refuses when the state file has uncommitted changes (same rule as syncClient)', async () => {
    const mock = createMockClient();
    await sync(mock.client, false, 'ja');

    await expect(syncTheSquad(mock.client, true)).rejects.toThrow(UncommittedStateFileError);
  });
});

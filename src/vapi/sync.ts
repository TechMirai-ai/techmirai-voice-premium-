/**
 * Builds a client/language's Vapi payloads and syncs them: create when no
 * state entry exists yet, update when one does. Dry-run by default — see
 * cli.ts. Never calls the real Vapi API in dry-run mode (work order §3).
 *
 * Extends the work order's `opts: { dryRun }` with `client`/`baseUrl` (and
 * `clientsDir`/`repoRoot` for tests) for the same testability reasons as
 * render.ts's `baseUrl` parameter — this function stays fully mockable
 * without a real Vapi client or a real PUBLIC_BASE_URL. Printing the diff is
 * left to cli.ts (§6.7), so `no-console` stays scoped to CLI entry points,
 * matching checkCli.ts.
 */
import { loadClient, type LoadClientOptions } from '../config/loadClient.js';
import { FileKnowledgeSource } from '../knowledge/KnowledgeSource.js';
import type { VapiSyncClient } from './client.js';
import { renderAssistant } from './render.js';
import {
  getStateFileGitStatus,
  readState,
  writeState,
  type StateStoreOptions,
  type VapiState,
} from './stateStore.js';

export class UncommittedStateFileError extends Error {
  constructor(clientId: string) {
    super(
      `.vapi-state.${clientId}.json has uncommitted changes. Commit it (or discard the changes) ` +
        'before syncing, so every real sync corresponds to one clean commit before and after.',
    );
    this.name = 'UncommittedStateFileError';
  }
}

export type SyncAction = 'create' | 'update';

export interface SyncResourceResult {
  /** The bookkeeping name used as the state-file key — not necessarily a Vapi field (see types.ts). */
  name: string;
  action: SyncAction;
  /** Only set once dryRun is false and the real API call has completed. */
  id?: string;
}

export interface SyncResult {
  dryRun: boolean;
  clientId: string;
  language: string;
  tool: SyncResourceResult;
  assistant: SyncResourceResult;
  /** Human-readable diff, ready to print — see cli.ts. */
  diffLines: string[];
}

export interface SyncClientOptions {
  dryRun: boolean;
  /** Only called when dryRun is false — a mocked client in tests, a real one (client.ts) otherwise. */
  client: VapiSyncClient;
  /** Passed through to renderAssistant — from PUBLIC_BASE_URL, never hard-coded. */
  baseUrl: string;
  /** Overrides for tests: a fixture clients/ directory and/or repo root. */
  clientsDir?: LoadClientOptions['clientsDir'];
  repoRoot?: StateStoreOptions['repoRoot'];
}

function toolStateName(clientId: string, language: string): string {
  return `${clientId}--${language}--request-callback`;
}

function assistantStateName(clientId: string, language: string): string {
  return `${clientId}--${language}`;
}

function buildDiffLines(
  clientId: string,
  language: string,
  tool: SyncResourceResult,
  assistant: SyncResourceResult,
): string[] {
  const describe = (resource: SyncResourceResult): string =>
    resource.id
      ? `${resource.action} "${resource.name}" (${resource.id})`
      : `${resource.action} "${resource.name}"`;

  return [
    `Client: ${clientId}  Language: ${language}`,
    `  tool:      ${describe(tool)}`,
    `  assistant: ${describe(assistant)}`,
  ];
}

export async function syncClient(
  clientId: string,
  language: string,
  options: SyncClientOptions,
): Promise<SyncResult> {
  const stateOptions: StateStoreOptions = options.repoRoot ? { repoRoot: options.repoRoot } : {};
  const gitStatus = getStateFileGitStatus(clientId, stateOptions);
  if (gitStatus.fileExists && gitStatus.hasUncommittedChanges) {
    throw new UncommittedStateFileError(clientId);
  }

  const loadOptions: LoadClientOptions = options.clientsDir
    ? { clientsDir: options.clientsDir }
    : {};
  const config = loadClient(clientId, loadOptions);
  const faq = await new FileKnowledgeSource(loadOptions).listFaq(clientId);
  const { assistant: assistantPayload, tool: toolPayload } = renderAssistant(
    config,
    language,
    faq,
    {
      baseUrl: options.baseUrl,
    },
  );

  const toolName = toolStateName(clientId, language);
  const assistantName = assistantStateName(clientId, language);
  const state = readState(clientId, stateOptions);
  const existingToolId = state.tools[toolName];
  const existingAssistantId = state.assistants[assistantName];

  const toolResult: SyncResourceResult = {
    name: toolName,
    action: existingToolId ? 'update' : 'create',
    ...(existingToolId ? { id: existingToolId } : {}),
  };
  const assistantResult: SyncResourceResult = {
    name: assistantName,
    action: existingAssistantId ? 'update' : 'create',
    ...(existingAssistantId ? { id: existingAssistantId } : {}),
  };

  if (options.dryRun) {
    return {
      dryRun: true,
      clientId,
      language,
      tool: toolResult,
      assistant: assistantResult,
      diffLines: buildDiffLines(clientId, language, toolResult, assistantResult),
    };
  }

  const syncedTool = existingToolId
    ? await options.client.tools.update(existingToolId, toolPayload)
    : await options.client.tools.create(toolPayload);

  // Persisted immediately, before the assistant call: if that call below
  // fails, a retry must see this tool as already-synced (existingToolId set)
  // and call tools.update, not tools.create again — otherwise every retry
  // after a partial failure would create another orphaned tool on Vapi.
  const stateAfterTool: VapiState = {
    ...state,
    tools: { ...state.tools, [toolName]: syncedTool.id },
  };
  writeState(clientId, stateAfterTool, stateOptions);

  const assistantToSend = {
    ...assistantPayload,
    model: { ...assistantPayload.model, toolIds: [syncedTool.id] },
  };
  const syncedAssistant = existingAssistantId
    ? await options.client.assistants.update(existingAssistantId, assistantToSend)
    : await options.client.assistants.create(assistantToSend);

  const finalState: VapiState = {
    ...stateAfterTool,
    assistants: { ...stateAfterTool.assistants, [assistantName]: syncedAssistant.id },
  };
  writeState(clientId, finalState, stateOptions);

  const finalToolResult = { ...toolResult, id: syncedTool.id };
  const finalAssistantResult = { ...assistantResult, id: syncedAssistant.id };

  return {
    dryRun: false,
    clientId,
    language,
    tool: finalToolResult,
    assistant: finalAssistantResult,
    diffLines: buildDiffLines(clientId, language, finalToolResult, finalAssistantResult),
  };
}

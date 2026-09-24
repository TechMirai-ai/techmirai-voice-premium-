/**
 * Builds a client's Vapi payloads and syncs them: create when no state entry
 * exists yet, update when one does. Dry-run by default — see cli.ts. Never
 * calls the real Vapi API in dry-run mode (work order §3).
 *
 * Two entry points, in dependency order:
 *   1. `syncClient`  — one language: its request_callback tool, one handoff
 *      tool per other language, then its assistant. Handoff destinations are
 *      by assistant *name*, so language order does not matter here.
 *   2. `syncSquad`   — after every supported language has been synced: the
 *      Squad, which needs each assistant's real id.
 *
 * Extends the work order's `opts: { dryRun }` with `client`/`baseUrl` (and
 * `clientsDir`/`repoRoot` for tests) for the same testability reasons as
 * render.ts's `baseUrl` parameter — these functions stay fully mockable
 * without a real Vapi client or a real PUBLIC_BASE_URL. Printing the diff is
 * left to cli.ts (§6.7), so `no-console` stays scoped to CLI entry points,
 * matching checkCli.ts.
 */
import { loadClient, type LoadClientOptions } from '../config/loadClient.js';
import type { ClientConfig } from '../config/schema.js';
import { FileKnowledgeSource } from '../knowledge/KnowledgeSource.js';
import type { VapiSyncClient } from './client.js';
import { renderAssistant } from './render.js';
import {
  assistantResourceName,
  contentLanguageOf,
  handoffTargets,
  handoffToolStateName,
  renderSquad,
  squadMemberIds,
  squadStateName,
} from './squad.js';
import {
  getStateFileGitStatus,
  readState,
  writeState,
  type StateStoreOptions,
  type VapiState,
} from './stateStore.js';
import type { VapiToolPayload } from './types.js';

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
  /** The squad member id synced — a language code, or the default language's "-return" variant. */
  member: string;
  /** The request_callback tool. */
  tool: SyncResourceResult;
  /** The silent, asynchronous log_call_topic tool. */
  topicTool: SyncResourceResult;
  /** One per other supported language. */
  handoffTools: SyncResourceResult[];
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
  /** Passed through to renderAssistant — the Custom Credential id (VAPI_SERVER_CREDENTIAL_ID). */
  credentialId: string;
  /** Overrides for tests: a fixture clients/ directory and/or repo root. */
  clientsDir?: LoadClientOptions['clientsDir'];
  repoRoot?: StateStoreOptions['repoRoot'];
}

function toolStateName(clientId: string, language: string): string {
  return `${clientId}--${language}--request-callback`;
}

function topicToolStateName(clientId: string, language: string): string {
  return `${clientId}--${language}--log-call-topic`;
}

function describeResource(resource: SyncResourceResult): string {
  return resource.id
    ? `${resource.action} "${resource.name}" (${resource.id})`
    : `${resource.action} "${resource.name}"`;
}

function planResource(name: string, existingId: string | undefined): SyncResourceResult {
  return {
    name,
    action: existingId ? 'update' : 'create',
    ...(existingId ? { id: existingId } : {}),
  };
}

function stateOptionsOf(options: { repoRoot?: string | undefined }): StateStoreOptions {
  return options.repoRoot ? { repoRoot: options.repoRoot } : {};
}

function loadOptionsOf(options: SyncClientOptions | SyncSquadOptions): LoadClientOptions {
  return options.clientsDir ? { clientsDir: options.clientsDir } : {};
}

/** Refuses to run against a state file with uncommitted changes (work order §3). */
function assertStateFileCommitted(clientId: string, stateOptions: StateStoreOptions): void {
  const gitStatus = getStateFileGitStatus(clientId, stateOptions);
  if (gitStatus.fileExists && gitStatus.hasUncommittedChanges) {
    throw new UncommittedStateFileError(clientId);
  }
}

interface PlannedTool {
  result: SyncResourceResult;
  payload: VapiToolPayload;
}

/**
 * Creates or updates each tool in order, persisting every id immediately: if a
 * later call fails, a retry must see the earlier tools as already-synced and
 * call update, not create again — otherwise each retry after a partial failure
 * would leave another orphaned tool on Vapi.
 */
async function applyTools(
  planned: PlannedTool[],
  client: VapiSyncClient,
  clientId: string,
  startState: VapiState,
  stateOptions: StateStoreOptions,
): Promise<{ state: VapiState; results: SyncResourceResult[] }> {
  let state = startState;
  const results: SyncResourceResult[] = [];

  for (const { result, payload } of planned) {
    const existingId = state.tools[result.name];
    const synced = existingId
      ? await client.tools.update(existingId, payload)
      : await client.tools.create(payload);
    state = { ...state, tools: { ...state.tools, [result.name]: synced.id } };
    writeState(clientId, state, stateOptions);
    results.push({ ...result, id: synced.id });
  }

  return { state, results };
}

function buildDiffLines(
  clientId: string,
  member: string,
  tool: SyncResourceResult,
  topicTool: SyncResourceResult,
  handoffTools: SyncResourceResult[],
  assistant: SyncResourceResult,
): string[] {
  return [
    `Client: ${clientId}  Member: ${member}`,
    `  tool:      ${describeResource(tool)}`,
    `  topic:     ${describeResource(topicTool)}`,
    ...handoffTools.map((handoff) => `  handoff:   ${describeResource(handoff)}`),
    `  assistant: ${describeResource(assistant)}`,
  ];
}

export async function syncClient(
  clientId: string,
  memberId: string,
  options: SyncClientOptions,
): Promise<SyncResult> {
  const stateOptions = stateOptionsOf(options);
  assertStateFileCommitted(clientId, stateOptions);

  const loadOptions = loadOptionsOf(options);
  const config = loadClient(clientId, loadOptions);
  const faq = await new FileKnowledgeSource(loadOptions).listFaq(clientId);
  const rendered = renderAssistant(config, memberId, faq, {
    baseUrl: options.baseUrl,
    credentialId: options.credentialId,
  });

  const state = readState(clientId, stateOptions);
  const assistantName = assistantResourceName(clientId, memberId);
  const toolName = toolStateName(clientId, memberId);

  const toolPlan: PlannedTool = {
    result: planResource(toolName, state.tools[toolName]),
    payload: rendered.tool,
  };
  const handoffPlans: PlannedTool[] = rendered.handoffTools.map(({ toLanguage, payload }) => {
    const name = handoffToolStateName(clientId, memberId, toLanguage);
    return { result: planResource(name, state.tools[name]), payload };
  });
  const topicToolName = topicToolStateName(clientId, memberId);
  const topicToolPlan: PlannedTool = {
    result: planResource(topicToolName, state.tools[topicToolName]),
    payload: rendered.topicTool,
  };
  const assistantPlan = planResource(assistantName, state.assistants[assistantName]);

  if (options.dryRun) {
    const handoffResults = handoffPlans.map((plan) => plan.result);
    return {
      dryRun: true,
      clientId,
      member: memberId,
      tool: toolPlan.result,
      topicTool: topicToolPlan.result,
      handoffTools: handoffResults,
      assistant: assistantPlan,
      diffLines: buildDiffLines(
        clientId,
        memberId,
        toolPlan.result,
        topicToolPlan.result,
        handoffResults,
        assistantPlan,
      ),
    };
  }

  const { state: stateAfterTools, results } = await applyTools(
    [toolPlan, topicToolPlan, ...handoffPlans],
    options.client,
    clientId,
    state,
    stateOptions,
  );
  const [toolResult, topicToolResult, ...handoffResults] = results;
  if (!toolResult || !topicToolResult)
    throw new Error('unreachable: applyTools returned no results');

  const assistantToSend = {
    ...rendered.assistant,
    model: {
      ...rendered.assistant.model,
      toolIds: results.map((result) => result.id ?? ''),
    },
  };
  const existingAssistantId = state.assistants[assistantName];
  const syncedAssistant = existingAssistantId
    ? await options.client.assistants.update(existingAssistantId, assistantToSend)
    : await options.client.assistants.create(assistantToSend);

  writeState(
    clientId,
    {
      ...stateAfterTools,
      assistants: { ...stateAfterTools.assistants, [assistantName]: syncedAssistant.id },
    },
    stateOptions,
  );

  const finalAssistant = { ...assistantPlan, id: syncedAssistant.id };
  return {
    dryRun: false,
    clientId,
    member: memberId,
    tool: toolResult,
    topicTool: topicToolResult,
    handoffTools: handoffResults,
    assistant: finalAssistant,
    diffLines: buildDiffLines(
      clientId,
      memberId,
      toolResult,
      topicToolResult,
      handoffResults,
      finalAssistant,
    ),
  };
}

export class SquadPrerequisiteError extends Error {
  constructor(
    clientId: string,
    readonly missing: string[],
  ) {
    super(
      `Cannot sync the squad for "${clientId}" yet — these are not in .vapi-state.${clientId}.json: ` +
        `${missing.join(', ')}. Sync every supported language first: ` +
        `npm run vapi:sync -- ${clientId} --language <code> --apply`,
    );
    this.name = 'SquadPrerequisiteError';
  }
}

export interface SyncSquadResult {
  dryRun: boolean;
  clientId: string;
  squad: SyncResourceResult;
  /** Member assistant names, in call order — the first one starts the call. */
  memberNames: string[];
  diffLines: string[];
}

export type SyncSquadOptions = Omit<SyncClientOptions, 'baseUrl' | 'credentialId'>;

/** Every state-file name that must exist before the squad can reference it. */
function squadPrerequisites(config: ClientConfig): { assistants: string[]; tools: string[] } {
  const memberIds = squadMemberIds(config);
  return {
    assistants: memberIds.map((id) => assistantResourceName(config.clientId, id)),
    tools: memberIds.flatMap((id) => {
      const language = contentLanguageOf(config, id);
      return [
        toolStateName(config.clientId, id),
        topicToolStateName(config.clientId, id),
        ...handoffTargets(config, language).map((to) =>
          handoffToolStateName(config.clientId, id, to),
        ),
      ];
    }),
  };
}

export async function syncSquad(
  clientId: string,
  options: SyncSquadOptions,
): Promise<SyncSquadResult> {
  const stateOptions = stateOptionsOf(options);
  assertStateFileCommitted(clientId, stateOptions);

  const config = loadClient(clientId, loadOptionsOf(options));
  const state = readState(clientId, stateOptions);

  const needed = squadPrerequisites(config);
  const missing = [
    ...needed.assistants.filter((name) => !state.assistants[name]),
    ...needed.tools.filter((name) => !state.tools[name]),
  ];
  if (missing.length > 0) throw new SquadPrerequisiteError(clientId, missing);

  const assistantIds = Object.fromEntries(
    squadMemberIds(config).map((id) => [
      id,
      state.assistants[assistantResourceName(clientId, id)] ?? '',
    ]),
  );
  const payload = renderSquad(config, assistantIds);
  const name = squadStateName(clientId);
  const plan = planResource(name, state.squads[name]);
  const memberNames = squadMemberIds(config).map((id) => assistantResourceName(clientId, id));

  const diff = (squad: SyncResourceResult): string[] => [
    `Client: ${clientId}  Squad`,
    `  squad:     ${describeResource(squad)}`,
    `  members:   ${memberNames.join(' -> ')}  (first starts the call)`,
  ];

  if (options.dryRun) {
    return { dryRun: true, clientId, squad: plan, memberNames, diffLines: diff(plan) };
  }

  const synced = state.squads[name]
    ? await options.client.squads.update(state.squads[name], payload)
    : await options.client.squads.create(payload);
  writeState(clientId, { ...state, squads: { ...state.squads, [name]: synced.id } }, stateOptions);

  const final = { ...plan, id: synced.id };
  return { dryRun: false, clientId, squad: final, memberNames, diffLines: diff(final) };
}

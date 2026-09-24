/**
 * Local, near-zero-cost text-based tester for the Vapi prompt/tool-call
 * logic — same spirit as `vapi:test-page`, but for LOGIC, not voice (work
 * order §4). Calls OpenAI directly with the exact model production uses
 * (`render.ts`'s `MODEL_ID`, gpt-4o-mini) — VAPI-FACTS.md VP-7 R4 originally
 * chose a free OpenRouter/Qwen model, superseded once real gpt-4o-mini cost
 * turned out to be negligible for this use; testing the actual production
 * model beats testing a substitute. Also reuses `renderAssistant()` —
 * production's own prompt-template and tool-schema code — so what gets
 * tested here is byte-for-byte what would actually be synced to Vapi. Never
 * touches the real Vapi API and never makes an HTTP call to the caller's
 * browser: this is a CLI tool, so "the API key stays server-side" is
 * automatic.
 *
 * LIMITATION (flagged wherever this tool prints its banner and in the work
 * order): the real Squad handoff *mechanism* is Vapi-specific and cannot be
 * exercised here. When the model calls a handoff tool, this tool prints the
 * call (proving the model decided correctly — right target, right trigger)
 * and ends the session; re-run with `--member <target>` to keep testing
 * prompt/tool-call logic from the other side of the handoff.
 *
 * `npm run vapi:test-chat -- <clientId> --member ja|en|ja-return [--persist] [--script <file>]`
 *   --persist       request_callback tool calls actually write to the local
 *                   dev Postgres (src/repositories/callbackRequestRepository.ts),
 *                   so a full save can be verified end-to-end at zero Vapi cost.
 *   --script <file> non-interactive: reads one caller line per line from
 *                   `file` (blank lines and lines starting with # are
 *                   skipped) instead of prompting on stdin. Used to run the
 *                   04-test-suite.md cases without retyping them by hand.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

import { loadClient } from '../config/loadClient.js';
import { createPool } from '../db/pool.js';
import { loadEnv } from '../env.js';
import { FileKnowledgeSource } from '../knowledge/KnowledgeSource.js';
import {
  PgCallbackRequestRepository,
  type CallbackRequestRepository,
} from '../repositories/callbackRequestRepository.js';
import { MODEL_ID, renderAssistant, type RenderResult } from './render.js';
import { contentLanguageOf } from './squad.js';
import { END_CALL_FUNCTION_NAME, LOG_CALL_TOPIC_FUNCTION_NAME } from './toolNames.js';
import type { VapiFunctionDefinition, VapiHandoffDestination } from './types.js';

export const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';
/** Same model production uses — imported from render.ts, never duplicated, so this can't drift. */
export const OPENAI_MODEL = MODEL_ID;

const PLACEHOLDER_BASE_URL = 'https://text-tester.invalid';
const PLACEHOLDER_CREDENTIAL_ID = 'text-tester';
const MAX_TOOL_CALL_ROUNDS = 5;

// --- Tool schema conversion (Vapi payload -> OpenAI chat/completions tool) -

export interface OpenAiFunctionToolDef {
  type: 'function';
  function: VapiFunctionDefinition;
}

function toOpenAiTool(fn: VapiFunctionDefinition): OpenAiFunctionToolDef {
  return { type: 'function', function: fn };
}

const END_CALL_TOOL: OpenAiFunctionToolDef = {
  type: 'function',
  function: {
    name: END_CALL_FUNCTION_NAME,
    description: 'Ends the call.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
};

/** Mirrors Vapi's own auto-generated handoff function shape (VAPI-FACTS.md). */
function handoffToolDef(
  toLanguage: string,
  destination: VapiHandoffDestination,
): OpenAiFunctionToolDef {
  return {
    type: 'function',
    function: {
      name: `handoff_to_${toLanguage}`,
      description: destination.description,
      parameters: {
        type: 'object',
        properties: {
          destination: {
            type: 'string',
            description: 'The language to hand off to.',
            enum: [toLanguage],
          },
        },
        required: ['destination'],
      },
    },
  };
}

/** Every tool the real assistant has, converted to OpenAI's `tools` array shape. */
export function buildToolDefs(rendered: RenderResult): OpenAiFunctionToolDef[] {
  return [
    toOpenAiTool(rendered.tool.function),
    toOpenAiTool(rendered.topicTool.function),
    END_CALL_TOOL,
    ...rendered.handoffTools.map(({ toLanguage, payload }) => {
      const destination = payload.destinations[0];
      if (!destination) {
        throw new Error(`handoff tool to "${toLanguage}" was rendered with no destination`);
      }
      return handoffToolDef(toLanguage, destination);
    }),
  ];
}

/** Builds the exact production payloads for one squad member, for a fresh text-test session. */
export async function loadRenderedMember(
  clientId: string,
  memberId: string,
): Promise<RenderResult> {
  const config = loadClient(clientId);
  const faq = await new FileKnowledgeSource().listFaq(clientId);
  return renderAssistant(config, memberId, faq, {
    baseUrl: PLACEHOLDER_BASE_URL,
    credentialId: PLACEHOLDER_CREDENTIAL_ID,
  });
}

// --- Conversation state -----------------------------------------------------

export interface ChatToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
  name?: string;
}

/** System prompt + the member's own firstMessage, seeded as its first spoken turn. */
export function initialMessages(rendered: RenderResult): ChatMessage[] {
  const systemContent = rendered.assistant.model.messages[0]?.content;
  if (systemContent === undefined) {
    throw new Error('renderAssistant produced no system message');
  }
  return [
    { role: 'system', content: systemContent },
    { role: 'assistant', content: rendered.assistant.firstMessage },
  ];
}

// --- Transcript formatting (pure) ------------------------------------------

export function formatAgentLine(content: string): string {
  return `Agent: ${content}`;
}

export function formatToolCallLine(call: ChatToolCall): string {
  let args: unknown = call.function.arguments;
  try {
    args = JSON.parse(call.function.arguments) as unknown;
  } catch {
    // Leave args as the raw string — printed as-is below.
  }
  return `Tool call: ${call.function.name}(${JSON.stringify(args)})`;
}

// --- OpenAI API call ---------------------------------------------------------

interface ChatCompletionMessage {
  role: string;
  content: string | null;
  tool_calls?: ChatToolCall[];
}

interface ChatCompletionResponse {
  choices?: { message: ChatCompletionMessage }[];
  error?: { message: string };
}

export type CallModelFn = (
  messages: ChatMessage[],
  tools: OpenAiFunctionToolDef[],
) => Promise<ChatMessage>;

/** The real network call — swapped out in tests for a canned CallModelFn. */
export function makeOpenAiCaller(apiKey: string): CallModelFn {
  return async (messages, tools) => {
    const response = await fetch(OPENAI_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model: OPENAI_MODEL, messages, tools }),
    });

    const data = (await response.json()) as ChatCompletionResponse;
    if (!response.ok || data.error) {
      throw new Error(`OpenAI request failed: ${data.error?.message ?? response.statusText}`);
    }
    const choice = data.choices?.[0];
    if (!choice) throw new Error('OpenAI returned no choices');

    return {
      role: 'assistant',
      content: choice.message.content,
      ...(choice.message.tool_calls ? { tool_calls: choice.message.tool_calls } : {}),
    };
  };
}

// --- Tool-call side effects --------------------------------------------------

export interface ToolCallHandlerDeps {
  persist: boolean;
  clientId: string;
  /** Content language for the DB row / callback_requests.language — see squad.ts contentLanguageOf. */
  language: string;
  callId: string;
  callbacks?: CallbackRequestRepository;
  printLine: (text: string) => void;
}

export interface ToolCallOutcome {
  resultMessage: ChatMessage;
  ended: boolean;
}

function toolResult(call: ChatToolCall, content: string): ChatMessage {
  return { role: 'tool', tool_call_id: call.id, name: call.function.name, content };
}

function parseArgs(call: ChatToolCall): Record<string, unknown> {
  try {
    return JSON.parse(call.function.arguments) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Safe for `unknown` tool-call arguments — never invokes an object's own toString(). */
function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

export async function handleToolCall(
  call: ChatToolCall,
  deps: ToolCallHandlerDeps,
): Promise<ToolCallOutcome> {
  deps.printLine(formatToolCallLine(call));
  const name = call.function.name;

  if (name === END_CALL_FUNCTION_NAME) {
    return { resultMessage: toolResult(call, 'Call ended.'), ended: true };
  }

  if (name.startsWith('handoff_to_')) {
    const args = parseArgs(call);
    deps.printLine(
      'LIMITATION: the real Squad handoff cannot be exercised by this tool — re-run with ' +
        `--member ${asString(args.destination, '<target>')} to keep testing from that side.`,
    );
    return { resultMessage: toolResult(call, ''), ended: true };
  }

  if (name === 'request_callback') {
    const args = parseArgs(call);
    if (deps.persist && deps.callbacks) {
      const saved = await deps.callbacks.create({
        clientId: deps.clientId,
        callId: deps.callId,
        language: deps.language,
        callerName: asString(args.callerName),
        callerPhone: asString(args.callerPhone),
        reason: typeof args.reason === 'string' ? args.reason : null,
      });
      deps.printLine(`Persisted callback_requests row: ${saved.id}`);
    }
    return { resultMessage: toolResult(call, 'Success.'), ended: false };
  }

  if (name === LOG_CALL_TOPIC_FUNCTION_NAME) {
    return { resultMessage: toolResult(call, 'Success.'), ended: false };
  }

  return { resultMessage: toolResult(call, 'Success.'), ended: false };
}

// --- One conversational turn: call the model, run any tool calls, repeat ---

export interface TurnResult {
  messages: ChatMessage[];
  ended: boolean;
}

/**
 * Keeps calling the model and feeding back tool results — with no new caller
 * input — until it produces a turn with no tool calls (waiting for the
 * caller to speak) or calls endCall/a handoff (session over). Mirrors how
 * the real prompt is written: e.g. log_call_topic then endCall fire silently
 * in the same turn, with no caller input in between.
 */
export async function runTurn(
  messages: ChatMessage[],
  tools: OpenAiFunctionToolDef[],
  callModel: CallModelFn,
  toolDeps: ToolCallHandlerDeps,
): Promise<TurnResult> {
  let current = messages;

  for (let round = 0; round < MAX_TOOL_CALL_ROUNDS; round += 1) {
    const reply = await callModel(current, tools);
    current = [...current, reply];
    if (reply.content) toolDeps.printLine(formatAgentLine(reply.content));

    const toolCalls = reply.tool_calls ?? [];
    if (toolCalls.length === 0) return { messages: current, ended: false };

    let ended = false;
    for (const call of toolCalls) {
      const outcome = await handleToolCall(call, toolDeps);
      current = [...current, outcome.resultMessage];
      if (outcome.ended) ended = true;
    }
    if (ended) return { messages: current, ended: true };
  }

  toolDeps.printLine('Warning: tool-call loop exceeded the round limit — stopping this turn.');
  return { messages: current, ended: false };
}

// --- CLI ---------------------------------------------------------------------

function printLine(text: string): void {
  process.stdout.write(`${text}\n`);
}

function printError(text: string): void {
  process.stderr.write(`${text}\n`);
}

export interface TextTesterArgs {
  clientId: string;
  member: string;
  persist: boolean;
  scriptPath?: string;
}

const USAGE =
  'Usage: npm run vapi:test-chat -- <clientId> --member ja|en|ja-return [--persist] [--script <file>]';

export function parseTextTesterArgs(argv: string[]): TextTesterArgs | undefined {
  let member: string | undefined;
  let scriptPath: string | undefined;
  let persist = false;
  const positionals: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--persist') {
      persist = true;
    } else if (arg === '--member') {
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith('--')) {
        member = next;
        index += 1;
      }
    } else if (arg === '--script') {
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith('--')) {
        scriptPath = next;
        index += 1;
      }
    } else if (arg !== undefined && !arg.startsWith('--')) {
      positionals.push(arg);
    }
  }

  const [clientId] = positionals;
  if (!clientId || !member) return undefined;

  return { clientId, member, persist, ...(scriptPath ? { scriptPath } : {}) };
}

function readScriptLines(scriptPath: string): string[] {
  return readFileSync(scriptPath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

export async function runTextTester(argv: string[]): Promise<number> {
  const args = parseTextTesterArgs(argv);
  if (!args) {
    printError(USAGE);
    return 1;
  }

  const env = loadEnv();
  if (!env.OPENAI_API_KEY) {
    printError('OPENAI_API_KEY is not set — see .env.example.');
    return 1;
  }

  let rendered: RenderResult;
  try {
    rendered = await loadRenderedMember(args.clientId, args.member);
  } catch (error) {
    printError(error instanceof Error ? error.message : String(error));
    return 1;
  }

  const config = loadClient(args.clientId);
  const language = contentLanguageOf(config, args.member);

  printLine(
    `Testing "${args.clientId}" / member "${args.member}" against ${OPENAI_MODEL} (OpenAI).`,
  );
  printLine(
    'LIMITATION: this tool exercises prompt/tool-call logic only — the real Squad handoff ' +
      'mechanism is Vapi-specific and is never actually triggered (VAPI-FACTS.md VP-7).',
  );
  printLine('');
  printLine(formatAgentLine(rendered.assistant.firstMessage));

  const tools = buildToolDefs(rendered);
  let messages = initialMessages(rendered);
  const callModel = makeOpenAiCaller(env.OPENAI_API_KEY);
  const callId = `text-tester-${Date.now()}`;

  const pool = args.persist ? createPool({ connectionString: env.DATABASE_URL }) : undefined;
  const callbacks = pool ? new PgCallbackRequestRepository(pool) : undefined;
  const toolDeps: ToolCallHandlerDeps = {
    persist: args.persist,
    clientId: args.clientId,
    language,
    callId,
    ...(callbacks ? { callbacks } : {}),
    printLine,
  };

  try {
    if (args.scriptPath) {
      for (const line of readScriptLines(args.scriptPath)) {
        printLine(`Caller: ${line}`);
        messages = [...messages, { role: 'user', content: line }];
        const result = await runTurn(messages, tools, callModel, toolDeps);
        messages = result.messages;
        if (result.ended) {
          printLine('(call ended)');
          break;
        }
      }
    } else {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        for (;;) {
          const line = await rl.question('Caller: ');
          const trimmed = line.trim();
          if (trimmed === '/exit') break;
          if (trimmed.length === 0) continue;

          messages = [...messages, { role: 'user', content: trimmed }];
          const result = await runTurn(messages, tools, callModel, toolDeps);
          messages = result.messages;
          if (result.ended) {
            printLine('(call ended — exiting)');
            break;
          }
        }
      } finally {
        rl.close();
      }
    }
  } finally {
    if (pool) await pool.end();
  }

  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  runTextTester(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      printError(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}

/**
 * ⚠️ CURRENTLY BROKEN as a validation tool (VP-9, 2026-10-06): this calls
 * OpenAI's /v1/chat/completions directly with `render.ts`'s exported
 * `MODEL_ID`, which assumed the live model was always an OpenAI one. Since
 * VP-9 switched the real assistants to `google`/`gemini-3.1-flash-lite`,
 * `MODEL_ID` is now a Gemini id — OpenAI's API will reject every request
 * with an unknown-model error. `npm run vapi:test-web` (webTester.ts) reuses
 * this same caller and is equally broken. Not fixed yet: a real fix needs a
 * second, Gemini-calling path (different API, different auth, different
 * response shape), not a one-line change. Until then, local turn-by-turn
 * prompt/tool-call validation isn't possible — rely on real Vapi calls plus
 * the `GET /assistant/{id}` read-back instead (see VAPI-FACTS.md VP-9 R4).
 *
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
 * VP-8: this tool now always needs a reachable Postgres — the reservation
 * services list (for prompt grounding and the book_appointment tool schema)
 * and every reservation-tool read (availability, patient lookup) go straight
 * to the real local dev database, the same "own database" the demo feature
 * is built around. `--persist` still gates WRITES only (request_callback and
 * book_appointment) — reads were never optional even for callbacks before
 * VP-8 and stay that way.
 *
 * LIMITATION (flagged wherever this tool prints its banner and in the work
 * order): the real Squad handoff *mechanism* is Vapi-specific and cannot be
 * exercised here. When the model calls a handoff tool, this tool prints the
 * call (proving the model decided correctly — right target, right trigger)
 * and ends the session; re-run with `--member <target>` to keep testing
 * prompt/tool-call logic from the other side of the handoff.
 *
 * `npm run vapi:test-chat -- <clientId> --member ja|en|ja-return [--persist] [--script <file>]`
 *   --persist       request_callback and book_appointment tool calls actually
 *                   write to the local dev Postgres (repositories under
 *                   src/repositories/), so a full save can be verified
 *                   end-to-end at zero Vapi cost.
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
import { normalizePhoneDigits } from '../lib/phone.js';
import { checkAvailability } from '../reservation/availability.js';
import {
  PgCallbackRequestRepository,
  type CallbackRequestRepository,
} from '../repositories/callbackRequestRepository.js';
import {
  PgAppointmentRepository,
  type AppointmentRepository,
} from '../repositories/appointmentRepository.js';
import {
  PgReservationPatientRepository,
  type ReservationPatientRepository,
} from '../repositories/reservationPatientRepository.js';
import {
  PgReservationServiceRepository,
  type ReservationServiceRepository,
} from '../repositories/reservationServiceRepository.js';
import { MODEL_ID, MODEL_REASONING_EFFORT, renderAssistant, type RenderResult } from './render.js';
import { contentLanguageOf } from './squad.js';
import {
  BOOK_APPOINTMENT_FUNCTION_NAME,
  CHECK_AVAILABILITY_FUNCTION_NAME,
  END_CALL_FUNCTION_NAME,
  LOG_CALL_TOPIC_FUNCTION_NAME,
  LOOKUP_PATIENT_FUNCTION_NAME,
} from './toolNames.js';
import type { VapiFunctionDefinition, VapiHandoffDestination } from './types.js';

export const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';
/** Same model production uses — imported from render.ts, never duplicated, so this can't drift. */
export const OPENAI_MODEL = MODEL_ID;
export const OPENAI_MODEL_REASONING_EFFORT = MODEL_REASONING_EFFORT;

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
    ...rendered.reservationTools.map(({ payload }) => toOpenAiTool(payload.function)),
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
  services: ReservationServiceRepository,
): Promise<RenderResult> {
  const config = loadClient(clientId);
  const faq = await new FileKnowledgeSource().listFaq(clientId);
  const serviceList = await services.listByClient(clientId);
  return renderAssistant(config, memberId, faq, {
    baseUrl: PLACEHOLDER_BASE_URL,
    credentialId: PLACEHOLDER_CREDENTIAL_ID,
    services: serviceList,
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

/**
 * Resolves `promptTemplate.ts`'s `todaySection()` Liquid placeholder
 * (`{{"now" | date: "%A, %B %d, %Y, %H:%M", "<tz>"}}`) the same way Vapi's
 * own LiquidJS templating does server-side on a real call (VAPI-FACTS.md
 * VP-7 R5) — this tester talks to OpenAI directly, which has no template
 * engine of its own and no idea what "now" means, so an unresolved
 * placeholder is sent to the model as literal text. Without this, the model
 * has nothing real to compute a relative date ("tomorrow") from and guesses
 * — observed guessing a date roughly 3 years off. Format matches this
 * project's one fixed Liquid call exactly (`%A, %B %d, %Y, %H:%M`); ported
 * from `docs/vp7-test-runs/run-suite.ts.txt`'s equivalent fix for the same
 * gap in that separate, now-superseded ad-hoc script, so every tester that
 * reuses this prompt resolves "now" the same way instead of drifting.
 */
const NOW_PLACEHOLDER_PATTERN = /\{\{"now" \| date: "[^"]+", "([^"]+)"\}\}/g;

export function resolveNowPlaceholders(prompt: string, now: Date = new Date()): string {
  return prompt.replace(NOW_PLACEHOLDER_PATTERN, (_match, timeZone: string) => {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', {
        timeZone,
        weekday: 'long',
        month: 'long',
        day: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      })
        .formatToParts(now)
        .map((part) => [part.type, part.value]),
    );
    return `${parts.weekday}, ${parts.month} ${parts.day}, ${parts.year}, ${parts.hour}:${parts.minute}`;
  });
}

/** System prompt + the member's own firstMessage, seeded as its first spoken turn. */
export function initialMessages(rendered: RenderResult): ChatMessage[] {
  const systemContent = rendered.assistant.model.messages[0]?.content;
  if (systemContent === undefined) {
    throw new Error('renderAssistant produced no system message');
  }
  return [
    { role: 'system', content: resolveNowPlaceholders(systemContent) },
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
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages,
        tools,
        reasoning_effort: OPENAI_MODEL_REASONING_EFFORT,
      }),
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
  /** VP-8: reads (availability, patient lookup) always run when these are given, regardless of `persist`. */
  appointments?: AppointmentRepository;
  patients?: ReservationPatientRepository;
  services?: ReservationServiceRepository;
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

function asBoolean(value: unknown): boolean {
  return value === true;
}

async function handleCheckAvailability(
  call: ChatToolCall,
  deps: ToolCallHandlerDeps,
): Promise<ToolCallOutcome> {
  const args = parseArgs(call);
  const date = asString(args.date);
  const time = asString(args.time);

  if (!deps.appointments) {
    return {
      resultMessage: toolResult(
        call,
        'Availability could not be checked (no database configured).',
      ),
      ended: false,
    };
  }

  const config = loadClient(deps.clientId);
  const takenTimes = await deps.appointments.listTakenTimes(deps.clientId, date);
  const result = checkAvailability(config, date, time, takenTimes);

  let text: string;
  if (result.closed) {
    text = `The clinic is closed on ${date}. Ask the caller for a different date.`;
  } else if (result.requestedAvailable) {
    text = `${time} on ${date} is available.`;
  } else if (result.alternatives.length === 0) {
    text = `${time} on ${date} is not available, and no other times are open that day. Ask the caller for a different date.`;
  } else {
    text = `${time} on ${date} is not available. Available instead: ${result.alternatives.join(', ')}.`;
  }
  return { resultMessage: toolResult(call, text), ended: false };
}

async function handleLookupPatient(
  call: ChatToolCall,
  deps: ToolCallHandlerDeps,
): Promise<ToolCallOutcome> {
  const args = parseArgs(call);
  const phoneDigits = normalizePhoneDigits(asString(args.callerPhone));
  const patient = deps.patients
    ? await deps.patients.findByPhone(deps.clientId, phoneDigits)
    : undefined;
  return {
    resultMessage: toolResult(
      call,
      patient ? `Found: ${patient.name}.` : 'No patient record was found for that phone number.',
    ),
    ended: false,
  };
}

async function handleBookAppointment(
  call: ChatToolCall,
  deps: ToolCallHandlerDeps,
): Promise<ToolCallOutcome> {
  const args = parseArgs(call);
  const serviceId = typeof args.serviceId === 'string' && args.serviceId ? args.serviceId : null;
  let serviceName: string | null = null;
  if (serviceId && deps.services) {
    const services = await deps.services.listByClient(deps.clientId);
    serviceName = services.find((service) => service.id === serviceId)?.name.en ?? null;
  }

  if (deps.persist && deps.appointments) {
    const booked = await deps.appointments.create({
      clientId: deps.clientId,
      callId: deps.callId,
      language: deps.language,
      serviceId,
      serviceName,
      patientPhone: normalizePhoneDigits(asString(args.patientPhone)),
      isReturningPatient: asBoolean(args.isReturningPatient),
      appointmentDate: asString(args.date),
      appointmentTime: asString(args.time),
    });
    deps.printLine(
      `Persisted appointments row: ${booked.id} (reservation ${booked.reservationNumber})`,
    );
    return {
      resultMessage: toolResult(call, `Booked. Reservation number: ${booked.reservationNumber}.`),
      ended: false,
    };
  }

  return {
    resultMessage: toolResult(
      call,
      'Booked. Reservation number: R000000 (not persisted — run with --persist).',
    ),
    ended: false,
  };
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

  if (name === CHECK_AVAILABILITY_FUNCTION_NAME) {
    return handleCheckAvailability(call, deps);
  }

  if (name === LOOKUP_PATIENT_FUNCTION_NAME) {
    return handleLookupPatient(call, deps);
  }

  if (name === BOOK_APPOINTMENT_FUNCTION_NAME) {
    return handleBookAppointment(call, deps);
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

  // VP-8: always connected — the reservation services list, availability
  // checks and patient lookups are real database reads regardless of
  // --persist (which only gates request_callback/book_appointment writes).
  const pool = createPool({ connectionString: env.DATABASE_URL });
  const callbacks = new PgCallbackRequestRepository(pool);
  const appointments = new PgAppointmentRepository(pool);
  const patients = new PgReservationPatientRepository(pool);
  const services = new PgReservationServiceRepository(pool);

  let rendered: RenderResult;
  try {
    rendered = await loadRenderedMember(args.clientId, args.member, services);
  } catch (error) {
    printError(error instanceof Error ? error.message : String(error));
    await pool.end();
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

  const toolDeps: ToolCallHandlerDeps = {
    persist: args.persist,
    clientId: args.clientId,
    language,
    callId,
    callbacks,
    appointments,
    patients,
    services,
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
    await pool.end();
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

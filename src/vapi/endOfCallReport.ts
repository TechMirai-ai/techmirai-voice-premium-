/**
 * Parses Vapi's `end-of-call-report` server message (VAPI-FACTS.md, VP-12 R1).
 *
 * Field names come from the live OpenAPI (`ServerMessageEndOfCallReport`,
 * `Artifact`, `ToolCallMessage`, `ToolCallResultMessage`). Everything but the
 * call id is optional: a report with a missing piece must still produce a row.
 * Nothing here logs — the summary, tool arguments and results can hold names.
 */
import { z } from 'zod';

import type { ToolOutcome } from '../lib/callStatus.js';
import type { AssistantRef } from './assistantResolver.js';

const LOOKUP_TOOL = 'lookup_patient';
const CALLBACK_TOOL = 'request_callback';
const FOUND_PREFIX = 'Found:';

const argumentsSchema = z.union([z.string(), z.record(z.string(), z.unknown())]);

const messageSchema = z.looseObject({
  role: z.string().optional(),
  name: z.string().optional(),
  result: z.string().optional(),
  toolCalls: z
    .array(
      z.looseObject({
        function: z
          .looseObject({ name: z.string().optional(), arguments: argumentsSchema.optional() })
          .optional(),
      }),
    )
    .optional(),
});

const envelopeSchema = z.looseObject({
  message: z.looseObject({
    type: z.literal('end-of-call-report'),
    endedReason: z.string().optional(),
    startedAt: z.string().optional(),
    endedAt: z.string().optional(),
    call: z.looseObject({ id: z.string().min(1) }),
    assistant: z
      .looseObject({ id: z.string().min(1).optional(), name: z.string().min(1).optional() })
      .optional(),
    analysis: z.looseObject({ summary: z.string().optional() }).optional(),
    artifact: z
      .looseObject({
        transcript: z.string().optional(),
        messages: z.array(messageSchema).optional(),
        structuredOutputs: z
          .record(z.string(), z.looseObject({ result: z.unknown().optional() }).nullable())
          .optional(),
        presignedMonoUrl: z.string().optional(),
        presignedUrlsExpiresAt: z.string().optional(),
      })
      .optional(),
  }),
});

export interface EndOfCallReport {
  callId: string;
  assistant: AssistantRef;
  endedReason?: string;
  startedAt?: string;
  endedAt?: string;
  summary?: string;
  /** The full transcript — for the developer archive ONLY, never the staff row. May be empty. */
  transcript: string;
  /** Tool outcomes from `artifact.messages`, in call order. */
  toolResults: ToolOutcome[];
  /** From the first structured output that produced a result. */
  topic?: string;
  resolved?: boolean;
  callerName?: string;
  matchedPatientName?: string;
  /** Short-lived presigned URL; see `recordingUrlExpiresAt`. */
  recordingUrl?: string;
  recordingUrlExpiresAt?: string;
}

const outcomeSchema = z.object({
  topic: z.string().optional(),
  resolved: z.boolean().optional(),
  // `nullish`: a model that can't fill the field may send null, which must not discard topic/resolved.
  summary: z.string().nullish(),
});

/** Bound on the stored summary: it is model output shown to staff, so never unbounded. */
const MAX_SUMMARY_CHARS = 2000;

function firstOutcome(
  outputs: Record<string, { result?: unknown } | null> | undefined,
): z.infer<typeof outcomeSchema> {
  for (const output of Object.values(outputs ?? {})) {
    const parsed = outcomeSchema.safeParse(output?.result);
    if (parsed.success) return parsed.data;
  }
  return {};
}

function parseArguments(raw: z.infer<typeof argumentsSchema> | undefined) {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') return raw;
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

type Message = z.infer<typeof messageSchema>;

function callerNameOf(messages: readonly Message[]): string | undefined {
  for (const message of messages) {
    for (const call of message.toolCalls ?? []) {
      if (call.function?.name !== CALLBACK_TOOL) continue;
      const name = parseArguments(call.function.arguments)?.callerName;
      if (typeof name === 'string' && name.trim()) return name.trim();
    }
  }
  return undefined;
}

function matchedPatientOf(messages: readonly Message[]): string | undefined {
  for (const message of messages) {
    if (message.role !== 'tool_call_result' || message.name !== LOOKUP_TOOL) continue;
    const result = (message.result ?? '').trim();
    if (!result.startsWith(FOUND_PREFIX)) continue;
    const name = result.slice(FOUND_PREFIX.length).trim().replace(/\.$/, '').trim();
    if (name) return name;
  }
  return undefined;
}

/** Returns `undefined` when `body` is not a well-formed end-of-call-report. */
export function parseEndOfCallReport(body: unknown): EndOfCallReport | undefined {
  const parsed = envelopeSchema.safeParse(body);
  if (!parsed.success) return undefined;

  const { message } = parsed.data;
  const artifact = message.artifact;
  const messages = artifact?.messages ?? [];
  const outcome = firstOutcome(artifact?.structuredOutputs);
  const assistant = message.assistant ?? {};
  const callerName = callerNameOf(messages);
  const matchedPatientName = matchedPatientOf(messages);
  // The structured output is the primary source (VAPI-FACTS.md VP-14); `analysis.summary` is only
  // there if someone re-enables Vapi's deprecated analysisPlan.
  const summary = (
    outcome.summary?.trim() ||
    message.analysis?.summary?.trim() ||
    undefined
  )?.slice(0, MAX_SUMMARY_CHARS);

  return {
    callId: message.call.id,
    assistant: {
      ...(assistant.id ? { id: assistant.id } : {}),
      ...(assistant.name ? { name: assistant.name } : {}),
    },
    ...(message.endedReason ? { endedReason: message.endedReason } : {}),
    ...(message.startedAt ? { startedAt: message.startedAt } : {}),
    ...(message.endedAt ? { endedAt: message.endedAt } : {}),
    ...(summary ? { summary } : {}),
    transcript: artifact?.transcript ?? '',
    toolResults: messages
      .filter((entry) => entry.role === 'tool_call_result' && entry.name)
      .map((entry) => ({ name: entry.name ?? '', result: entry.result })),
    ...(outcome.topic ? { topic: outcome.topic } : {}),
    ...(outcome.resolved !== undefined ? { resolved: outcome.resolved } : {}),
    ...(callerName ? { callerName } : {}),
    ...(matchedPatientName ? { matchedPatientName } : {}),
    ...(artifact?.presignedMonoUrl ? { recordingUrl: artifact.presignedMonoUrl } : {}),
    ...(artifact?.presignedUrlsExpiresAt
      ? { recordingUrlExpiresAt: artifact.presignedUrlsExpiresAt }
      : {}),
  };
}

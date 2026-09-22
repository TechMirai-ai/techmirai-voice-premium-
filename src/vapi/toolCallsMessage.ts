/**
 * Parses Vapi's `tool-calls` webhook envelope (VAPI-FACTS.md, VP-4 R1–R3).
 *
 * Vapi's SDK types say each tool call is `{ id, type, function: { name,
 * arguments: "<json string>" } }`; its docs page shows `{ id, name, parameters }`.
 * Both are accepted so a shape difference on the real wire cannot break a call.
 * Nothing here logs: the arguments may hold a caller's name and phone number.
 */
import { z } from 'zod';

const argumentsSchema = z.union([z.string(), z.record(z.string(), z.unknown())]);

const toolCallSchema = z.looseObject({
  id: z.string().min(1),
  name: z.string().optional(),
  function: z
    .looseObject({ name: z.string().optional(), arguments: argumentsSchema.optional() })
    .optional(),
  arguments: argumentsSchema.optional(),
  parameters: argumentsSchema.optional(),
});

const assistantRefSchema = z.looseObject({
  id: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
});

const envelopeSchema = z.looseObject({
  message: z.looseObject({
    type: z.literal('tool-calls'),
    call: z.looseObject({ id: z.string().min(1) }),
    assistant: assistantRefSchema.optional(),
    toolCallList: z.array(toolCallSchema).optional(),
    toolWithToolCallList: z
      .array(z.looseObject({ toolCall: toolCallSchema.optional() }))
      .optional(),
  }),
});

export interface ToolCallRequest {
  toolCallId: string;
  name: string;
  /** Parsed arguments, or `undefined` when they were missing or not a JSON object. */
  args: Record<string, unknown> | undefined;
}

export interface ToolCallsMessage {
  callId: string;
  assistant: { id?: string; name?: string };
  toolCalls: ToolCallRequest[];
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

function toRequest(call: z.infer<typeof toolCallSchema>): ToolCallRequest {
  return {
    toolCallId: call.id,
    name: call.function?.name ?? call.name ?? '',
    args: parseArguments(call.function?.arguments ?? call.arguments ?? call.parameters),
  };
}

/** Returns `undefined` when `body` is not a well-formed tool-calls message. */
export function parseToolCallsMessage(body: unknown): ToolCallsMessage | undefined {
  const parsed = envelopeSchema.safeParse(body);
  if (!parsed.success) return undefined;

  const { message } = parsed.data;
  const calls =
    message.toolCallList ??
    (message.toolWithToolCallList ?? []).flatMap((item) => (item.toolCall ? [item.toolCall] : []));
  const assistant = message.assistant ?? {};

  return {
    callId: message.call.id,
    assistant: {
      ...(assistant.id ? { id: assistant.id } : {}),
      ...(assistant.name ? { name: assistant.name } : {}),
    },
    toolCalls: calls.map(toRequest),
  };
}

/** Vapi's required response shape (VAPI-FACTS.md): HTTP 200, a single-line string, id echoed back. */
export interface ToolCallResult {
  name: string;
  toolCallId: string;
  result?: string;
  error?: string;
}

const singleLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

export const okResult = (call: ToolCallRequest, text: string): ToolCallResult => ({
  name: call.name,
  toolCallId: call.toolCallId,
  result: singleLine(text),
});

export const errorResult = (call: ToolCallRequest, text: string): ToolCallResult => ({
  name: call.name,
  toolCallId: call.toolCallId,
  error: singleLine(text),
});

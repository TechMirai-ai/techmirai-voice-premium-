/**
 * The flow shared by both voice webhooks: parse Vapi's envelope, derive the
 * client, language and call id server-side, run one handler per matching tool
 * call, and answer in Vapi's required shape.
 *
 * Failure policy (VP-4 §3): once the envelope is valid, EVERY outcome — bad
 * arguments, unknown assistant, database failure — is answered with HTTP 200
 * and an `error` result, so the assistant can speak its graceful failure line.
 * Only a body that is not a tool-calls message at all gets a 400, because
 * there is no tool call id to answer.
 */
import type { Request, RequestHandler, Response } from 'express';

import { summarizeError } from '../lib/errorSummary.js';
import { logger } from '../lib/logger.js';
import type {
  AssistantRef,
  AssistantResolver,
  ResolvedAssistant,
} from '../vapi/assistantResolver.js';
import {
  errorResult,
  parseToolCallsMessage,
  type ToolCallRequest,
  type ToolCallResult,
} from '../vapi/toolCallsMessage.js';

export interface WebhookContext extends ResolvedAssistant {
  callId: string;
}

export interface ToolWebhookOptions {
  /** The function name the model calls, e.g. "request_callback". */
  toolName: string;
  resolver: AssistantResolver;
  handle(context: WebhookContext, call: ToolCallRequest): Promise<ToolCallResult>;
}

/** A real request carries one or two; the rest of an oversized list is ignored. */
export const MAX_TOOL_CALLS_PER_REQUEST = 10;

const UNKNOWN_ASSISTANT = 'This call could not be matched to a clinic, so nothing was saved.';
const UNEXPECTED_FAILURE = 'A system problem prevented this from being saved.';

export function toolWebhook(options: ToolWebhookOptions): RequestHandler {
  return async (req: Request, res: Response): Promise<void> => {
    const message = parseToolCallsMessage(req.body);
    if (!message) {
      logger.warn('webhook rejected: not a tool-calls message', { path: req.path });
      res.status(400).json({ status: 'error', error: 'bad_request' });
      return;
    }

    const calls = message.toolCalls
      .filter((call) => call.name === options.toolName)
      .slice(0, MAX_TOOL_CALLS_PER_REQUEST);
    const resolved = safeResolve(options.resolver, message.assistant);
    if (!resolved) {
      logger.error('webhook: assistant could not be resolved to a client', {
        path: req.path,
        callId: message.callId,
      });
    }

    // Sequential, so one request can never open many database connections at once.
    const results: ToolCallResult[] = [];
    for (const call of calls) {
      results.push(
        resolved
          ? await runHandler(options, { ...resolved, callId: message.callId }, call)
          : errorResult(call, UNKNOWN_ASSISTANT),
      );
    }

    res.status(200).json({ results });
  };
}

function safeResolve(
  resolver: AssistantResolver,
  ref: AssistantRef,
): ResolvedAssistant | undefined {
  try {
    return resolver.resolve(ref);
  } catch (error) {
    logger.error('assistant resolver failed', { ...summarizeError(error) });
    return undefined;
  }
}

async function runHandler(
  options: ToolWebhookOptions,
  context: WebhookContext,
  call: ToolCallRequest,
): Promise<ToolCallResult> {
  try {
    return await options.handle(context, call);
  } catch (error) {
    logger.error('webhook handler failed', {
      tool: options.toolName,
      clientId: context.clientId,
      callId: context.callId,
      ...summarizeError(error),
    });
    return errorResult(call, UNEXPECTED_FAILURE);
  }
}

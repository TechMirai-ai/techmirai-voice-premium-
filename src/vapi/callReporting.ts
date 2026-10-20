/**
 * What makes Vapi report every finished call to us (VP-12, FUTURE-FEATURES F-10).
 * Pure — no network, no filesystem.
 *
 *  - `renderReportingConfig` — the assistant-level `server` + `serverMessages` that route ONLY the
 *    `end-of-call-report` event to our webhook, plus `artifactPlan` (recording on, structured output
 *    linked). Set on every assistant AND threaded through every handoff leg's `assistantOverrides`
 *    (squad.ts), the same reason as `callEnding.ts`: a destination's saved settings are not reliably
 *    carried across a handoff (VAPI-FACTS.md VP-6 R3). A report arriving twice is harmless — the
 *    `call_logs` write is idempotent per (client, call).
 *  - `renderCallOutcomeOutput` — the per-client structured output Vapi runs after each call. It is the
 *    only source of "was this resolved by the AI?" (the model-called `log_call_topic` tool is not —
 *    VAPI-FACTS.md VP-7 R8) and of the staff-facing call summary: Vapi's own `analysis.summary` is
 *    off on our assistants and `analysisPlan` is deprecated (VAPI-FACTS.md VP-14).
 */
import type { ClientConfig } from '../config/schema.js';
import type { FaqEntry } from '../knowledge/KnowledgeSource.js';
import { allowedTopics } from '../lib/callTopics.js';
import { businessNoun } from './promptShared.js';
import type { VapiReportingConfig, VapiStructuredOutputPayload } from './types.js';

export const END_OF_CALL_REPORT_ROUTE = '/api/voice/end-of-call-report';

/** Vapi: "Name field limited to 40 characters" (VAPI-FACTS.md VP-12). */
const MAX_OUTPUT_NAME_LENGTH = 40;

export class ClientIdTooLongForOutputError extends Error {
  constructor(clientId: string, name: string) {
    super(
      `"${clientId}": the structured output name "${name}" is longer than ${MAX_OUTPUT_NAME_LENGTH} ` +
        'characters, which Vapi rejects. Use a shorter client id.',
    );
    this.name = 'ClientIdTooLongForOutputError';
  }
}

/** Bookkeeping key in `.vapi-state.<clientId>.json` — also the output's name on Vapi. */
export function callOutcomeStateName(clientId: string): string {
  return `${clientId}--call-outcome`;
}

/**
 * Extra summary instructions for the clients that configure them (VP-19) — empty otherwise, so
 * everyone else's output is untouched. The emergency flag is the dashboard's only marker of a
 * safety report (the status itself is just `needs_callback`), so it goes first in the summary.
 */
function summaryExtras(config: ClientConfig): string {
  const safety = config.emergency
    ? ` If the caller reported ${config.emergency.label}, the summary MUST begin with exactly ` +
      `"${config.emergency.callbackReason}" and then continue as usual — staff rely on that prefix ` +
      'to spot a safety report.'
    : '';
  const address = config.reservationFlow?.askServiceAddress
    ? ' If the caller gave a service address for a booking, include the address exactly as the ' +
      'caller said it, together with the service and the booked date and time — staff have no ' +
      'other record of it.'
    : '';
  return `${safety}${address}`;
}

export function renderCallOutcomeOutput(
  config: ClientConfig,
  faq: readonly Pick<FaqEntry, 'id'>[],
): VapiStructuredOutputPayload {
  const name = callOutcomeStateName(config.clientId);
  if (name.length > MAX_OUTPUT_NAME_LENGTH) {
    throw new ClientIdTooLongForOutputError(config.clientId, name);
  }

  return {
    name,
    type: 'ai',
    description:
      `Classifies a finished ${businessNoun(config)}-reception call: which topic it was about and whether the ` +
      'AI receptionist fully handled it. Used for the staff call list.',
    schema: {
      type: 'object',
      properties: {
        topic: {
          type: 'string',
          description:
            'The single best-matching topic id for the whole call; "other" if it fits none, ' +
            '"unresolved" if the caller\'s need was not met.',
          enum: allowedTopics(faq.map((entry) => entry.id)),
        },
        resolved: {
          type: 'boolean',
          description:
            "True only if the AI fully answered the caller's question itself with no follow-up needed. " +
            'False if the caller asked for a callback, wanted staff, booked an appointment, hung up ' +
            'before getting an answer, or the question was not answered.',
        },
        summary: {
          type: 'string',
          description:
            `A short summary of the call for ${config.promptOverrides?.staffLabel ?? 'clinic staff'}, in 1-3 plain sentences, written in the ` +
            'language the caller spoke: what the caller wanted and what happened (answered, booked, ' +
            'callback requested, or not resolved). If the call ended before anything was said, say ' +
            'so in one short sentence. Do not invent details.' +
            summaryExtras(config),
        },
      },
      required: ['topic', 'resolved', 'summary'],
    },
  };
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

/** @param outcomeOutputId Unknown in a dry run, before the structured output exists on Vapi. */
export function renderReportingConfig(
  baseUrl: string,
  credentialId: string,
  outcomeOutputId?: string,
): VapiReportingConfig {
  return {
    server: { url: `${stripTrailingSlash(baseUrl)}${END_OF_CALL_REPORT_ROUTE}`, credentialId },
    serverMessages: ['end-of-call-report'],
    artifactPlan: {
      recordingEnabled: true,
      ...(outcomeOutputId ? { structuredOutputIds: [outcomeOutputId] } : {}),
    },
  };
}

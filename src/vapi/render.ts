/**
 * Renders one client/language into the Vapi payloads sync.ts will send.
 * Pure — no network calls, no filesystem access, fully unit-testable.
 *
 * Deviates from the work order's literal 3-arg signature by taking a 4th
 * `options.baseUrl` parameter instead of reading PUBLIC_BASE_URL from
 * process.env internally: that keeps this function actually pure (env
 * loading — and its unrelated required vars like DATABASE_URL — stays at
 * the edges, in cli.ts, matching every other module in this codebase).
 */
import {
  UnsupportedLanguageError,
  buildSystemPrompt,
  fillClinicPlaceholders,
  pick,
} from './promptTemplate.js';
import type { ClientConfig } from '../config/schema.js';
import type { FaqEntry } from '../knowledge/KnowledgeSource.js';
import {
  assistantResourceName,
  handoffTargets,
  renderArrivalMessage,
  renderHandoffTool,
} from './squad.js';
import type {
  VapiAssistantPayload,
  VapiFunctionToolPayload,
  VapiHandoffToolPayload,
} from './types.js';

export class UnconfiguredTranscriberError extends Error {
  constructor(clientId: string, language: string) {
    super(
      `client.yaml for "${clientId}" has no transcriber configured for language "${language}" yet ` +
        `(languages.settings.${language}.transcriber is null)`,
    );
    this.name = 'UnconfiguredTranscriberError';
  }
}

/** The plain, short identifier the model calls — see types.ts and VAPI-FACTS.md. */
export const REQUEST_CALLBACK_FUNCTION_NAME = 'request_callback';

/** VAPI-FACTS.md R3: primary model choice for VP-2's assistants (fallback: anthropic/claude-sonnet-5). */
const MODEL_PROVIDER = 'openai';
const MODEL_ID = 'gpt-4o-mini';

export interface RenderOptions {
  /** Public HTTPS base URL Vapi will call — from PUBLIC_BASE_URL, never hard-coded (CLAUDE.md / work order §3). */
  baseUrl: string;
}

export interface RenderedHandoffTool {
  /** The language this tool hands the call to. */
  toLanguage: string;
  payload: VapiHandoffToolPayload;
}

export interface RenderResult {
  assistant: VapiAssistantPayload;
  tool: VapiFunctionToolPayload;
  /** One per other supported language; empty for a single-language client. */
  handoffTools: RenderedHandoffTool[];
}

/** Strips a trailing slash so `${baseUrl}/api/...` never ends up with `//`. */
function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

export function renderAssistant(
  config: ClientConfig,
  language: string,
  faq: FaqEntry[],
  options: RenderOptions,
): RenderResult {
  if (!config.languages.supported.includes(language)) {
    throw new UnsupportedLanguageError(config.clientId, language, config.languages.supported);
  }

  const settings = config.languages.settings[language];
  if (!settings) {
    // Guaranteed present for every supported language by rules.ts's
    // languageIssues check on a validated config — this is unreachable in
    // practice, kept only to satisfy noUncheckedIndexedAccess.
    throw new UnsupportedLanguageError(config.clientId, language, config.languages.supported);
  }
  if (!settings.transcriber) {
    throw new UnconfiguredTranscriberError(config.clientId, language);
  }

  const callbackUrl = `${stripTrailingSlash(options.baseUrl)}/api/voice/callback-request`;
  const systemPrompt = buildSystemPrompt(config, language, faq);
  const failureMessage = fillClinicPlaceholders(
    config,
    language,
    pick(config.scripts.callbackFailed, language),
  );
  // The default language's assistant starts every call, so it opens with the
  // greeting. Any other language's assistant is only ever reached by a handoff,
  // so it opens with its arrival message instead.
  const firstMessage =
    language === config.languages.default
      ? fillClinicPlaceholders(config, language, pick(config.scripts.greeting, language))
      : renderArrivalMessage(config, language);

  const tool: VapiFunctionToolPayload = {
    type: 'function',
    function: {
      name: REQUEST_CALLBACK_FUNCTION_NAME,
      description:
        "Records the caller's name, phone number, and a short reason so staff can call them back.",
      parameters: {
        type: 'object',
        properties: {
          callerName: { type: 'string', description: "The caller's name." },
          callerPhone: { type: 'string', description: "The caller's phone number." },
          reason: {
            type: 'string',
            description: 'A short summary of what the caller was asking about.',
          },
        },
        required: ['callerName', 'callerPhone'],
      },
    },
    server: { url: callbackUrl },
    // Safety net per work order §4.4: spoken if the model doesn't produce a
    // timely response of its own after the tool call fails.
    messages: [{ type: 'request-failed', content: failureMessage }],
  };

  const assistant: VapiAssistantPayload = {
    name: assistantResourceName(config.clientId, language),
    firstMessage,
    voice: { provider: settings.voice.provider, voiceId: settings.voice.voiceId },
    transcriber: {
      provider: settings.transcriber.provider,
      language: settings.transcriber.language,
    },
    model: {
      provider: MODEL_PROVIDER,
      model: MODEL_ID,
      messages: [{ role: 'system', content: systemPrompt }],
      // Populated by sync.ts once the tools (request_callback + one handoff
      // tool per other language) have resolved UUIDs — create/update the tools
      // first, then patch this in before the assistant create/update call.
      toolIds: [],
    },
  };

  const handoffTools = handoffTargets(config, language).map((toLanguage) => ({
    toLanguage,
    payload: renderHandoffTool(config, language, toLanguage),
  }));

  return { assistant, tool, handoffTools };
}

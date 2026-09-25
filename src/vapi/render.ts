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
import { allowedTopics, CALL_OUTCOMES } from '../lib/callTopics.js';
import { endCallPhrasesFor, silenceHangupHook } from './callEnding.js';
import {
  UnsupportedLanguageError,
  buildSystemPrompt,
  fillClinicPlaceholders,
  goodbyeMessage,
  pick,
} from './promptTemplate.js';
import type { ClientConfig } from '../config/schema.js';
import { LOG_CALL_TOPIC_FUNCTION_NAME, REQUEST_CALLBACK_FUNCTION_NAME } from './toolNames.js';
import type { FaqEntry } from '../knowledge/KnowledgeSource.js';
import {
  assistantResourceName,
  contentLanguageOf,
  handoffTargets,
  renderArrivalMessage,
  renderHandoffTool,
} from './squad.js';
import type {
  VapiAssistantPayload,
  VapiFunctionToolPayload,
  VapiHandoffToolPayload,
  VapiStartSpeakingPlan,
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

export { LOG_CALL_TOPIC_FUNCTION_NAME, REQUEST_CALLBACK_FUNCTION_NAME };

/** VAPI-FACTS.md R3: primary model choice for VP-2's assistants (fallback: anthropic/claude-sonnet-5). */
const MODEL_PROVIDER = 'openai';
/** Exported so textTester.ts (VP-7) calls the exact same model, not a substitute — zero drift. */
export const MODEL_ID = 'gpt-4o-mini';

export interface RenderOptions {
  /** Public HTTPS base URL Vapi will call — from PUBLIC_BASE_URL, never hard-coded (CLAUDE.md / work order §3). */
  baseUrl: string;
  /** Vapi Custom Credential authenticating our webhooks — from VAPI_SERVER_CREDENTIAL_ID (VP-4 R4). */
  credentialId: string;
}

export interface RenderedHandoffTool {
  /** The language this tool hands the call to. */
  toLanguage: string;
  payload: VapiHandoffToolPayload;
}

export interface RenderResult {
  assistant: VapiAssistantPayload;
  tool: VapiFunctionToolPayload;
  /** The silent, asynchronous `log_call_topic` analytics tool. */
  topicTool: VapiFunctionToolPayload;
  /** One per other supported language; empty for a single-language client. */
  handoffTools: RenderedHandoffTool[];
}

/** Strips a trailing slash so `${baseUrl}/api/...` never ends up with `//`. */
function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

/** Escapes regex metacharacters so a literal script line is safe to use as a Vapi endpointing-rule regex. */
function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * VP-6 §A: text-based smart endpointing (works for any language). The "vapi"
 * smartEndpointingPlan provider decides using transcriptionEndpointingPlan's
 * own heuristic rules (VAPI-FACTS.md VP-6 R7) — leaving that unset meant it
 * silently used the default 1.5s `onNoPunctuationSeconds` wait, identical to
 * the behavior it was meant to shorten. Set explicitly here, alongside a
 * targeted `customEndpointingRules` override for the one turn that needs
 * *more* patience — right after the assistant asks for the phone number,
 * since callers read digits back in paused chunks.
 */
const NO_PUNCTUATION_WAIT_SECONDS = 0.7;

function buildStartSpeakingPlan(config: ClientConfig, language: string): VapiStartSpeakingPlan {
  const askPhoneText = fillClinicPlaceholders(
    config,
    language,
    pick(config.scripts.askPhone, language),
  );

  return {
    smartEndpointingPlan: { provider: 'vapi' },
    transcriptionEndpointingPlan: { onNoPunctuationSeconds: NO_PUNCTUATION_WAIT_SECONDS },
    customEndpointingRules: [
      {
        type: 'assistant',
        regex: escapeRegex(askPhoneText),
        timeoutSeconds: 2.5,
      },
    ],
  };
}

/**
 * Silent on every path: an empty message stops Vapi speaking a filler or a
 * result line, and analytics must never be mentioned to the caller. `async`
 * means the assistant does not wait for our server (VP-4 §4.3).
 */
function renderTopicTool(
  url: string,
  credentialId: string,
  topics: string[],
): VapiFunctionToolPayload {
  return {
    type: 'function',
    async: true,
    function: {
      name: LOG_CALL_TOPIC_FUNCTION_NAME,
      description:
        'Silently records which topic the whole call was about and how it ended. ' +
        'Call it once, as your very last action, after saying goodbye. Never mention it to the caller.',
      parameters: {
        type: 'object',
        properties: {
          topic: {
            type: 'string',
            description:
              'The single best-matching FAQ topic id for the whole call; "other" if it fits none, ' +
              '"unresolved" if a callback was needed, "emergency" for a medical emergency.',
            enum: topics,
          },
          outcome: {
            type: 'string',
            description: 'How the call ended.',
            enum: [...CALL_OUTCOMES],
          },
        },
        required: ['topic', 'outcome'],
      },
    },
    server: { url, credentialId },
    messages: [
      { type: 'request-start', content: '' },
      { type: 'request-complete', content: '' },
      { type: 'request-failed', content: '' },
    ],
  };
}

/**
 * @param memberId A squad member id — a plain language code (e.g. "ja",
 *   "en") or the default language's "-return" variant (VP-7 R1). Every
 *   content lookup (voice, transcriber, system prompt, FAQ, scripts) uses
 *   `contentLanguageOf(config, memberId)`, never `memberId` directly; only
 *   the resource `name` and the greeting-vs-arrival-message choice use the
 *   raw member id, since those are the two things a "-return" member needs
 *   to differ on from its own language's call-starting member.
 */
export function renderAssistant(
  config: ClientConfig,
  memberId: string,
  faq: FaqEntry[],
  options: RenderOptions,
): RenderResult {
  const language = contentLanguageOf(config, memberId);
  if (!config.languages.supported.includes(language)) {
    throw new UnsupportedLanguageError(config.clientId, memberId, config.languages.supported);
  }

  const settings = config.languages.settings[language];
  if (!settings) {
    // Guaranteed present for every supported language by rules.ts's
    // languageIssues check on a validated config — this is unreachable in
    // practice, kept only to satisfy noUncheckedIndexedAccess.
    throw new UnsupportedLanguageError(config.clientId, memberId, config.languages.supported);
  }
  if (!settings.transcriber) {
    throw new UnconfiguredTranscriberError(config.clientId, language);
  }

  const baseUrl = stripTrailingSlash(options.baseUrl);
  const callbackUrl = `${baseUrl}/api/voice/callback-request`;
  const topicUrl = `${baseUrl}/api/voice/call-topic`;
  const systemPrompt = buildSystemPrompt(config, language, faq);
  const failureMessage = fillClinicPlaceholders(
    config,
    language,
    pick(config.scripts.callbackFailed, language),
  );
  // The member that starts every call (its id equals the default language)
  // opens with the greeting. Every other member — including the "-return"
  // variant of the default language — is only ever reached by a handoff, so
  // it opens with its arrival message instead.
  const firstMessage =
    memberId === config.languages.default
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
    server: { url: callbackUrl, credentialId: options.credentialId },
    // Safety net per work order §4.4: spoken if the model doesn't produce a
    // timely response of its own after the tool call fails.
    messages: [{ type: 'request-failed', content: failureMessage }],
  };

  const topicTool = renderTopicTool(
    topicUrl,
    options.credentialId,
    allowedTopics(faq.map((entry) => entry.id)),
  );

  const endCallPhrases = endCallPhrasesFor(config, language);

  const assistant: VapiAssistantPayload = {
    name: assistantResourceName(config.clientId, memberId),
    firstMessage,
    voice: { provider: settings.voice.provider, voiceId: settings.voice.voiceId },
    transcriber: {
      provider: settings.transcriber.provider,
      language: settings.transcriber.language,
    },
    startSpeakingPlan: buildStartSpeakingPlan(config, language),
    model: {
      provider: MODEL_PROVIDER,
      model: MODEL_ID,
      messages: [{ role: 'system', content: systemPrompt }],
      // Populated by sync.ts once the tools (request_callback + one handoff
      // tool per other language) have resolved UUIDs — create/update the tools
      // first, then patch this in before the assistant create/update call.
      toolIds: [],
      // Built-in, no server round-trip — lets the model hang up itself
      // instead of leaving the call open (VAPI-FACTS.md VP-4 R5).
      tools: [{ type: 'endCall' }],
    },
    // Guarantees the goodbye is actually spoken before the call ends,
    // regardless of whether the model says anything itself: the baseline
    // call found the model sometimes jumps straight from the last user turn
    // to the silent endCall/log_call_topic tool calls with no goodbye in
    // between (VAPI-FACTS.md, "Baseline call finding", 2026-09-22). A tool
    // `messages`/`blocking` entry on `endCall` was tried first and proven to
    // be a no-op by a real call (VAPI-FACTS.md VP-6 R2) — `endCallMessage`
    // is the assistant-level field Vapi actually speaks on hangup.
    endCallMessage: goodbyeMessage(config, language),
    // Platform-level backstops for a model that doesn't call endCall itself (VAPI-FACTS.md VP-7
    // R8) — the same values squad.ts threads through each handoff leg's overrides.
    ...(endCallPhrases ? { endCallPhrases } : {}),
    hooks: [silenceHangupHook()],
  };

  const handoffTools = handoffTargets(config, language).map((toLanguage) => ({
    toLanguage,
    payload: renderHandoffTool(config, language, toLanguage),
  }));

  return { assistant, tool, topicTool, handoffTools };
}

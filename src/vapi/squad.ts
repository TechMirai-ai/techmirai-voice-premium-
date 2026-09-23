/**
 * Squad and language-handoff rendering. Pure — no network, no filesystem.
 *
 * Shape confirmed against the SDK types and a real two-way call (see
 * docs/VAPI-FACTS.md, VP-3 R1/R2/R5): one `handoff` tool per (from, to)
 * language pair, destinations by `assistantName`, and a Squad whose first
 * member is the client's default language.
 */
import {
  UnsupportedLanguageError,
  fillClinicPlaceholders,
  goodbyeMessage,
  pick,
} from './promptTemplate.js';
import type { ClientConfig, ScriptKey } from '../config/schema.js';
import type { VapiHandoffToolPayload, VapiSquadPayload } from './types.js';

export class MissingArrivalScriptError extends Error {
  constructor(clientId: string, language: string) {
    super(
      `"${clientId}": no script is defined for what the "${language}" assistant says when a call ` +
        'is handed to it. Add one to client.yaml and to ARRIVAL_SCRIPT_KEYS in src/vapi/squad.ts.',
    );
    this.name = 'MissingArrivalScriptError';
  }
}

/**
 * Which script an assistant speaks when a call is handed *to* it. The script
 * key names are fixed by the client.yaml schema (`englishGreeting`,
 * `handoffToJapanese`), so this is the one place a language code meets a key.
 * A third language (FUTURE-FEATURES F-6) adds its own script and one line here
 * — or replaces both with a single generic `handoffGreeting` script.
 */
const ARRIVAL_SCRIPT_KEYS: Readonly<Record<string, ScriptKey>> = {
  en: 'englishGreeting',
  ja: 'handoffToJapanese',
};

/** What `language`'s assistant says when a caller is handed to it, placeholders filled. */
export function renderArrivalMessage(config: ClientConfig, language: string): string {
  const key = ARRIVAL_SCRIPT_KEYS[language];
  if (!key) throw new MissingArrivalScriptError(config.clientId, language);
  return fillClinicPlaceholders(config, language, pick(config.scripts[key], language));
}

/** The default language first (it starts the call), then the rest in `supported` order. */
export function orderedLanguages(config: ClientConfig): string[] {
  const { default: defaultLanguage, supported } = config.languages;
  return [defaultLanguage, ...supported.filter((code) => code !== defaultLanguage)];
}

/** Every language a caller can be handed to from `language`. */
export function handoffTargets(config: ClientConfig, language: string): string[] {
  return config.languages.supported.filter((code) => code !== language);
}

export function assistantResourceName(clientId: string, language: string): string {
  return `${clientId}--${language}`;
}

/** Our bookkeeping key (state file) for a handoff tool; not sent to Vapi. */
export function handoffToolStateName(clientId: string, from: string, to: string): string {
  return `${clientId}--${from}--handoff-to-${to}`;
}

export function squadStateName(clientId: string): string {
  return `${clientId}--squad`;
}

export function renderHandoffTool(
  config: ClientConfig,
  from: string,
  to: string,
): VapiHandoffToolPayload {
  for (const code of [from, to]) {
    if (!config.languages.supported.includes(code)) {
      throw new UnsupportedLanguageError(config.clientId, code, config.languages.supported);
    }
  }
  const keywords = config.languages.settings[to]?.switchKeywords ?? [];
  const quoted = keywords.map((keyword) => `"${keyword}"`).join(', ');

  return {
    type: 'handoff',
    destinations: [
      {
        type: 'assistant',
        assistantName: assistantResourceName(config.clientId, to),
        description:
          `The caller asks to continue in the "${to}" language — for example by saying ${quoted} ` +
          'or by asking for that language.',
        contextEngineeringPlan: { type: 'all' },
        // Both fields are needed: the destination's own saved firstMessage/
        // endCallMessage are NOT used for a leg reached via handoff — Vapi
        // requires both threaded through the override (VAPI-FACTS.md VP-6 R3).
        assistantOverrides: {
          firstMessage: renderArrivalMessage(config, to),
          endCallMessage: goodbyeMessage(config, to),
        },
      },
    ],
    messages: [{ type: 'request-start', content: '' }],
  };
}

/**
 * @param assistantIds language code → synced assistant id; must cover every
 *                     supported language (sync.ts checks that first).
 */
export function renderSquad(
  config: ClientConfig,
  assistantIds: Readonly<Record<string, string>>,
): VapiSquadPayload {
  return {
    name: squadStateName(config.clientId),
    members: orderedLanguages(config).map((language) => {
      const assistantId = assistantIds[language];
      if (!assistantId) {
        throw new Error(`renderSquad: no assistant id for language "${language}"`);
      }
      return { assistantId };
    }),
  };
}

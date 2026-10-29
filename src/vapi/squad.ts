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
import { endCallPhrasesFor, silenceHooks } from './callEnding.js';
import type { ClientConfig, ScriptKey } from '../config/schema.js';
import type {
  VapiHandoffToolPayload,
  VapiReportingConfig,
  VapiServerConfig,
  VapiSquadPayload,
  VapiTalkSquad,
} from './types.js';

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

/**
 * What the assistant for `language` says first when a call starts directly with it: the full
 * greeting for the default language, its arrival message for any other (render.ts makes the same
 * choice for the saved `firstMessage`). `openingQuestion` swaps in another wording of the
 * "how can I help?" sentence; omitted, it is the first configured one — i.e. the saved text.
 */
export function renderOpeningMessage(
  config: ClientConfig,
  language: string,
  openingQuestion?: string,
): string {
  const key: ScriptKey =
    language === config.languages.default
      ? 'greeting'
      : (ARRIVAL_SCRIPT_KEYS[language] ?? 'greeting');
  return fillClinicPlaceholders(
    config,
    language,
    pick(config.scripts[key], language),
    openingQuestion === undefined ? {} : { openingQuestion },
  );
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

/**
 * Suffix marking the "reached only via handoff" squad member for the default
 * language — e.g. "ja-return" when `languages.default` is "ja". Not itself a
 * language code: `contentLanguageOf` maps it back to the default language for
 * every content lookup (voice, transcriber, system prompt, FAQ). Exists so
 * the default language can have two different opening lines — the full
 * greeting when it starts the call, a short "welcome back" line when another
 * language hands the caller back to it — without either one replaying the
 * other's script (VP-7 R1).
 */
const RETURN_MEMBER_SUFFIX = '-return';

/**
 * The id of the default language's "welcome back" squad member, or
 * `undefined` for a single-language client (nothing ever hands off back to
 * it). Never a call starter — only ever a handoff destination.
 */
export function returnMemberId(config: ClientConfig): string | undefined {
  return config.languages.supported.length > 1
    ? `${config.languages.default}${RETURN_MEMBER_SUFFIX}`
    : undefined;
}

/**
 * Every squad member id in call-start order: the default language first (it
 * starts the call), then the rest of `supported`, then the return member (if
 * any) last — it is never first and never a handoff target from itself.
 */
export function squadMemberIds(config: ClientConfig): string[] {
  const returning = returnMemberId(config);
  return returning === undefined
    ? orderedLanguages(config)
    : [...orderedLanguages(config), returning];
}

/**
 * The language a squad member id actually speaks and is rendered in:
 * identity for a plain language code, the default language for its
 * `-return` variant. Every content lookup (voice, transcriber, prompt, FAQ,
 * scripts) goes through this, never the raw member id.
 */
export function contentLanguageOf(config: ClientConfig, memberId: string): string {
  return memberId === returnMemberId(config) ? config.languages.default : memberId;
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
  silenceEndServer: VapiServerConfig,
  reporting?: VapiReportingConfig,
): VapiHandoffToolPayload {
  for (const code of [from, to]) {
    if (!config.languages.supported.includes(code)) {
      throw new UnsupportedLanguageError(config.clientId, code, config.languages.supported);
    }
  }
  const keywords = config.languages.settings[to]?.switchKeywords ?? [];
  const quoted = keywords.map((keyword) => `"${keyword}"`).join(', ');
  // A handoff that lands back on the default language always targets the
  // return member, never the call-starting one — its firstMessage is the
  // full opening greeting, which must never replay mid-call (VP-7 R1).
  const destinationId = to === config.languages.default ? (returnMemberId(config) ?? to) : to;
  const endCallPhrases = endCallPhrasesFor(config, to);

  return {
    type: 'handoff',
    destinations: [
      {
        type: 'assistant',
        assistantName: assistantResourceName(config.clientId, destinationId),
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
          // Same reasoning for the platform-level hang-up backstops (VAPI-FACTS.md VP-7 R8).
          ...(endCallPhrases ? { endCallPhrases } : {}),
          hooks: silenceHooks(config, to, silenceEndServer),
          // VP-12: a call that was handed off must still report and record (see callReporting.ts).
          ...(reporting ?? {}),
        },
      },
    ],
    messages: [{ type: 'request-start', content: '' }],
  };
}

/**
 * Whether starting a call in `language` should start the whole squad (the default language, which
 * can hand off to the others) rather than that language's assistant on its own. A client with
 * nothing to hand off to has no use for a squad.
 */
export function startsWithSquad(config: ClientConfig, language: string): boolean {
  return language === config.languages.default && squadMemberIds(config).length > 1;
}

export interface TalkSquadOverrides {
  maxDurationSeconds: number;
  variableValues: Readonly<Record<string, string>>;
  /** The starting member's greeting; absent = keep its saved greeting. */
  firstMessage?: string;
}

/**
 * The inline squad for a /talk web call (VP-22): the synced squad's members, plus this call's
 * values. `firstMessage` goes on `members[0]` only — on `membersOverrides` it would apply to every
 * member — and `variableValues` / `maxDurationSeconds` are call-wide on `membersOverrides`
 * (VAPI-FACTS.md, VP-22 spike).
 */
export function renderTalkSquad(
  config: ClientConfig,
  assistantIds: Readonly<Record<string, string>>,
  overrides: TalkSquadOverrides,
): VapiTalkSquad {
  const { name, members } = renderSquad(config, assistantIds);
  return {
    name,
    members: members.map((member, index) =>
      index === 0 && overrides.firstMessage !== undefined
        ? { ...member, assistantOverrides: { firstMessage: overrides.firstMessage } }
        : member,
    ),
    membersOverrides: {
      maxDurationSeconds: overrides.maxDurationSeconds,
      variableValues: overrides.variableValues,
    },
  };
}

/**
 * @param assistantIds member id → synced assistant id; must cover every
 *                     squad member (sync.ts checks that first).
 */
export function renderSquad(
  config: ClientConfig,
  assistantIds: Readonly<Record<string, string>>,
): VapiSquadPayload {
  return {
    name: squadStateName(config.clientId),
    members: squadMemberIds(config).map((memberId) => {
      const assistantId = assistantIds[memberId];
      if (!assistantId) {
        throw new Error(`renderSquad: no assistant id for member "${memberId}"`);
      }
      return { assistantId };
    }),
  };
}

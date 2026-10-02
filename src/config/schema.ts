/**
 * Zod schema for `clients/<clientId>/client.yaml`.
 *
 * Shape only. Rules that need to compare parts of the file against each other
 * (completeness per language, placeholders, duplicate FAQ ids) live in
 * `./rules.ts` and are applied by `parseClientConfig` below.
 */
import { z } from 'zod';

import { collectCrossFieldIssues, collectWarnings } from './rules.js';
import type { ConfigIssue } from './issues.js';
import { ClientConfigError } from './issues.js';

/** Lowercase slug: also the folder name under `clients/` and the Vapi name prefix. */
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** BCP-47-ish language tag, e.g. `ja`, `en`, `zh-Hant`, `pt-BR`. */
export const LANGUAGE_CODE_PATTERN = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

/** E.164: `+` then 7–15 digits, first digit non-zero. */
export const E164_PATTERN = /^\+[1-9]\d{6,14}$/;

const TIME_OF_DAY_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

const slug = z.string().regex(SLUG_PATTERN, 'must be a lowercase slug, e.g. "example-clinic"');
const languageCode = z
  .string()
  .regex(LANGUAGE_CODE_PATTERN, 'must be a BCP-47 language code, e.g. "ja" or "pt-BR"');
const nonEmpty = z.string().min(1, 'must not be empty');

/**
 * Text in every supported language: `{ ja: "…", en: "…" }`.
 * Which languages must be present is checked in ./rules.ts, because it depends
 * on `languages.supported`.
 */
export const localizedTextSchema = z.record(languageCode, nonEmpty);
export type LocalizedText = z.infer<typeof localizedTextSchema>;

const dayHoursSchema = z.union([
  z.strictObject({
    open: z.string().regex(TIME_OF_DAY_PATTERN, 'must be HH:MM in 24-hour form, e.g. "09:00"'),
    close: z.string().regex(TIME_OF_DAY_PATTERN, 'must be HH:MM in 24-hour form, e.g. "19:00"'),
  }),
  z.literal('closed'),
]);

const weeklyHoursSchema = z.strictObject({
  mon: dayHoursSchema,
  tue: dayHoursSchema,
  wed: dayHoursSchema,
  thu: dayHoursSchema,
  fri: dayHoursSchema,
  sat: dayHoursSchema,
  sun: dayHoursSchema,
});

const businessSchema = z.strictObject({
  type: nonEmpty,
  name: localizedTextSchema,
  // Optional, per-language phonetic respelling of `name`, used only to fill
  // [[clinicName]] when speaking (VP-6 D): the canonical `name` stays
  // correctly spelled for any future written/display use. Only set it for a
  // language whose TTS voice actually mispronounces the plain name —
  // partial is fine, unlike `name` itself. No Azure pronunciation-dictionary/
  // SSML-style hint exists in Vapi (re-verified 2026-09-23 against the live
  // OpenAPI spec, the SDK's `AzureVoice` type, and docs.vapi.ai — see
  // docs/VAPI-FACTS.md VP-6 R6), so this is the documented fallback.
  namePronunciation: localizedTextSchema.optional(),
  // `postalCode` plus one entry per supported language.
  address: z.object({ postalCode: nonEmpty }).catchall(nonEmpty),
  phone: z.strictObject({
    display: nonEmpty,
    e164: z.string().regex(E164_PATTERN, 'must be E.164, e.g. "+819012345678"'),
  }),
  website: z.url({ protocol: /^https?$/, error: 'must be a full http(s) URL' }),
  hours: z.strictObject({
    timezone: nonEmpty,
    weekly: weeklyHoursSchema,
    closedOnNationalHolidays: z.boolean(),
  }),
});

const languageSettingsSchema = z.strictObject({
  voice: z.strictObject({ provider: nonEmpty, voiceId: nonEmpty }),
  /**
   * `model` is optional — Cartesia's Ink Whisper needs `model: "ink-whisper"` alongside
   * provider/language (VAPI-FACTS.md Vendor-swap R2); a future provider without a model concept
   * can omit it. `language` (e.g. "ja") is also optional — required for every provider used so far
   * EXCEPT Deepgram Flux (`flux-general-en`/`flux-general-multi`), which auto-detects the spoken
   * language and must NOT be pinned to one (VAPI-FACTS.md Vendor-swap R6).
   * `null` means "not chosen yet" — see docs/VAPI-FACTS.md for what's still open.
   */
  transcriber: z
    .strictObject({
      provider: nonEmpty,
      model: nonEmpty.optional(),
      language: nonEmpty.optional(),
      /**
       * Deepgram `flux-general-multi` only: BCP-47 language hints (Vapi's live OpenAPI
       * `DeepgramTranscriber.languages`). A real call showed auto-detection drifting across
       * unrelated languages for a single Japanese speaker when this was omitted — VAPI-FACTS.md
       * Vendor-swap R8.
       */
      languages: z.array(nonEmpty).min(1).optional(),
    })
    .nullable(),
  switchKeywords: z.array(nonEmpty).min(1, 'needs at least one keyword'),
  /**
   * Phrases that make Vapi hang up when the ASSISTANT says one (VAPI-FACTS.md VP-7 R8) — a
   * platform-level backstop for when the model speaks a farewell instead of calling `endCall`.
   * Case-insensitive substring match, 2–140 characters each. Choose specific closing phrases:
   * anything the assistant might say mid-call would hang up on the caller.
   */
  endCallPhrases: z.array(z.string().min(2).max(140)).min(1).optional(),
  /**
   * Things a caller typically says when they are finished (VP-7 follow-up). Shown to the model as
   * examples of when to end the call silently — a concrete anchor, since "the caller is done" was
   * not recognised reliably from the description alone.
   */
  callerDoneExamples: z.array(nonEmpty).min(1).optional(),
  /**
   * Words a caller uses to describe pain that might be an emergency (VP-7 follow-up). The
   * "possibly serious" 119 line is only used when the caller's own words include one — without a
   * concrete trigger list the model said it for any mention of pain ("my back hurts").
   */
  severePainWords: z.array(nonEmpty).min(1).optional(),
  /**
   * How to speak a phone number aloud in this language (VP-7): the ten digit words, indexed by
   * digit (0–9), plus one worked example for the prompt. The example is for 090-1234-5678 and is
   * only ever shown to the model as a pattern to follow.
   */
  phoneReadback: z
    .strictObject({ digitWords: z.array(nonEmpty).length(10), example: nonEmpty })
    .optional(),
});

const languagesSchema = z.strictObject({
  default: languageCode,
  supported: z.array(languageCode).min(1, 'needs at least one language'),
  settings: z.record(languageCode, languageSettingsSchema),
});

const callbackSchema = z.strictObject({
  enabled: z.boolean(),
  collect: z.array(z.enum(['name', 'phone'])).min(1),
  offerWhen: z.array(z.enum(['no_faq_match', 'caller_asks_for_staff'])).min(1),
  /** Notification channels. Empty = database only — see FUTURE-FEATURES F-2. */
  notifiers: z.array(nonEmpty),
});

const safetySchema = z.strictObject({
  emergencyNumber: nonEmpty,
  noMedicalAdvice: z.boolean(),
});

const scriptsSchema = z.strictObject({
  greeting: localizedTextSchema,
  englishGreeting: localizedTextSchema,
  /** Spoken (in `ja`) when a caller is handed back to the Japanese assistant — VP-3. */
  handoffToJapanese: localizedTextSchema,
  anythingElse: localizedTextSchema,
  noMatch: localizedTextSchema,
  staffContactOffer: localizedTextSchema,
  askPhone: localizedTextSchema,
  confirmDetails: localizedTextSchema,
  /**
   * Phone-only read-back confirmation, used where no name is collected
   * (the reservation flow) — same digit-by-digit pattern as `confirmDetails`,
   * minus the name.
   */
  confirmPhone: localizedTextSchema,
  callbackSaved: localizedTextSchema,
  callbackFailed: localizedTextSchema,
  /**
   * Formal wait-filler, spoken by the platform (not the model) as the
   * `request-start` message on a synchronous tool call that has real
   * latency — `request_callback`, `check_availability`, `lookup_patient`,
   * `book_appointment` (`render.ts`). Wording must match the formal phrase
   * locked into `promptTemplate.ts`'s `styleSection` ("One moment, please." /
   * 「少々お待ちくださいませ。」) — the two are the same anti-"chotto matte" fix,
   * one for the model's own improvised wait lines, one for the platform's
   * default tool filler.
   */
  pleaseWait: localizedTextSchema,
  didNotCatch: localizedTextSchema,
  /**
   * Asks for a phone number again — after a wrong digit count or a "no" to the read-back (VP-7).
   * Deliberately separate from `didNotCatch`: it must not count toward the "three failed attempts
   * to understand the caller" hang-up.
   */
  phoneRetry: localizedTextSchema,
  /** Spoken after three failed attempts in a row to understand the caller — ends the call. */
  repeatedMisunderstanding: localizedTextSchema,
  noMedicalAdvice: localizedTextSchema,
  /** Clear red-flag emergency (VP-7): said immediately, no conditional wording. */
  emergency: localizedTextSchema,
  /** Uncertain/possibly-serious pain (VP-7 two-tier emergency handling): conditional wording. */
  emergencyUncertain: localizedTextSchema,
  /**
   * Short goodbye the MODEL says itself right after the emergency path, before calling endCall
   * (VP-7 R3 — no platform mechanism makes `endCallMessage` conditional; this is the accepted
   * fallback, so the normal endCallMessage still plays right after this one — see VAPI-FACTS.md).
   */
  emergencyGoodbye: localizedTextSchema,
  goodbye: localizedTextSchema,
  // --- VP-8 demo reservation flow ---
  /** Asks whether the caller is a first-time or returning patient. */
  reservationAskType: localizedTextSchema,
  /** Intro before offering the services listed in the prompt's "Reservation services" grounding. */
  reservationAskService: localizedTextSchema,
  /** Asks for a preferred date/time — used on both the first-visit and returning-patient paths. */
  reservationAskDateTime: localizedTextSchema,
  /** Asks a returning patient for name and phone number, for the lookup_patient tool. */
  reservationReturningAsk: localizedTextSchema,
  /** Said when lookup_patient finds no record — falls back to the first-time-visitor path. */
  reservationPatientNotFound: localizedTextSchema,
  /** May use [[reservationNumber]] — the only other script (besides confirmDetails) allowed a caller placeholder. */
  reservationSaved: localizedTextSchema,
  /** Said when book_appointment fails (e.g. the slot was taken in the meantime). */
  reservationFailed: localizedTextSchema,
});

/** Every script key, in file order. Derived from the schema so it cannot drift. */
export const SCRIPT_KEYS = Object.keys(scriptsSchema.shape) as ScriptKey[];
export type ScriptKey = keyof z.infer<typeof scriptsSchema>;

const faqEntrySchema = z.strictObject({
  id: slug,
  tags: z.array(nonEmpty),
  question: localizedTextSchema,
  answer: localizedTextSchema,
});

/**
 * Unknown TOP-LEVEL keys are allowed (reported as warnings) so that sections
 * such as `telephony` can be added later — see FUTURE-FEATURES F-4.
 * Unknown keys inside a known section are errors, to catch typos.
 */
export const clientConfigSchema = z.looseObject({
  clientId: slug,
  status: z.enum(['demo', 'live']),
  business: businessSchema,
  languages: languagesSchema,
  callback: callbackSchema,
  safety: safetySchema,
  scripts: scriptsSchema,
  faq: z.array(faqEntrySchema).min(1, 'needs at least one FAQ entry'),
});

export type ClientConfig = z.infer<typeof clientConfigSchema>;

/** Top-level keys the schema knows about. Anything else is warned about. */
export const KNOWN_TOP_LEVEL_KEYS = Object.keys(clientConfigSchema.shape);

export interface ParsedClientConfig {
  config: ClientConfig;
  warnings: ConfigIssue[];
}

/**
 * Validates a parsed YAML document.
 *
 * @param raw            the value returned by the YAML parser
 * @param expectedClientId the folder name the file was loaded from; `clientId`
 *                       inside the file must match it
 * @throws ClientConfigError listing every problem found, each with its path
 */
export function parseClientConfig(raw: unknown, expectedClientId: string): ParsedClientConfig {
  const result = clientConfigSchema.safeParse(raw);

  if (!result.success) {
    throw new ClientConfigError(expectedClientId, toConfigIssues(result.error));
  }

  const crossFieldIssues = collectCrossFieldIssues(result.data, expectedClientId);
  if (crossFieldIssues.length > 0) {
    throw new ClientConfigError(expectedClientId, crossFieldIssues);
  }

  return { config: result.data, warnings: collectWarnings(result.data) };
}

/** Turns zod issues into `{ path, message }` pairs with dotted/indexed paths. */
function toConfigIssues(error: z.ZodError): ConfigIssue[] {
  return error.issues.flatMap((issue): ConfigIssue[] => {
    const base = formatPath(issue.path);
    if (issue.code === 'unrecognized_keys') {
      return issue.keys.map((key) => ({
        path: base ? `${base}.${key}` : key,
        message: 'unknown key — check the spelling (unknown keys are only allowed at top level)',
      }));
    }
    return [{ path: base || '(root)', message: issue.message }];
  });
}

export function formatPath(path: ReadonlyArray<PropertyKey>): string {
  return path.reduce<string>((acc, segment) => {
    if (typeof segment === 'number') return `${acc}[${segment}]`;
    return acc ? `${acc}.${String(segment)}` : String(segment);
  }, '');
}

export { ClientConfigError };
export type { ConfigIssue };

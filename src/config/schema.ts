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
   * Adds the "don't repeat an acknowledgement after a split utterance" rule to this language's
   * prompt (VP-10). Off unless set, so a language only gets it once it has been tested there —
   * a re-sync of any other language can never pick it up by accident.
   */
  avoidRepeatedAcknowledgement: z.boolean().optional(),
  /**
   * Alternative wordings of the opening "how can I help you today?" sentence. A greeting script
   * (`greeting`, `englishGreeting`, `returningGreeting`) puts it where `[[openingQuestion]]`
   * appears. Saved assistants always speak the FIRST entry (so a `vapi:sync` never changes with
   * the list's length); the /talk page picks one at random per call. Keep the meaning identical —
   * only the wording varies. The recording / AI disclosures stay in the script, never in here.
   */
  openingQuestions: z.array(nonEmpty).min(1).optional(),
  /**
   * Extra wordings for the platform-spoken wait filler (`scripts.pleaseWait` is always one of
   * them). Rendered as several `request-start` messages; Vapi speaks one of them at random on
   * each tool call. They play before request_callback / check_availability / lookup_patient /
   * book_appointment alike, so keep them neutral — nothing that claims to be "checking".
   */
  pleaseWaitVariants: z.array(nonEmpty).min(1).optional(),
});

const languagesSchema = z.strictObject({
  default: languageCode,
  supported: z.array(languageCode).min(1, 'needs at least one language'),
  settings: z.record(languageCode, languageSettingsSchema),
});

const callbackSchema = z.strictObject({
  enabled: z.boolean(),
  collect: z.array(z.enum(['name'])).min(1),
  offerWhen: z.array(z.enum(['no_faq_match', 'caller_asks_for_staff'])).min(1),
  /** Notification channels. Empty = database only — see FUTURE-FEATURES F-2. */
  notifiers: z.array(nonEmpty),
});

const safetySchema = z.strictObject({
  noMedicalAdvice: z.boolean(),
});

/**
 * Optional wording overrides for the shared prompt template (VP-19). The template's defaults read
 * like a clinic receptionist; a client in another line of business replaces just the pieces that
 * don't fit, here, instead of the template growing a branch per business type. Every field is
 * English meta-instruction to the model — never text spoken to a caller — and an absent field
 * keeps today's default, so a client without this section renders exactly as before.
 */
const promptOverridesSchema = z.strictObject({
  /** The word for the business in the prompt's own prose ("clinic"). Default "clinic". */
  businessNoun: nonEmpty.optional(),
  /** Replaces the whole Identity paragraph. */
  identity: nonEmpty.optional(),
  /** Replaces the "caller mentions pain or a difficult situation" style bullet. */
  sympathy: nonEmpty.optional(),
  /** Replaces the off-topic bullet in "Leading the call". */
  offTopic: nonEmpty.optional(),
  /** Replaces the "visiting or booking" bullet in "Answering questions". */
  visitingOrBooking: nonEmpty.optional(),
  /** Who reads the call summary, for the call-outcome extraction ("clinic staff"). */
  staffLabel: nonEmpty.optional(),
  /**
   * VP-21. Stock call-centre phrases per language (acknowledging, confirming, checking, apologising),
   * as one block of example wording for the model — a bank to draw on and vary, not scripts to recite.
   */
  phraseBank: localizedTextSchema.optional(),
  /**
   * VP-21. Wording patterns for requests that already end in a staff callback (someone else's
   * account, guarantees, repair ETAs, "send someone now"), per language. No new behaviour.
   */
  refusalPatterns: localizedTextSchema.optional(),
  /** VP-21. Explicit "never claim / never guess / never disclose" rules (English meta-instruction). */
  guardrails: nonEmpty.optional(),
});

/**
 * Which booking conversation the assistant runs, when the client has bookable services.
 * `patient-types` (the default, and the only mode before VP-19) asks first-time vs returning and
 * looks the caller up. `simple` skips that: service → date/time → availability → name → book.
 */
const reservationFlowSchema = z.strictObject({
  mode: z.enum(['patient-types', 'simple']),
  /**
   * `simple` mode only. When set, the assistant asks for this (e.g. the service address) after the
   * time is confirmed. It is not a tool argument and has no column: it is captured only in the
   * call summary the staff dashboard shows beside the reservation (VP-19 decision).
   */
  askServiceAddress: localizedTextSchema.optional(),
  /**
   * `simple` mode with `askServiceAddress` only (VP-20). Replaces the one free-text address
   * question with: postal code → `lookup_postal_code` → confirm the area → building and room.
   * `askServiceAddress` stays as the fallback when the lookup fails. Still no tool argument and
   * no column: the combined address reaches staff through the call summary.
   */
  postalCodeLookup: z
    .strictObject({
      /** Asks for the 7-digit postal code. */
      askPostalCode: localizedTextSchema,
      /** Reads the looked-up area back; the model fills [[postalCode]] and [[area]]. */
      confirmArea: localizedTextSchema,
      /** Asks only for the building name and room / unit number. */
      askBuildingAndRoom: localizedTextSchema,
      /** Said when the lookup fails, right before `askServiceAddress` is asked instead. */
      lookupFailed: localizedTextSchema,
    })
    .optional(),
});

/**
 * A safety-critical report (e.g. a gas smell) that overrides every other flow. Prompt-script only
 * (VP-19 decision 3): the assistant says the fixed wording, records a flagged callback, and ends.
 * There is no paging or escalation behind it, and the assistant is told never to imply there is.
 */
const emergencySchema = z.strictObject({
  /** English description for the model, e.g. "a gas smell or a suspected gas leak". */
  label: nonEmpty,
  /** Example phrases a caller might use, in any language — anchors for the model, not a regex. */
  triggers: z.array(nonEmpty).min(1, 'needs at least one trigger phrase'),
  /** The fixed wording the assistant says, word for word, in each supported language. */
  script: localizedTextSchema,
  /** The exact `reason` passed to request_callback — and the flag staff see on the dashboard. */
  callbackReason: nonEmpty,
});

const scriptsSchema = z.strictObject({
  greeting: localizedTextSchema,
  englishGreeting: localizedTextSchema,
  /**
   * Opening line for a caller whose phone number has called before (VP-15), sent per call as a
   * `firstMessage` override by the /talk page. Spoken in the assistant's own language. A plain
   * welcome-back only: it must never mention the earlier call's topic or details.
   */
  returningGreeting: localizedTextSchema,
  /** Spoken (in `ja`) when a caller is handed back to the Japanese assistant — VP-3. */
  handoffToJapanese: localizedTextSchema,
  anythingElse: localizedTextSchema,
  noMatch: localizedTextSchema,
  staffContactOffer: localizedTextSchema,
  /** Asks for the caller's name (first or short name) — used by the reservation flow. */
  askName: localizedTextSchema,
  /** Reads the name back for a yes/no; the model substitutes the name for [[callerName]]. */
  confirmName: localizedTextSchema,
  /**
   * Asks whether staff may contact the caller on the number they are calling from. No number is
   * ever collected by voice (TODO(SV-5): real caller-ID; see src/lib/demoCallerPhone.ts).
   */
  askContactNumber: localizedTextSchema,
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
  /** Spoken after three failed attempts in a row to understand the caller — ends the call. */
  repeatedMisunderstanding: localizedTextSchema,
  noMedicalAdvice: localizedTextSchema,
  goodbye: localizedTextSchema,
  // --- VP-16 graduated caller-silence handling ---
  /** First "are you there?" check after the repeated question gets no answer. */
  silenceCheck1: localizedTextSchema,
  /** Second check, when the caller is still silent. */
  silenceCheck2: localizedTextSchema,
  /** Spoken just before the platform hangs up on a caller who never answered. */
  silenceEnding: localizedTextSchema,
  // --- VP-8 demo reservation flow ---
  /** Asks whether the caller is a first-time or returning patient. */
  reservationAskType: localizedTextSchema,
  /** Intro before offering the services listed in the prompt's "Reservation services" grounding. */
  reservationAskService: localizedTextSchema,
  /** Asks for a preferred date/time — used on both the first-visit and returning-patient paths. */
  reservationAskDateTime: localizedTextSchema,
  /** Said when lookup_patient finds no record — falls back to the first-time-visitor path. */
  reservationPatientNotFound: localizedTextSchema,
  /** Closing line after a successful booking; the prompt has the agent state the date/time just before it. */
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
  // VP-19: all optional — a client that omits them renders exactly as it did before they existed.
  promptOverrides: promptOverridesSchema.optional(),
  reservationFlow: reservationFlowSchema.optional(),
  emergency: emergencySchema.optional(),
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

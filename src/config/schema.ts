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
   * VP-2 (VAPI-FACTS.md R1): chose Azure for every configured language, so
   * `language` (e.g. "ja-JP") is required alongside `provider`. `null` means
   * "not chosen yet" — see docs/VAPI-FACTS.md for what's still open.
   */
  transcriber: z.strictObject({ provider: nonEmpty, language: nonEmpty }).nullable(),
  switchKeywords: z.array(nonEmpty).min(1, 'needs at least one keyword'),
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
  callbackSaved: localizedTextSchema,
  callbackFailed: localizedTextSchema,
  didNotCatch: localizedTextSchema,
  noMedicalAdvice: localizedTextSchema,
  emergency: localizedTextSchema,
  goodbye: localizedTextSchema,
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

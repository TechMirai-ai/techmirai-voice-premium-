/**
 * Helpers shared by `promptTemplate.ts` and `promptExtraSections.ts`: placeholder filling, script
 * lookup, and the name / contact-number / confirmation instructions that the callback flow, both
 * reservation flows and the emergency path all reuse. Lives apart from the template so the
 * template and the extra sections can both import it without importing each other.
 */
import { CLINIC_PLACEHOLDERS, OPENING_PLACEHOLDER } from '../config/rules.js';
import type { ClientConfig, ScriptKey } from '../config/schema.js';
import { BOOK_APPOINTMENT_FUNCTION_NAME, CHECK_AVAILABILITY_FUNCTION_NAME } from './toolNames.js';

const PLACEHOLDER_PATTERN = /\[\[([^\][]*)\]\]/g;

const DAY_ORDER = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
const DAY_LABELS: Record<(typeof DAY_ORDER)[number], string> = {
  mon: 'Mon',
  tue: 'Tue',
  wed: 'Wed',
  thu: 'Thu',
  fri: 'Fri',
  sat: 'Sat',
  sun: 'Sun',
};

/** `Mon 09:00-19:00, …, Sun closed` — the one place opening hours are spelled out for the model. */
export function formatWeeklyHours(weekly: ClientConfig['business']['hours']['weekly']): string {
  return DAY_ORDER.map((day) => {
    const hours = weekly[day];
    return hours === 'closed'
      ? `${DAY_LABELS[day]} closed`
      : `${DAY_LABELS[day]} ${hours.open}-${hours.close}`;
  }).join(', ');
}

/** Picks one language's text out of a `{ ja: "...", en: "..." }`-shaped block. */
export function pick(source: Record<string, string>, language: string): string {
  return source[language] ?? '';
}

/**
 * The word for the business in the prompt's own prose. "clinic" unless the client overrides it
 * (`promptOverrides.businessNoun`, VP-19) — the default is what keeps sakura's prompt unchanged.
 */
export function businessNoun(config: ClientConfig): string {
  return config.promptOverrides?.businessNoun ?? 'clinic';
}

/** `businessNoun` with a capital first letter, for section headings ("Clinic information"). */
export function businessNounTitle(config: ClientConfig): string {
  const noun = businessNoun(config);
  return `${noun.charAt(0).toUpperCase()}${noun.slice(1)}`;
}

/**
 * The clinic name as it should be SPOKEN in `language`: the phonetic
 * `business.namePronunciation` override when the config sets one for that
 * language (VP-6 D), else the plain `business.name`. Anything the model
 * might say aloud — the `[[clinicName]]` placeholder and the prompt's own
 * "Identity" line — must go through this, not `business.name` directly.
 */
export function spokenClinicName(config: ClientConfig, language: string): string {
  return (
    pick(config.business.namePronunciation ?? {}, language) || pick(config.business.name, language)
  );
}

/**
 * Fills `[[clinicName]]`-style clinic placeholders from `config`. Anything
 * else — including `[[callerName]]` / `[[reservationNumber]]` — is left untouched:
 * those are only known once the model has talked to the caller, and it is
 * told (see the "Tone" section) to substitute them itself before speaking.
 *
 * Exported so render.ts can apply the same substitution to `firstMessage`
 * and the tool's canned failure message — anywhere client.yaml text reaches
 * a payload Vapi will actually speak, not just inside the system prompt.
 */
export function fillClinicPlaceholders(
  config: ClientConfig,
  language: string,
  text: string,
  options: { openingQuestion?: string } = {},
): string {
  const values = new Map<string, string>([
    ['clinicName', spokenClinicName(config, language)],
    ['clinicPhone', config.business.phone.display],
    ['clinicAddress', pick(config.business.address, language)],
  ]);

  // `[[openingQuestion]]` is the FIRST configured wording unless the caller picked another one
  // (the /talk page does, per call). Absent list = left untouched; rules.ts rejects that config.
  const openingQuestion =
    options.openingQuestion ?? config.languages.settings[language]?.openingQuestions?.[0];
  if (openingQuestion !== undefined) values.set(OPENING_PLACEHOLDER, openingQuestion);

  // CLINIC_PLACEHOLDERS is the schema's source of truth for this set; assert
  // against it so a placeholder added there can't silently go unfilled here.
  for (const key of CLINIC_PLACEHOLDERS) {
    if (!values.has(key)) throw new Error(`promptTemplate has no value for [[${key}]]`);
  }

  return text.replace(PLACEHOLDER_PATTERN, (match, rawName: string) => {
    const value = values.get(rawName.trim());
    return value ?? match;
  });
}

/** `config.scripts[key]` for `language`, clinic placeholders filled. */
export function scriptLine(config: ClientConfig, language: string, key: ScriptKey): string {
  return fillClinicPlaceholders(config, language, pick(config.scripts[key], language));
}

/**
 * Name capture shared by the callback and reservation flows: ask for a short name, read it back,
 * wait for a clear yes, then ask whether staff may use the number the caller is calling from.
 * No phone number is ever collected by voice — in the demo the server fills in a placeholder
 * (src/lib/demoCallerPhone.ts; TODO(SV-5): real caller-ID).
 */
export function nameConfirmationInstructions(config: ClientConfig, language: string): string {
  return (
    'Read the name back, as its own turn, then stop and wait: ' +
    `"${scriptLine(config, language, 'confirmName')}" — substituting the name for ` +
    '[[callerName]], never speaking the placeholder text itself.\n' +
    '   - A first name or short name is enough — never ask for a full formal name. In Japanese, ' +
    "use katakana so it's pronounced exactly as heard, and never ask how it's written in kanji. " +
    "In English, ask them to spell it only if it's unusual or unclear.\n" +
    '   - If the caller says no or corrects the name, fix it, read it back again, and ask again.'
  );
}

/** The question asked after the name is confirmed — answered yes before any tool call is made. */
export function contactNumberInstructions(config: ClientConfig, language: string): string {
  return (
    `Then ask, as its own turn: "${scriptLine(config, language, 'askContactNumber')}" ` +
    'Never ask for, repeat or read out a phone number — you do not collect one; the number the ' +
    'caller is calling from is used automatically. If they say no or ask to be contacted ' +
    'another way, say that staff will use the number they are calling from and ask again once; ' +
    'if they still refuse, do not make the tool call.'
  );
}

/** What to do after `book_appointment` returns — shared by every booking flow, so they can't drift. */
export function reservationClosingInstructions(config: ClientConfig, language: string): string {
  const check = CHECK_AVAILABILITY_FUNCTION_NAME;
  return [
    `After the ${BOOK_APPOINTMENT_FUNCTION_NAME} call: if it succeeded, in the same turn first ` +
      'state the confirmed appointment date and time back to the caller, then say ' +
      `"${scriptLine(config, language, 'reservationSaved')}". Never say the reservation number ` +
      `the tool returns. Then ask:"${scriptLine(config, language, 'anythingElse')}" — same as after answering a ` +
      'question.',
    // Test batch 2026-11-09 (X02): with only a generic "if it failed" line, the model invented
    // alternative times instead of asking the system, in 10 of 10 runs.
    `If it failed because the time is no longer available (the result says so), do not say the ` +
      'booking failed and do not name or suggest any time yourself: ' +
      `call ${check} again right away, in this same turn, with the same date and time (it returns ` +
      'the times that are really open). Then offer only what it returns. If it lists alternative ' +
      `times, offer only those, and treat the caller's pick like any other: call ${check} again ` +
      'for that specific choice before booking. If it says no time is open or that the ' +
      'business is closed that day, ask for a different date. If it says the original time is ' +
      `available, book it. Never name or suggest a time that ${check} has not returned in this call.`,
    `If it failed for any other reason, say something in the spirit of "${scriptLine(config, language, 'reservationFailed')}" instead.`,
  ].join(' ');
}

/**
 * The client's "shall I connect you to staff now?" line, or `undefined` when live transfer is not
 * enabled. Shared so the callback steps can carry the offer themselves instead of leaving it to the
 * "Staff transfer" section further down (see `callbackSection`).
 */
export function transferOfferLine(config: ClientConfig, language: string): string | undefined {
  const transfer = config.transfer;
  if (!transfer?.enabled) return undefined;
  return fillClinicPlaceholders(config, language, pick(transfer.scripts.offer, language));
}

/**
 * Distinguishes a mid-sentence listening noise from a real "yes" — paired with the name
 * confirmation and contact-number question, which must each be answered before a tool is used.
 */
export const CONFIRMATION_ACK_INSTRUCTIONS =
  'Short acknowledgement sounds the caller makes WHILE you are still speaking (a quick ' +
  '"mm-hm" or "yeah", or the Japanese equivalent such as 「はい」/「うん」 said mid-sentence) ' +
  "are not a yes — they're just the caller listening. Only an explicit affirmative answer " +
  'given AFTER you finish asking counts as confirmation. A "no," a correction, silence, or ' +
  'anything unclear is not a yes either — fix the detail and ask again. ' +
  'Each question and the tool call that depends on it are always separate turns: when you ' +
  'ask a confirmation question, that turn contains ONLY the question — no tool call. Stop ' +
  "and wait. Call the tool in a later turn, only once the caller's own reply to that exact " +
  'question has appeared in the conversation. Never produce the tool call in the same turn as ' +
  'the question itself, even when you expect the answer to be yes — the caller has not actually ' +
  'answered yet at that point.';

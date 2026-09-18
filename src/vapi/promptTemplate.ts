/**
 * Builds the system prompt for one client's assistant, in one language.
 *
 * The wrapping prose (identity, rules, safety) is meta-instruction to the
 * model and is always written in English, because the LLMs Vapi supports
 * follow English instructions reliably while speaking any output language.
 * The actual phrases the assistant may say come from `config.scripts` and
 * `faq`, already localized to `language` by the caller. That keeps this
 * function itself entirely language-agnostic: the same code path runs for
 * every entry in `languages.supported`, never branching on a specific code.
 */
import { CLINIC_PLACEHOLDERS } from '../config/rules.js';
import type { ClientConfig } from '../config/schema.js';
import type { FaqEntry } from '../knowledge/KnowledgeSource.js';

export class UnsupportedLanguageError extends Error {
  constructor(clientId: string, language: string, supported: readonly string[]) {
    super(
      `"${language}" is not a supported language for "${clientId}" (supported: ${supported.join(', ')})`,
    );
    this.name = 'UnsupportedLanguageError';
  }
}

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

/** Picks one language's text out of a `{ ja: "...", en: "..." }`-shaped block. */
export function pick(source: Record<string, string>, language: string): string {
  return source[language] ?? '';
}

/**
 * Fills `[[clinicName]]`-style clinic placeholders from `config`. Anything
 * else — including `[[callerName]]` / `[[callerPhone]]` — is left untouched:
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
): string {
  const values = new Map<string, string>([
    ['clinicName', pick(config.business.name, language)],
    ['clinicPhone', config.business.phone.display],
    ['clinicAddress', pick(config.business.address, language)],
    ['emergencyNumber', config.safety.emergencyNumber],
  ]);

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

function formatWeeklyHours(weekly: ClientConfig['business']['hours']['weekly']): string {
  return DAY_ORDER.map((day) => {
    const hours = weekly[day];
    return hours === 'closed'
      ? `${DAY_LABELS[day]} closed`
      : `${DAY_LABELS[day]} ${hours.open}-${hours.close}`;
  }).join(', ');
}

function formatFaqEntry(config: ClientConfig, language: string, entry: FaqEntry): string {
  return [
    `- Q: ${fillClinicPlaceholders(config, language, pick(entry.question, language))}`,
    `  A: ${fillClinicPlaceholders(config, language, pick(entry.answer, language))}`,
    `  (tags: ${entry.tags.join(', ')})`,
  ].join('\n');
}

export function buildSystemPrompt(config: ClientConfig, language: string, faq: FaqEntry[]): string {
  if (!config.languages.supported.includes(language)) {
    throw new UnsupportedLanguageError(config.clientId, language, config.languages.supported);
  }

  const s = config.scripts;
  const scriptLine = (key: keyof ClientConfig['scripts']): string =>
    fillClinicPlaceholders(config, language, pick(s[key], language));

  const clinicName = pick(config.business.name, language);
  const clinicAddress = pick(config.business.address, language);
  const hours = config.business.hours;

  const sections = [
    // 1. Identity
    `You are the AI phone receptionist for ${clinicName}. You speak with callers over ` +
      'the phone and help them with information about the clinic, or take a message for ' +
      'staff to call them back.',

    // 2. Business facts (grounding only — do not recite unless asked)
    [
      'Business facts (for your own grounding — do not recite this list unless the caller asks):',
      `- Address: ${clinicAddress}`,
      `- Phone: ${config.business.phone.display}`,
      `- Timezone: ${hours.timezone}`,
      `- Hours: ${formatWeeklyHours(hours.weekly)}`,
      `- Closed on national holidays: ${hours.closedOnNationalHolidays ? 'yes' : 'no'}`,
    ].join('\n'),

    // 3. FAQ
    [
      "Frequently asked questions. Match the caller's wording flexibly — callers rarely " +
        'phrase things exactly like the question text below, so match by meaning and by the ' +
        'listed tags, not by exact wording.',
      ...faq.map((entry) => formatFaqEntry(config, language, entry)),
    ].join('\n'),

    // 4. Conversation rules
    [
      'Conversation rules:',
      `- After answering a question, ask: "${scriptLine('anythingElse')}"`,
      `- If nothing above matches what the caller is asking, say: "${scriptLine('noMatch')}". ` +
        `If the caller explicitly asks for staff instead, say: "${scriptLine('staffContactOffer')}" ` +
        'instead. Either way, continue by asking: ' +
        `"${scriptLine('askPhone')}", then confirm with: "${scriptLine('confirmDetails')}" before ` +
        'calling the request_callback tool.',
      `- After the tool call: if it succeeded, say something in the spirit of "${scriptLine('callbackSaved')}"; ` +
        `if it failed, say something in the spirit of "${scriptLine('callbackFailed')}". In both cases, ` +
        "substitute the caller's actual name and phone number for [[callerName]] and [[callerPhone]] " +
        '— never speak the placeholder text itself.',
      `- When the caller is done, say: "${scriptLine('goodbye')}"`,
    ].join('\n'),

    // 5. Safety
    [
      'Safety rules:',
      ...(config.safety.noMedicalAdvice
        ? [`- Never give medical advice. If asked, say: "${scriptLine('noMedicalAdvice')}"`]
        : []),
      '- If anything sounds like a medical emergency (serious injury, severe pain, difficulty ' +
        `breathing, etc.), immediately say: "${scriptLine('emergency')}" instead of continuing the ` +
        'normal flow.',
    ].join('\n'),

    // 6. Didn't-catch handling
    `If you don't clearly understand what the caller said, don't guess at it — say: "${scriptLine('didNotCatch')}"`,

    // 7. Temporary language deflection.
    // TODO(VP-3): remove once the Squad handoff exists. Written generically
    // (no language named) so this stays true for every language in
    // languages.supported, not just the one VP-2 happens to run for.
    'If the caller asks to continue in a different language than the one you are ' +
      'currently speaking, apologize that other languages are not available in this test ' +
      'version yet, and continue in the current language.',

    // 8. Tone
    'Tone: speak naturally, the way a real receptionist would on the phone — this is a ' +
      'phone call, not a chat window, so keep responses concise. Never read a placeholder ' +
      'token (anything inside [[ ]]) aloud; always substitute the real value first.',
  ];

  return sections.join('\n\n');
}

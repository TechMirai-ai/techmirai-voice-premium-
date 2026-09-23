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
import { allowedTopics } from '../lib/callTopics.js';
import type { FaqEntry } from '../knowledge/KnowledgeSource.js';
import {
  END_CALL_FUNCTION_NAME,
  LOG_CALL_TOPIC_FUNCTION_NAME,
  REQUEST_CALLBACK_FUNCTION_NAME,
} from './toolNames.js';

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

/**
 * `language`'s goodbye line, clinic placeholders filled — the single source
 * used both for the assistant's own `endCallMessage` (render.ts) and for a
 * handoff destination's `assistantOverrides.endCallMessage` (squad.ts),
 * so the two never drift apart.
 */
export function goodbyeMessage(config: ClientConfig, language: string): string {
  return fillClinicPlaceholders(config, language, pick(config.scripts.goodbye, language));
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

/**
 * Instructions for handing the call to another language's assistant. One
 * bullet per other supported language, driven entirely by `switchKeywords` in
 * client.yaml — no language is named here. Empty when only one language is
 * supported. The handoff tools themselves are built in squad.ts.
 */
function languageSwitchSection(config: ClientConfig, language: string): string[] {
  const bullets = config.languages.supported
    .filter((code) => code !== language)
    .map((code) => {
      const keywords = (config.languages.settings[code]?.switchKeywords ?? [])
        .map((keyword) => `"${keyword}"`)
        .join(', ');
      return (
        `- If the caller says ${keywords}, or otherwise asks to continue in the "${code}" ` +
        `language, call the handoff tool that transfers to the "${code}" assistant.`
      );
    });
  if (bullets.length === 0) return [];

  return [
    [
      'Language switching: this call can be handed to a receptionist who speaks another language.',
      ...bullets,
      'The caller may ask at any point in the call, not only at the start — after answering ' +
        'questions, or at any later turn. Call the tool right away, without saying anything ' +
        'before or after it: the other receptionist greets the caller themselves. Only hand ' +
        'off when the caller clearly asks for another language; a single foreign word inside ' +
        'an ordinary sentence is not a request.',
    ].join('\n'),
  ];
}

/**
 * Tells the model to tag every call with a topic and outcome, silently, then
 * hang up via the built-in endCall tool — real calls otherwise sit open
 * until the caller manually ends them (VAPI-FACTS.md, VP-4 R5).
 * log_call_topic is asynchronous on Vapi's side, so it cannot delay the
 * caller (VAPI-FACTS.md, VP-4 §4.3). The goodbye itself is no longer the
 * model's job: endCall is configured with a `blocking: true` request-start
 * message that Vapi speaks automatically before the call actually ends, so
 * it plays even if the model jumps straight to these silent tool calls
 * (VAPI-FACTS.md, VP-6 — fixes the baseline call where the model sometimes
 * skipped the goodbye entirely).
 */
function callClassificationSection(faq: FaqEntry[]): string {
  const topics = allowedTopics(faq.map((entry) => entry.id))
    .map((topic) => `"${topic}"`)
    .join(', ');

  return [
    'Call classification (silent, once per call):',
    `- When the call is ending, call ${LOG_CALL_TOPIC_FUNCTION_NAME} exactly once, then call ` +
      `${END_CALL_FUNCTION_NAME} to hang up. Do this instead of saying a goodbye line yourself — ` +
      'the goodbye is spoken automatically when the call ends. Say nothing else; both tool calls are silent.',
    '- Never mention either tool, logging, topics or classification to the caller.',
    `- topic: exactly one of ${topics}. Use the FAQ topic id that best matches the whole call. ` +
      'Use "other" if the call was answered but fits no FAQ topic. Use "unresolved" if you took a callback ' +
      'request or could not help. Use "emergency" for a medical emergency.',
    '- outcome: "resolved" when the caller got their answer, "unresolved" when you took a callback request or ' +
      'could not help, "emergency" for a medical emergency.',
    `- Do this even for an emergency call. Never pass a name, phone number or any free text to ${LOG_CALL_TOPIC_FUNCTION_NAME}.`,
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
      "- Personal details are collected ONLY when there is a reason to. If the caller's question " +
        'matches a FAQ entry, answer it directly and NEVER ask for their name or phone number.',
      `- After answering a question, ask: "${scriptLine('anythingElse')}"`,
      `- If nothing above matches what the caller is asking, say: "${scriptLine('noMatch')}". ` +
        `If the caller explicitly asks for staff instead, say: "${scriptLine('staffContactOffer')}" ` +
        'instead. Only in these two cases, continue by asking: ' +
        `"${scriptLine('askPhone')}".`,
      `- MANDATORY confirmation step, no exceptions: once you have both the name and phone number, ` +
        `"${scriptLine('confirmDetails')}" MUST be its own separate spoken turn — never combined ` +
        `with anything else, never skipped, even if you are confident you heard correctly. Say it, ` +
        `then STOP and wait for the caller's reply. Do NOT call the ${REQUEST_CALLBACK_FUNCTION_NAME} ` +
        "tool until the caller has given an explicit yes/correct/that's right response to THIS exact " +
        'question. If they correct something, update it and ask the confirmation question again — do ' +
        'not proceed on an uncorrected "no" or on silence. Calling the tool without this confirmed ' +
        '"yes" first is a serious error.',
      `- After the tool call: if it succeeded, say something in the spirit of "${scriptLine('callbackSaved')}"; ` +
        `if it failed, say something in the spirit of "${scriptLine('callbackFailed')}". In both cases, ` +
        "substitute the caller's actual name and phone number for [[callerName]] and [[callerPhone]] " +
        '— never speak the placeholder text itself.',
      `- After that, ask: "${scriptLine('anythingElse')}" — same as after answering a FAQ question. ` +
        'Do not go quiet and wait for the caller to speak first.',
      '- When the caller is done, do NOT say a goodbye line yourself — move directly to the ' +
        'silent call classification steps below, which end the call. The system speaks the ' +
        'goodbye automatically when the call ends; saying it yourself would say it twice.',
    ].join('\n'),

    // 4b. Silent call classification (analytics, VP-4)
    callClassificationSection(faq),

    // 5. Safety
    [
      'Safety rules:',
      ...(config.safety.noMedicalAdvice
        ? [`- Never give medical advice. If asked, say: "${scriptLine('noMedicalAdvice')}"`]
        : []),
      '- If anything sounds like a medical emergency (serious injury, severe pain, difficulty ' +
        `breathing, etc.), immediately say: "${scriptLine('emergency')}" instead of continuing the ` +
        `normal flow. Do not collect a name or phone number and do not call ${REQUEST_CALLBACK_FUNCTION_NAME}; ` +
        'just classify the call as an emergency (see the call classification rules).',
    ].join('\n'),

    // 6. Didn't-catch handling
    `If you don't clearly understand what the caller said, don't guess at it — say: "${scriptLine('didNotCatch')}"`,

    // 7. Language switching (Squad handoff)
    ...languageSwitchSection(config, language),

    // 8. Tone
    'Tone: speak naturally, the way a real receptionist would on the phone — this is a ' +
      'phone call, not a chat window, so keep responses concise. Never read a placeholder ' +
      'token (anything inside [[ ]]) aloud; always substitute the real value first.',
  ];

  return sections.join('\n\n');
}

/**
 * In-memory `ClientConfig` / `FaqEntry` fixtures for unit-testing the pure
 * Vapi rendering functions (promptTemplate, render) without going through
 * YAML files. `buildMinimalConfig` takes an arbitrary language code so tests
 * can prove those functions have no `ja`/`en`-specific code path.
 */
import { SCRIPT_KEYS } from '../../src/config/schema.js';
import type { ClientConfig } from '../../src/config/schema.js';
import type { FaqEntry } from '../../src/knowledge/KnowledgeSource.js';

function buildScripts(language: string): ClientConfig['scripts'] {
  return Object.fromEntries(
    SCRIPT_KEYS.map((key) => [key, { [language]: `${key} text (${language})` }]),
  ) as ClientConfig['scripts'];
}

export function buildFaqEntry(language: string, id = 'sample-question'): FaqEntry {
  return {
    id,
    tags: ['sample'],
    question: { [language]: `Sample question (${language})?` },
    answer: { [language]: `Sample answer (${language}).` },
  };
}

export interface MinimalConfigOptions {
  clientId?: string;
  language?: string;
  faqIds?: string[];
  /** Overrides the default `{ provider: 'azure', language }` transcriber — e.g. for a Flux fixture. */
  transcriber?: { provider: string; model?: string; language?: string; languages?: string[] };
}

/** A minimal but fully valid ClientConfig, supporting exactly one language. */
export function buildMinimalConfig(options: MinimalConfigOptions = {}): ClientConfig {
  const clientId = options.clientId ?? 'test-clinic';
  const language = options.language ?? 'fr';
  const faqIds = options.faqIds ?? ['sample-question'];

  return {
    clientId,
    status: 'demo',
    business: {
      type: 'generic',
      name: { [language]: `Test Clinic (${language})` },
      address: { postalCode: '00000', [language]: `1 Test St (${language})` },
      phone: { display: '000-000-0000', e164: '+10000000000' },
      website: 'https://example.com',
      hours: {
        timezone: 'UTC',
        weekly: {
          mon: { open: '09:00', close: '17:00' },
          tue: { open: '09:00', close: '17:00' },
          wed: { open: '09:00', close: '17:00' },
          thu: { open: '09:00', close: '17:00' },
          fri: { open: '09:00', close: '17:00' },
          sat: 'closed',
          sun: 'closed',
        },
        closedOnNationalHolidays: false,
      },
    },
    languages: {
      default: language,
      supported: [language],
      settings: {
        [language]: {
          voice: { provider: 'azure', voiceId: 'test-voice-id' },
          transcriber: options.transcriber ?? { provider: 'azure', language },
          switchKeywords: ['switch-language'],
        },
      },
    },
    callback: {
      enabled: true,
      collect: ['name', 'phone'],
      offerWhen: ['no_faq_match', 'caller_asks_for_staff'],
      notifiers: [],
    },
    safety: {
      emergencyNumber: '000',
      noMedicalAdvice: true,
    },
    scripts: buildScripts(language),
    faq: faqIds.map((id) => buildFaqEntry(language, id)),
  };
}

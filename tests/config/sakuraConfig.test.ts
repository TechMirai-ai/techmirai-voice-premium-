import { describe, expect, test } from 'vitest';

import { loadClientWithWarnings } from '../../src/config/loadClient.js';
import { SCRIPT_KEYS } from '../../src/config/schema.js';
import { SAKURA_ID } from '../helpers/clientFixtures.js';

describe('the Sakura Seikotsuin demo config', () => {
  test('passes validation with no warnings', () => {
    const { config, warnings } = loadClientWithWarnings(SAKURA_ID);

    expect(config.clientId).toBe(SAKURA_ID);
    expect(warnings).toEqual([]);
  });

  test('declares Japanese as the default language and English as supported', () => {
    const { config } = loadClientWithWarnings(SAKURA_ID);

    expect(config.languages.default).toBe('ja');
    expect(config.languages.supported).toEqual(['ja', 'en']);
    expect(Object.keys(config.languages.settings)).toEqual(['ja', 'en']);
  });

  test('has every script and FAQ entry in every supported language', () => {
    const { config } = loadClientWithWarnings(SAKURA_ID);
    const languages = config.languages.supported;

    for (const key of SCRIPT_KEYS) {
      for (const language of languages) {
        expect(config.scripts[key][language], `scripts.${key}.${language}`).toBeTruthy();
      }
    }

    expect(config.faq).toHaveLength(10);
    for (const [index, entry] of config.faq.entries()) {
      for (const language of languages) {
        expect(entry.question[language], `faq[${index}].question.${language}`).toBeTruthy();
        expect(entry.answer[language], `faq[${index}].answer.${language}`).toBeTruthy();
      }
    }
  });

  test('VP-3: has a Japanese handoffToJapanese line to speak, and its English is a gloss (never spoken)', () => {
    const { config } = loadClientWithWarnings(SAKURA_ID);

    expect(config.scripts.handoffToJapanese['ja']).toBe(
      '日本語の受付にお繋ぎしました。ご用件をお聞かせください。',
    );
    expect(config.scripts.handoffToJapanese['en']).toMatch(/^\(Gloss for Jamal, not spoken:/);
  });

  test('stores the phone number in a form that can hold E.164 (FUTURE-FEATURES F-4)', () => {
    const { config } = loadClientWithWarnings(SAKURA_ID);

    expect(config.business.phone.e164).toMatch(/^\+[1-9]\d{6,14}$/);
  });
});

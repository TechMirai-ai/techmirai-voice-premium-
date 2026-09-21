import { describe, expect, test } from 'vitest';

import { loadClient } from '../../src/config/loadClient.js';
import { FileKnowledgeSource } from '../../src/knowledge/KnowledgeSource.js';
import { buildSystemPrompt, UnsupportedLanguageError } from '../../src/vapi/promptTemplate.js';
import { SAKURA_ID } from '../helpers/clientFixtures.js';
import { buildMinimalConfig } from '../helpers/vapiFixtures.js';

const knowledge = new FileKnowledgeSource();

describe('buildSystemPrompt — Sakura fixture (ja)', () => {
  test('includes the business name', async () => {
    const config = loadClient(SAKURA_ID);
    const faq = await knowledge.listFaq(SAKURA_ID);

    const prompt = buildSystemPrompt(config, 'ja', faq);

    expect(prompt).toContain(config.business.name['ja']);
  });

  test('includes all 10 FAQ entries, question and answer (clinic placeholders substituted)', async () => {
    const config = loadClient(SAKURA_ID);
    const faq = await knowledge.listFaq(SAKURA_ID);

    const prompt = buildSystemPrompt(config, 'ja', faq);
    const clinicValues: Record<string, string> = {
      clinicName: config.business.name['ja']!,
      clinicPhone: config.business.phone.display,
      clinicAddress: config.business.address['ja']!,
      emergencyNumber: config.safety.emergencyNumber,
    };
    const substitute = (text: string): string =>
      text.replace(
        /\[\[([^\][]*)\]\]/g,
        (match, name: string) => clinicValues[name.trim()] ?? match,
      );

    expect(faq).toHaveLength(10);
    for (const entry of faq) {
      expect(prompt).toContain(substitute(entry.question['ja']!));
      expect(prompt).toContain(substitute(entry.answer['ja']!));
    }
  });

  test('includes the safety rules (no-medical-advice and emergency scripts)', async () => {
    const config = loadClient(SAKURA_ID);
    const faq = await knowledge.listFaq(SAKURA_ID);

    const prompt = buildSystemPrompt(config, 'ja', faq);

    expect(prompt).toContain(config.scripts.noMedicalAdvice['ja']!);
    expect(prompt).toContain(
      config.scripts.emergency['ja']!.replace('[[emergencyNumber]]', config.safety.emergencyNumber),
    );
  });

  test("no longer contains VP-2's temporary language-deflection instruction, in either language", async () => {
    const config = loadClient(SAKURA_ID);
    const faq = await knowledge.listFaq(SAKURA_ID);

    for (const language of config.languages.supported) {
      const prompt = buildSystemPrompt(config, language, faq).toLowerCase();

      expect(prompt).not.toContain('apologize');
      expect(prompt).not.toContain('not available in this test');
      expect(prompt).not.toContain('continue in the current language');
    }
  });

  test("tells the Japanese assistant to hand off to English on the English assistant's switchKeywords, at any point in the call", async () => {
    const config = loadClient(SAKURA_ID);
    const faq = await knowledge.listFaq(SAKURA_ID);

    const prompt = buildSystemPrompt(config, 'ja', faq);

    expect(prompt).toContain('Language switching');
    expect(prompt).toContain('"English"');
    expect(prompt).toContain('"英語"');
    expect(prompt).toContain('handoff tool');
    expect(prompt).toContain('"en" assistant');
    expect(prompt).toContain('at any point in the call');
    expect(prompt).not.toContain('"ja" assistant');
  });

  test('tells the English assistant the equivalent: hand back to Japanese on 日本語 / Japanese', async () => {
    const config = loadClient(SAKURA_ID);
    const faq = await knowledge.listFaq(SAKURA_ID);

    const prompt = buildSystemPrompt(config, 'en', faq);

    expect(prompt).toContain('Language switching');
    expect(prompt).toContain('"日本語"');
    expect(prompt).toContain('"Japanese"');
    expect(prompt).toContain('handoff tool');
    expect(prompt).toContain('"ja" assistant');
    expect(prompt).not.toContain('"en" assistant');
  });

  test('a single-language client gets no language-switching section at all', () => {
    const config = buildMinimalConfig({ language: 'fr' });

    expect(buildSystemPrompt(config, 'fr', config.faq)).not.toContain('Language switching');
  });

  test('leaves [[callerName]]/[[callerPhone]] untouched for the model to fill at call time', async () => {
    const config = loadClient(SAKURA_ID);
    const faq = await knowledge.listFaq(SAKURA_ID);

    const prompt = buildSystemPrompt(config, 'ja', faq);

    expect(prompt).toContain('[[callerName]]');
    expect(prompt).toContain('[[callerPhone]]');
  });

  test('substitutes every clinic placeholder — none remain literal', async () => {
    const config = loadClient(SAKURA_ID);
    const faq = await knowledge.listFaq(SAKURA_ID);

    const prompt = buildSystemPrompt(config, 'ja', faq);

    expect(prompt).not.toContain('[[clinicName]]');
    expect(prompt).not.toContain('[[clinicPhone]]');
    expect(prompt).not.toContain('[[clinicAddress]]');
    expect(prompt).not.toContain('[[emergencyNumber]]');
  });
});

describe('buildSystemPrompt — language handling', () => {
  test('throws UnsupportedLanguageError for a language not in languages.supported', () => {
    const config = buildMinimalConfig({ language: 'fr' });

    expect(() => buildSystemPrompt(config, 'de', [])).toThrow(UnsupportedLanguageError);
  });

  test('works for an arbitrary language code — no hard-coded ja/en branch', () => {
    const config = buildMinimalConfig({ language: 'fr' });

    const prompt = buildSystemPrompt(config, 'fr', config.faq);

    expect(prompt).toContain('Test Clinic (fr)');
    expect(prompt).toContain('Sample question (fr)?');
    expect(prompt).toContain('Sample answer (fr).');
  });
});

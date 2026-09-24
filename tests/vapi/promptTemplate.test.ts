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

  test('asks anythingElse after a successful (or failed) callback save too, not just after a FAQ answer', async () => {
    const config = loadClient(SAKURA_ID);
    const faq = await knowledge.listFaq(SAKURA_ID);

    const prompt = buildSystemPrompt(config, 'ja', faq);

    const toolCallLine = prompt.indexOf('After the tool call');
    const anythingElseAfterTool = prompt.indexOf(config.scripts.anythingElse['ja']!, toolCallLine);
    expect(toolCallLine).toBeGreaterThan(-1);
    expect(anythingElseAfterTool).toBeGreaterThan(toolCallLine);
    expect(prompt).toContain('Do not go quiet and wait for the caller to speak first');
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

describe('buildSystemPrompt — clinic-name pronunciation override (VP-6 D)', () => {
  test('falls back to business.name when no namePronunciation is set for the language', () => {
    const config = buildMinimalConfig({ language: 'fr' });

    const prompt = buildSystemPrompt(config, 'fr', config.faq);

    expect(prompt).toContain('Test Clinic (fr)');
  });

  test('uses namePronunciation instead of business.name when set for the language', () => {
    const config = buildMinimalConfig({ language: 'fr' });
    const withPronunciation = {
      ...config,
      business: { ...config.business, namePronunciation: { fr: 'Test Clinic Phonetic' } },
    };

    const prompt = buildSystemPrompt(withPronunciation, 'fr', withPronunciation.faq);

    expect(prompt).toContain('Test Clinic Phonetic');
    expect(prompt).not.toContain('Test Clinic (fr)');
  });
});

describe('buildSystemPrompt — section order (VP-7 source docs §B)', () => {
  test('identity comes first; style/leading/answering/callback follow before medical/emergency/language/ending/clinic-info/today', async () => {
    const config = loadClient(SAKURA_ID);
    const faq = await knowledge.listFaq(SAKURA_ID);

    const prompt = buildSystemPrompt(config, 'ja', faq);
    const at = (needle: string): number => {
      const index = prompt.indexOf(needle);
      expect(index, `expected to find "${needle}"`).toBeGreaterThan(-1);
      return index;
    };

    const identity = at('You are the AI phone receptionist');
    const style = at('How you speak:');
    const leading = at('Leading the call:');
    const answering = at('Answering questions:');
    const callback = at('Callback requests:');
    const medical = at('Medical questions:');
    const emergency = at('Emergencies:');
    const language = at('Language switching:');
    const ending = at('Ending the call:');
    const clinicInfo = at('Clinic information (for your own grounding');
    const today = at('Today:');

    expect(identity).toBeLessThan(style);
    expect(style).toBeLessThan(leading);
    expect(leading).toBeLessThan(answering);
    expect(answering).toBeLessThan(callback);
    expect(callback).toBeLessThan(medical);
    expect(medical).toBeLessThan(emergency);
    expect(emergency).toBeLessThan(language);
    expect(language).toBeLessThan(ending);
    expect(ending).toBeLessThan(clinicInfo);
    expect(clinicInfo).toBeLessThan(today);
  });
});

describe('buildSystemPrompt — topic/outcome separation (VP-7 R2)', () => {
  test('topic instruction records the real subject regardless of outcome — never collapses into "unresolved"', async () => {
    const config = loadClient(SAKURA_ID);
    const faq = await knowledge.listFaq(SAKURA_ID);

    const prompt = buildSystemPrompt(config, 'ja', faq);

    expect(prompt).toContain(
      'this reflects the SUBJECT of the call, regardless of whether you were able to help',
    );
    expect(prompt).toContain('never write this same value into topic');
    expect(prompt).not.toContain('Use "unresolved" if you took a callback');
  });

  test('outcome instruction captures how the call ended, independently of topic', async () => {
    const config = loadClient(SAKURA_ID);
    const faq = await knowledge.listFaq(SAKURA_ID);

    const prompt = buildSystemPrompt(config, 'ja', faq);

    expect(prompt).toContain('This captures HOW the call ended');
  });
});

describe('buildSystemPrompt — emergency handling (VP-7)', () => {
  test('two-tier: a clear red flag and an uncertain/possibly-serious tier, with a path back to normal flow', async () => {
    const config = loadClient(SAKURA_ID);
    const faq = await knowledge.listFaq(SAKURA_ID);

    const prompt = buildSystemPrompt(config, 'ja', faq);

    expect(prompt).toContain(config.scripts.emergency['ja']!.replace('[[emergencyNumber]]', '119'));
    expect(prompt).toContain(
      config.scripts.emergencyUncertain['ja']!.replace('[[emergencyNumber]]', '119'),
    );
    expect(prompt).toContain("If, after that, the caller says it isn't an emergency");
    expect(prompt).toContain('none of the rules below apply');
    expect(prompt).toContain('resume the call completely normally');
  });

  test('the model speaks a short goodbye itself on the emergency path, before the normal end-call steps (R3 accepted fallback)', async () => {
    const config = loadClient(SAKURA_ID);
    const faq = await knowledge.listFaq(SAKURA_ID);

    const prompt = buildSystemPrompt(config, 'ja', faq);

    expect(prompt).toContain(config.scripts.emergencyGoodbye['ja']!);
    expect(prompt).toContain(
      'this is the one case where you speak a goodbye yourself instead of leaving it to the system',
    );
  });
});

describe('buildSystemPrompt — full name required (VP-7 decision 6)', () => {
  test('asks once for the rest of the name, then proceeds with what it has rather than getting stuck', async () => {
    const config = loadClient(SAKURA_ID);
    const faq = await knowledge.listFaq(SAKURA_ID);

    const prompt = buildSystemPrompt(config, 'ja', faq);

    expect(prompt).toContain('Full name (both given and family name)');
    expect(prompt).toContain('If they give only one part, ask once for the rest');
    expect(prompt).toContain(
      "If they still don't give it after that one ask, proceed with what they gave",
    );
    expect(prompt).toContain("don't ask a third time or get stuck on it");
    expect(prompt.toLowerCase()).not.toContain('surname is fine');
    expect(prompt.toLowerCase()).not.toContain("if they'd rather not");
  });
});

describe('buildSystemPrompt — Today section (VP-7 R5)', () => {
  test('uses the exact verified LiquidJS date syntax, with the timezone from client.yaml', async () => {
    const config = loadClient(SAKURA_ID);
    const faq = await knowledge.listFaq(SAKURA_ID);

    const prompt = buildSystemPrompt(config, 'ja', faq);

    expect(prompt).toContain('{{"now" | date: "%A, %B %d, %Y, %H:%M", "Asia/Tokyo"}}');
  });

  test('uses the config timezone, not a hard-coded one, for a differently-configured client', () => {
    const config = buildMinimalConfig({ language: 'fr' });
    const withTimezone = {
      ...config,
      business: {
        ...config.business,
        hours: { ...config.business.hours, timezone: 'Europe/Paris' },
      },
    };

    const prompt = buildSystemPrompt(withTimezone, 'fr', withTimezone.faq);

    expect(prompt).toContain('{{"now" | date: "%A, %B %d, %Y, %H:%M", "Europe/Paris"}}');
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

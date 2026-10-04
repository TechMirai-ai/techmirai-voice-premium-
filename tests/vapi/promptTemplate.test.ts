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
    const emergency = at('Emergencies —');
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
      'This is the one case where you speak a goodbye yourself instead of leaving it to the system',
    );
  });

  test('on the emergency path the model says the short goodbye itself, then logs the emergency and ends the call', async () => {
    const config = loadClient(SAKURA_ID);
    const faq = await knowledge.listFaq(SAKURA_ID);

    const prompt = buildSystemPrompt(config, 'ja', faq);
    const emergency = prompt.slice(
      prompt.indexOf('Emergencies —'),
      prompt.indexOf('Language switching:'),
    );

    const goodbye = emergency.indexOf('Once the caller responds or goes quiet, say the short line');
    const log = emergency.lastIndexOf(
      'log_call_topic (topic "emergency", outcome "emergency") and endCall',
    );
    expect(goodbye).toBeGreaterThan(-1);
    expect(log).toBeGreaterThan(goodbye);
  });

  test('the uncertain-pain line comes before answering a "can you see me today?" question, and the medical-advice line is scoped to advice requests', async () => {
    const config = loadClient(SAKURA_ID);
    const faq = await knowledge.listFaq(SAKURA_ID);

    const prompt = buildSystemPrompt(config, 'ja', faq);

    expect(prompt).toContain('check this FIRST on every caller turn');
    expect(prompt).toContain('even if they are only asking whether you can see them today');
    expect(prompt).toContain(
      config.scripts.emergencyUncertain['ja']!.replace('[[emergencyNumber]]', '119'),
    );
    expect(prompt).toContain('answer the question they originally asked');
    expect(prompt).toContain(
      'A caller who merely mentions pain while asking whether you can see them is asking a service question',
    );
  });
});

describe('buildSystemPrompt — caller-done examples (VP-7 follow-up)', () => {
  test("shows the model the language's own examples of a finished caller, from client.yaml", async () => {
    const config = loadClient(SAKURA_ID);
    const faq = await knowledge.listFaq(SAKURA_ID);

    const ja = buildSystemPrompt(config, 'ja', faq);
    const en = buildSystemPrompt(config, 'en', faq);

    expect(ja).toContain(
      'Examples of a caller who is finished: "ありがとうございました", "以上です"',
    );
    expect(en).toContain(
      'Examples of a caller who is finished: "Thank you very much", "That\'s all"',
    );
    expect(en).toContain('Each of these gets no words from you — only the two tool calls.');
  });

  test('tells the model not to announce the tool calls or say "you\'re welcome"', async () => {
    const config = loadClient(SAKURA_ID);
    const faq = await knowledge.listFaq(SAKURA_ID);

    const prompt = buildSystemPrompt(config, 'en', faq);

    expect(prompt).toContain('not even "you\'re welcome" or a goodbye');
    expect(prompt).toContain('never write them out or announce them');
    expect(prompt).toContain('A reply that has words but no tool calls is wrong here');
  });

  test('omits the examples line for a client that configures none', () => {
    const prompt = buildSystemPrompt(buildMinimalConfig(), 'fr', []);

    expect(prompt).not.toContain('Examples of a caller who is finished');
  });
});

describe("buildSystemPrompt — today's / tomorrow's hours (VP-7 follow-up)", () => {
  test('tells the model to answer for the exact weekday from Today and never say yes or give hours for a closed day', async () => {
    const config = loadClient(SAKURA_ID);
    const faq = await knowledge.listFaq(SAKURA_ID);

    for (const language of ['ja', 'en']) {
      const prompt = buildSystemPrompt(config, language, faq);

      expect(prompt).toContain("Questions about today's or tomorrow's hours");
      expect(prompt).toContain('answer for that day only');
      expect(prompt).toContain('never say "yes" or give opening hours for a day it is closed');
    }
  });
});

describe('buildSystemPrompt — over-triggering guards (VP-7 follow-up)', () => {
  test("the uncertain-emergency line is tied to the language's own severe-pain words from client.yaml, and never to an ordinary ache or routine injury", async () => {
    const config = loadClient(SAKURA_ID);
    const faq = await knowledge.listFaq(SAKURA_ID);

    const ja = buildSystemPrompt(config, 'ja', faq);
    const en = buildSystemPrompt(config, 'en', faq);

    expect(ja).toContain('with an intensity word such as "激痛", "ひどい痛み"');
    expect(en).toContain('with an intensity word such as "severe", "intense"');
    for (const prompt of [ja, en]) {
      expect(prompt).toContain(
        'Never use it for an ordinary ache, stiffness, a sprain, or a routine injury the caller mentions while asking whether you treat it',
      );
    }
  });

  test('does not quote example injuries next to the emergency line — that primed the model to say it for them (VP-7 suite run)', async () => {
    const config = loadClient(SAKURA_ID);
    const faq = await knowledge.listFaq(SAKURA_ID);

    const prompt = buildSystemPrompt(config, 'en', faq);
    const emergency = prompt.slice(
      prompt.indexOf('Emergencies —'),
      prompt.indexOf('Language switching:'),
    );

    expect(emergency).not.toContain('twisted my ankle');
    expect(emergency).not.toContain('my back hurts');
  });

  test('falls back to the generic "sudden or severe pain" wording for a client with no severePainWords', () => {
    const prompt = buildSystemPrompt(buildMinimalConfig(), 'fr', []);

    expect(prompt).toContain(
      "If they describe sudden or severe pain and you're not sure it's that serious,",
    );
  });

  test('an explicit "no" to a callback offer is a clear decline — no second check', async () => {
    const config = loadClient(SAKURA_ID);
    const faq = await knowledge.listFaq(SAKURA_ID);

    const prompt = buildSystemPrompt(config, 'en', faq);

    expect(prompt).toContain('starts with an explicit "no" (in any language) is a clear decline');
    expect(prompt).toContain('do not ask again');
  });

  test('the three-strikes goodbye ends with a configured hang-up phrase, so speaking it ends the call on the platform side', () => {
    const config = loadClient(SAKURA_ID);

    for (const language of ['ja', 'en']) {
      const line = config.scripts.repeatedMisunderstanding[language]!.toLowerCase();
      const phrases = config.languages.settings[language]!.endCallPhrases!;
      expect(phrases.some((phrase) => line.includes(phrase.toLowerCase()))).toBe(true);
    }
  });
});

describe('buildSystemPrompt — emergency loop guard (production call 01a0d7e1)', () => {
  test('rule zero — never repeat an emergency line — is the FIRST emergency rule, and survives a history that omits the assistant’s own replies', async () => {
    const config = loadClient(SAKURA_ID);
    const faq = await knowledge.listFaq(SAKURA_ID);

    for (const language of ['ja', 'en']) {
      const prompt = buildSystemPrompt(config, language, faq);
      const emergency = prompt.slice(
        prompt.indexOf('Emergencies —'),
        prompt.indexOf('Language switching:'),
      );

      expect(emergency.indexOf('Rule zero')).toBeGreaterThan(-1);
      expect(emergency.indexOf('Rule zero')).toBeLessThan(
        emergency.indexOf('If the caller says outright'),
      );
      expect(emergency).toContain('may not include your own earlier replies');
      expect(emergency).toContain('Say NO emergency line — not even the conditional one');
      expect(emergency).toContain(
        'is answered ONLY with the short goodbye line and the two tool calls',
      );
    }
  });

  test('a caller who says outright that it is an emergency gets the clear-emergency line, even if they also ask a question', async () => {
    const config = loadClient(SAKURA_ID);
    const faq = await knowledge.listFaq(SAKURA_ID);

    const prompt = buildSystemPrompt(config, 'en', faq);

    expect(prompt).toContain('says outright that it is an emergency');
    expect(prompt).toContain('even if they also ask another question');
  });

  test('the conditional (uncertain) line stays open-ended: the model must say only that line, no goodbye, and wait', async () => {
    const config = loadClient(SAKURA_ID);
    const faq = await knowledge.listFaq(SAKURA_ID);

    const prompt = buildSystemPrompt(config, 'en', faq);

    expect(prompt).toContain(
      'Say exactly that line and nothing more — no goodbye, and do not end the call',
    );
  });

  test('the clear-emergency line itself ends with a configured hang-up phrase, so the call ends without any later turn', () => {
    const config = loadClient(SAKURA_ID);

    for (const language of ['ja', 'en']) {
      const line = config.scripts.emergency[language]!.toLowerCase();
      const phrases = config.languages.settings[language]!.endCallPhrases!;
      expect(phrases.some((phrase) => line.includes(phrase.toLowerCase()))).toBe(true);
    }
  });

  test('the conditional emergency line does NOT contain a hang-up phrase (it must let a non-emergency caller answer)', () => {
    const config = loadClient(SAKURA_ID);

    for (const language of ['ja', 'en']) {
      const line = config.scripts.emergencyUncertain[language]!.toLowerCase();
      const phrases = config.languages.settings[language]!.endCallPhrases!;
      expect(phrases.some((phrase) => line.includes(phrase.toLowerCase()))).toBe(false);
    }
  });
});

describe('buildSystemPrompt — phone read-back (VP-7)', () => {
  test('gives the model the per-language digit words and a worked example from client.yaml', async () => {
    const config = loadClient(SAKURA_ID);
    const faq = await knowledge.listFaq(SAKURA_ID);

    const ja = buildSystemPrompt(config, 'ja', faq);
    const en = buildSystemPrompt(config, 'en', faq);

    expect(ja).toContain(
      '0=ゼロ/レイ, 1=イチ, 2=ニー, 3=サン, 4=ヨン, 5=ゴー, 6=ロク, 7=ナナ, 8=ハチ, 9=キュウ',
    );
    expect(ja).toContain('"ゼロキュウゼロ、イチニーサンヨン、ゴーロクナナハチ"');
    expect(en).toContain('0=zero, 1=one, 2=two');
    expect(en).toContain('"zero nine zero, one two three four, five six seven eight"');
  });

  test('tells the model to check the 3-4-4 digit grouping BEFORE reading back, and to ask again instead of reading back a wrong-length number', async () => {
    const config = loadClient(SAKURA_ID);
    const faq = await knowledge.listFaq(SAKURA_ID);

    const prompt = buildSystemPrompt(config, 'ja', faq);

    expect(prompt).toContain('Check the digits BEFORE reading anything back');
    expect(prompt).toContain('exactly 11 digits in groups of 3-4-4');
    expect(prompt).toContain('do NOT read it back');
    expect(prompt).toContain('never skip, merge or change a digit');
    // The retry line is its own script, so it never counts toward the three-strikes hang-up.
    expect(prompt).toContain(config.scripts.phoneRetry['ja']!);
    expect(prompt).toContain('not one of the "didn\'t catch it" attempts');
  });

  test('omits the digit guide (but keeps the generic rule) for a client that configures none', () => {
    const config = buildMinimalConfig();

    const prompt = buildSystemPrompt(config, 'fr', []);

    expect(prompt).not.toContain('Digit words:');
    expect(prompt).toContain('Speak every digit the caller gave');
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

describe('buildSystemPrompt — VP-8 reservation flow', () => {
  const SERVICES = [
    { id: 'general-consultation', name: { fr: 'Consultation générale' }, durationMinutes: 30 },
  ];

  test('no services given — no reservation section, no services list, defaults to []', () => {
    const config = buildMinimalConfig({ language: 'fr' });

    const prompt = buildSystemPrompt(config, 'fr', config.faq);

    expect(prompt).not.toContain('Reservations (demo)');
    expect(prompt).not.toContain('Reservation services');
    expect(prompt).not.toContain('check_availability');
  });

  test('services given — the reservation flow and services list both appear, service-localized', () => {
    const config = buildMinimalConfig({ language: 'fr' });

    const prompt = buildSystemPrompt(config, 'fr', config.faq, SERVICES);

    expect(prompt).toContain('Reservations (demo)');
    expect(prompt).toContain('check_availability');
    expect(prompt).toContain('lookup_patient');
    expect(prompt).toContain('book_appointment');
    expect(prompt).toContain('Reservation services');
    expect(prompt).toContain('Consultation générale (id: general-consultation, about 30 min)');
    // Wired to the real reservationSaved script text — buildMinimalConfig's generic
    // fixture text for every SCRIPT_KEY, proving the section actually reads that key.
    expect(prompt).toContain('reservationSaved text (fr)');
  });
});

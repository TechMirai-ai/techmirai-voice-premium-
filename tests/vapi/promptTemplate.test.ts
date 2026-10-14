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

  test('includes the safety rule (no-medical-advice script)', async () => {
    const config = loadClient(SAKURA_ID);
    const faq = await knowledge.listFaq(SAKURA_ID);

    const prompt = buildSystemPrompt(config, 'ja', faq);

    expect(prompt).toContain(config.scripts.noMedicalAdvice['ja']!);
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

  test('leaves [[callerName]] untouched for the model to fill at call time', async () => {
    const config = loadClient(SAKURA_ID);
    const faq = await knowledge.listFaq(SAKURA_ID);

    const prompt = buildSystemPrompt(config, 'ja', faq);

    expect(prompt).toContain('[[callerName]]');
    expect(prompt).not.toContain('[[callerPhone]]');
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
  test('identity comes first; style/leading/answering/callback follow before medical/language/ending/clinic-info/today', async () => {
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
    const language = at('Language switching:');
    const ending = at('Ending the call:');
    const clinicInfo = at('Clinic information (for your own grounding');
    const today = at('Today:');

    expect(identity).toBeLessThan(style);
    expect(style).toBeLessThan(leading);
    expect(leading).toBeLessThan(answering);
    expect(answering).toBeLessThan(callback);
    expect(callback).toBeLessThan(medical);
    expect(medical).toBeLessThan(language);
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

describe('buildSystemPrompt — no emergency handling', () => {
  test('neither language contains an emergency section, an ambulance number or an emergency topic', async () => {
    const config = loadClient(SAKURA_ID);
    const faq = await knowledge.listFaq(SAKURA_ID);

    for (const language of ['ja', 'en']) {
      const prompt = buildSystemPrompt(config, language, faq);

      expect(prompt).not.toContain('Emergencies —');
      expect(prompt).not.toMatch(/119|ambulance|emergency/i);
      expect(prompt).not.toContain('救急');
      expect(prompt).not.toContain('緊急');
    }
  });

  test('the medical-advice line is scoped to advice requests, not to a caller who merely mentions pain', async () => {
    const config = loadClient(SAKURA_ID);
    const faq = await knowledge.listFaq(SAKURA_ID);

    const prompt = buildSystemPrompt(config, 'ja', faq);

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

describe('buildSystemPrompt — name + contact-number flow (no spoken phone number)', () => {
  const SERVICES = [
    { id: 'general-consultation', name: { fr: 'Consultation générale' }, durationMinutes: 30 },
  ];
  const lang = ['ja', 'en'] as const;

  test('never asks the caller for a phone number or a digit read-back, in either language', async () => {
    const config = loadClient(SAKURA_ID);
    const faq = await knowledge.listFaq(SAKURA_ID);

    for (const language of lang) {
      const prompt = buildSystemPrompt(config, language, faq, SERVICES);

      expect(prompt).not.toMatch(/digit words|3-4-4|read-?back/i);
      expect(prompt).not.toContain('May I have a phone number');
      expect(prompt).not.toContain('callerPhone');
      expect(prompt).not.toContain('patientPhone');
      expect(prompt).toContain('Never ask for, repeat or read out a phone number');
    }
  });

  test('callback flow: name, then name confirmation, then the contact-number question, then the tool', async () => {
    const config = loadClient(SAKURA_ID);
    const faq = await knowledge.listFaq(SAKURA_ID);

    for (const language of lang) {
      const prompt = buildSystemPrompt(config, language, faq);
      const callback = prompt.slice(
        prompt.indexOf('Callback requests:'),
        prompt.indexOf('Medical questions:'),
      );
      const confirm = callback.indexOf(config.scripts.confirmName[language]!);
      const contact = callback.indexOf(config.scripts.askContactNumber[language]!);
      const tool = callback.indexOf('Call request_callback only after');

      expect(confirm).toBeGreaterThan(-1);
      expect(contact).toBeGreaterThan(confirm);
      expect(tool).toBeGreaterThan(contact);
      expect(callback).toContain('a first name or short name is enough');
      expect(callback).toContain('There is no phone-number argument');
    }
  });

  test('reservation flow (first-time): asks for the name only after a time is confirmed, then confirms it and asks the contact-number question before booking', async () => {
    const config = loadClient(SAKURA_ID);
    const faq = await knowledge.listFaq(SAKURA_ID);

    for (const language of lang) {
      const prompt = buildSystemPrompt(config, language, faq, SERVICES);
      const firstTime = prompt.slice(
        prompt.indexOf('FIRST-TIME VISITOR'),
        prompt.indexOf('RETURNING PATIENT'),
      );
      const ask = firstTime.indexOf(config.scripts.askName[language]!);
      const confirm = firstTime.indexOf(config.scripts.confirmName[language]!);
      const contact = firstTime.indexOf(config.scripts.askContactNumber[language]!);
      const book = firstTime.indexOf('Call book_appointment only after');

      expect(firstTime.indexOf('Once a specific time is confirmed available')).toBeLessThan(ask);
      expect(ask).toBeLessThan(confirm);
      expect(confirm).toBeLessThan(contact);
      expect(contact).toBeLessThan(book);
      expect(firstTime).toContain('isReturningPatient: false');
    }
  });

  test('reservation flow (returning): confirms the name and the contact-number answer, then looks the patient up by name', async () => {
    const config = loadClient(SAKURA_ID);
    const faq = await knowledge.listFaq(SAKURA_ID);

    for (const language of lang) {
      const prompt = buildSystemPrompt(config, language, faq, SERVICES);
      const returning = prompt.slice(
        prompt.indexOf('RETURNING PATIENT'),
        prompt.indexOf('Medical questions:'),
      );
      const confirm = returning.indexOf(config.scripts.confirmName[language]!);
      const contact = returning.indexOf(config.scripts.askContactNumber[language]!);
      const lookup = returning.indexOf('call lookup_patient with the confirmed name');

      expect(confirm).toBeGreaterThan(-1);
      expect(contact).toBeGreaterThan(confirm);
      expect(lookup).toBeGreaterThan(contact);
      expect(returning).toContain('do NOT ask for one again here under any circumstance');
    }
  });

  test('every confirmation question is its own turn, separate from the tool call that depends on it', async () => {
    const config = loadClient(SAKURA_ID);
    const faq = await knowledge.listFaq(SAKURA_ID);

    const prompt = buildSystemPrompt(config, 'en', faq, SERVICES);

    expect(prompt).toContain('that turn contains ONLY the question — no tool call');
    expect(prompt).toContain('Never produce the tool call in the same turn as the question itself');
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

describe('buildSystemPrompt — no repeated acknowledgement after a split utterance (VP-10)', () => {
  test('English tells the model not to repeat an acknowledgement, and explicitly exempts every line other rules require', async () => {
    const config = loadClient(SAKURA_ID);
    const faq = await knowledge.listFaq(SAKURA_ID);

    const prompt = buildSystemPrompt(config, 'en', faq);

    expect(prompt).toContain('Caller still finishing a thought');
    expect(prompt).toContain('do not say the same acknowledgement or sentence again');
    // The exemptions are what keep this from suppressing by-design repeats.
    expect(prompt).toContain('whether there is anything else');
    expect(prompt).toContain('re-asking for a missing detail');
    expect(prompt).toContain('re-asking for a missing detail and the goodbye');
    expect(prompt).not.toContain('emergency');
  });

  test('Japanese does NOT get the rule until avoidRepeatedAcknowledgement is set for it — a ja re-sync must never pick it up by accident', async () => {
    const config = loadClient(SAKURA_ID);
    const faq = await knowledge.listFaq(SAKURA_ID);

    expect(config.languages.settings.ja?.avoidRepeatedAcknowledgement).toBeUndefined();
    expect(buildSystemPrompt(config, 'ja', faq)).not.toContain('Caller still finishing a thought');
  });
});

describe('buildSystemPrompt — returning-caller section (VP-15)', () => {
  test('references the per-call priorCall variable exactly once, after the Today section', async () => {
    const config = loadClient(SAKURA_ID);
    const faq = await knowledge.listFaq(SAKURA_ID);

    const prompt = buildSystemPrompt(config, 'ja', faq);

    expect(prompt.match(/\{\{priorCall\}\}/g)).toHaveLength(1);
    expect(prompt.indexOf('{{priorCall}}')).toBeGreaterThan(prompt.indexOf('Today:'));
  });

  test('tells the model to ignore the section for "none", never recite details, and not volunteer them', async () => {
    const config = loadClient(SAKURA_ID);
    const faq = await knowledge.listFaq(SAKURA_ID);

    const prompt = buildSystemPrompt(config, 'ja', faq);

    expect(prompt).toContain('says "none"');
    expect(prompt).toContain('Never read it out');
    expect(prompt).toContain('no names, health details or reservation details');
    expect(prompt).toContain('needs_callback');
  });

  test('skips the opening booking question only when there is an earlier call, as a two-line conditional', async () => {
    const config = loadClient(SAKURA_ID);
    const faq = await knowledge.listFaq(SAKURA_ID);

    const prompt = buildSystemPrompt(config, 'ja', faq);
    const section = prompt.slice(prompt.indexOf('Earlier call from this caller'));

    expect(section).toContain('you will already have opened with a short welcome-back greeting');
    expect(section).toContain('welcome-back greeting');
    expect(section).toContain('do not ask whether they are calling to make an appointment');
    // The new-caller sections are untouched by the returning-caller rule.
    expect(prompt.slice(0, prompt.indexOf('Earlier call from this caller'))).not.toContain(
      'welcome-back greeting',
    );
  });

  test('has the model confirm a note of the earlier call when asked, only for a real earlier call', async () => {
    const config = loadClient(SAKURA_ID);
    const faq = await knowledge.listFaq(SAKURA_ID);

    const prompt = buildSystemPrompt(config, 'ja', faq);
    const section = prompt.slice(prompt.indexOf('Earlier call from this caller'));
    const confirm = section.indexOf('asks whether you remember them');
    const none = section.indexOf('If that line says "none"');
    const noRecord = section.indexOf('do not claim to remember');

    expect(confirm).toBeGreaterThan(-1);
    expect(section).toContain('you can see a note of their earlier call');
    expect(section).toContain('one short phrase');
    expect(section).toContain('never say you have no access to previous calls');
    // The "no access" ban sits inside the real-earlier-call branch, after the "none" branch...
    expect(confirm).toBeGreaterThan(none);
    // ...and a caller with no record is told not to claim memory.
    expect(noRecord).toBeGreaterThan(-1);
    expect(section).toContain('no record of an earlier call');
    // The existing privacy rules stay.
    expect(section).toContain('Never read it out');
    expect(section).toContain('Never read it out');
  });

  test('mentions a completed earlier call by topic gist on the first reply, never verbatim', async () => {
    const config = loadClient(SAKURA_ID);
    const faq = await knowledge.listFaq(SAKURA_ID);

    const prompt = buildSystemPrompt(config, 'ja', faq);
    const section = prompt.slice(prompt.indexOf('Earlier call from this caller'));

    expect(section).toContain('If the earlier call was completed');
    expect(section).toContain('On your first reply');
    expect(section).toContain('last time we talked about');
    expect(section).toContain('gist');
    expect(section).toContain('never quote or read out the summary');
  });

  test('offers to continue an interrupted earlier call, judged from status and summary only', async () => {
    const config = loadClient(SAKURA_ID);
    const faq = await knowledge.listFaq(SAKURA_ID);

    const prompt = buildSystemPrompt(config, 'ja', faq);
    const section = prompt.slice(prompt.indexOf('Earlier call from this caller'));

    expect(section).toContain('If the earlier call looks interrupted');
    expect(section).toContain('needs_callback');
    expect(section).toContain('unresolved');
    expect(section).toContain('would you like to continue with that');
    expect(section).toContain('If you cannot tell, treat it as completed');
    // A callback that was already taken is not "interrupted": no restarting it.
    expect(section).toContain('already taken');
  });

  test('keeps the mention generic: topic only, no names, health or booking details from the earlier call', async () => {
    const config = loadClient(SAKURA_ID);
    const faq = await knowledge.listFaq(SAKURA_ID);

    const prompt = buildSystemPrompt(config, 'ja', faq);
    const section = prompt.slice(prompt.indexOf('Earlier call from this caller'));

    expect(section).toContain('topic only');
    expect(section).toContain('names, health details or reservation details');
    expect(section).not.toContain('do not volunteer specifics from the earlier call unprompted');
  });

  test('works for a differently-configured client (no clinic data hard-coded in the section)', () => {
    const config = buildMinimalConfig({ language: 'fr' });

    const prompt = buildSystemPrompt(config, 'fr', config.faq);

    expect(prompt).toContain('{{priorCall}}');
  });
});

import { describe, expect, test } from 'vitest';

import { clientConfigSchema } from '../../src/config/schema.js';
import { loadClient } from '../../src/config/loadClient.js';
import { FileKnowledgeSource } from '../../src/knowledge/KnowledgeSource.js';
import {
  SILENCE_HANGUP_SECONDS,
  endCallPhrasesFor,
  silenceHangupHook,
} from '../../src/vapi/callEnding.js';
import { renderAssistant } from '../../src/vapi/render.js';
import { renderHandoffTool } from '../../src/vapi/squad.js';
import { SAKURA_ID } from '../helpers/clientFixtures.js';
import { buildMinimalConfig } from '../helpers/vapiFixtures.js';

const OPTIONS = { baseUrl: 'https://example.test', credentialId: 'cred-test' };
const knowledge = new FileKnowledgeSource();
const config = loadClient(SAKURA_ID);

describe('endCallPhrasesFor', () => {
  test("returns each language's own phrases from client.yaml", () => {
    expect(endCallPhrasesFor(config, 'ja')).toEqual([
      '失礼いたします',
      '失礼します',
      'お大事になさってください',
    ]);
    expect(endCallPhrasesFor(config, 'en')).toEqual([
      'goodbye',
      'have a great day',
      'please take care',
    ]);
  });

  test('returns undefined for a client that configures none', () => {
    expect(endCallPhrasesFor(buildMinimalConfig(), 'fr')).toBeUndefined();
  });

  test('the emergency goodbye contains a hang-up phrase, so the emergency path ends the call by itself', () => {
    for (const language of ['ja', 'en']) {
      const goodbye = config.scripts.emergencyGoodbye[language]!.toLowerCase();
      const phrases = endCallPhrasesFor(config, language)!;
      expect(phrases.some((phrase) => goodbye.includes(phrase.toLowerCase()))).toBe(true);
    }
  });
});

describe('silenceHangupHook', () => {
  test('is a one-shot customer.speech.timeout hook that runs the built-in endCall, within Vapi documented ranges', () => {
    const hook = silenceHangupHook();

    expect(hook.on).toBe('customer.speech.timeout');
    expect(hook.do).toEqual([{ type: 'tool', tool: { type: 'endCall' } }]);
    expect(hook.options.timeoutSeconds).toBe(SILENCE_HANGUP_SECONDS);
    // Live OpenAPI CustomerSpeechTimeoutOptions: timeoutSeconds 1–1000, triggerMaxCount 1–10.
    expect(hook.options.timeoutSeconds).toBeGreaterThanOrEqual(1);
    expect(hook.options.timeoutSeconds).toBeLessThanOrEqual(1000);
    expect(hook.options.triggerMaxCount).toBe(1);
  });

  test('is long enough not to cut off a caller who is looking for a phone number', () => {
    expect(SILENCE_HANGUP_SECONDS).toBeGreaterThanOrEqual(30);
  });
});

describe('the assistant and every handoff leg carry the same hang-up backstops', () => {
  test.each(['ja', 'en'])(
    '%s assistant sets endCallPhrases and the silence hook',
    async (language) => {
      const faq = await knowledge.listFaq(SAKURA_ID);

      const { assistant } = renderAssistant(config, language, faq, OPTIONS);

      expect(assistant.endCallPhrases).toEqual(endCallPhrasesFor(config, language));
      expect(assistant.hooks).toEqual([silenceHangupHook()]);
    },
  );

  test('a client with no configured phrases omits the field entirely (no empty array sent to Vapi)', () => {
    const minimal = buildMinimalConfig();

    const { assistant } = renderAssistant(minimal, 'fr', [], OPTIONS);

    expect('endCallPhrases' in assistant).toBe(false);
    expect(assistant.hooks).toEqual([silenceHangupHook()]);
  });

  test("handoff overrides carry the DESTINATION language's phrases and the hook (VP-6 R3: not inherited across a handoff)", () => {
    const toEn = renderHandoffTool(config, 'ja', 'en').destinations[0];
    const toJa = renderHandoffTool(config, 'en', 'ja').destinations[0];

    expect(toEn?.assistantOverrides.endCallPhrases).toEqual(endCallPhrasesFor(config, 'en'));
    expect(toJa?.assistantOverrides.endCallPhrases).toEqual(endCallPhrasesFor(config, 'ja'));
    expect(toEn?.assistantOverrides.hooks).toEqual([silenceHangupHook()]);
    expect(toJa?.assistantOverrides.hooks).toEqual([silenceHangupHook()]);
  });

  test('the return member (ja-return) gets the same settings as ja — it is reached only by handoff', async () => {
    const faq = await knowledge.listFaq(SAKURA_ID);

    const ja = renderAssistant(config, 'ja', faq, OPTIONS).assistant;
    const jaReturn = renderAssistant(config, 'ja-return', faq, OPTIONS).assistant;

    expect(jaReturn.endCallPhrases).toEqual(ja.endCallPhrases);
    expect(jaReturn.hooks).toEqual(ja.hooks);
  });
});

describe('schema bounds for the new language settings', () => {
  test('rejects a one-character hang-up phrase (Vapi requires 2–140 characters)', () => {
    const bad = structuredClone(config);
    bad.languages.settings['ja']!.endCallPhrases = ['あ'];

    expect(clientConfigSchema.safeParse(bad).success).toBe(false);
  });

  test('rejects a digit-word list that is not exactly ten entries', () => {
    const bad = structuredClone(config);
    bad.languages.settings['ja']!.phoneReadback = { digitWords: ['ゼロ', 'イチ'], example: 'x' };

    expect(clientConfigSchema.safeParse(bad).success).toBe(false);
  });

  test('the shipped Sakura config is valid', () => {
    expect(clientConfigSchema.safeParse(config).success).toBe(true);
  });
});

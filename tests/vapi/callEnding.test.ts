import { describe, expect, test } from 'vitest';

import { clientConfigSchema } from '../../src/config/schema.js';
import { loadClient } from '../../src/config/loadClient.js';
import { FileKnowledgeSource } from '../../src/knowledge/KnowledgeSource.js';
import {
  endCallPhrasesFor,
  silenceHooks,
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
});

describe('silenceHooks (VP-16 graduated silence)', () => {
  const hooks = silenceHooks(config, 'ja');
  const enHooks = silenceHooks(config, 'en');

  test('is five staggered one-shot customer.speech.timeout hooks, in escalating order', () => {
    expect(hooks).toHaveLength(5);
    expect(hooks.map((h) => h.name)).toEqual([
      'silence-repeat-question',
      'silence-check-1',
      'silence-check-2',
      'silence-announce-end',
      'silence-hangup',
    ]);
    for (const hook of hooks) {
      expect(hook.on).toBe('customer.speech.timeout');
      expect(hook.options.triggerMaxCount).toBe(1);
      expect(hook.options.triggerResetMode).toBe('onUserSpeech');
      // Live OpenAPI CustomerSpeechTimeoutOptions: timeoutSeconds 1–1000.
      expect(hook.options.timeoutSeconds).toBeGreaterThanOrEqual(1);
      expect(hook.options.timeoutSeconds).toBeLessThanOrEqual(1000);
    }
  });

  test('timings follow the work order: 4s, then +5s, +5s, +5s, and hang-up 3s after the announcement', () => {
    expect(hooks.map((h) => h.options.timeoutSeconds)).toEqual([4, 9, 14, 19, 22]);
  });

  test('step 1 is model-generated from the conversation, not a fixed line', () => {
    const [first] = hooks;

    expect(first?.do).toHaveLength(1);
    const action = first?.do[0];
    expect(action?.type).toBe('say');
    expect(action && 'prompt' in action ? action.prompt : '').toMatch(/last question/i);
    expect(action && 'exact' in action).toBe(false);
  });

  test.each([
    ['ja', hooks],
    ['en', enHooks],
  ])('%s: steps 2–4 say the configured script lines, exactly', (language, set) => {
    const say = (i: number) => {
      const action = set[i]?.do[0];
      return action && 'exact' in action ? action.exact : undefined;
    };

    expect(say(1)).toBe(config.scripts.silenceCheck1[language]);
    expect(say(2)).toBe(config.scripts.silenceCheck2[language]);
    expect(say(3)).toBe(config.scripts.silenceEnding[language]);
  });

  test('the final hook runs the built-in endCall, so call-end bookkeeping is unchanged', () => {
    expect(hooks[4]?.do).toEqual([{ type: 'tool', tool: { type: 'endCall' } }]);
  });

  test('wording matches the approved lines', () => {
    expect(config.scripts.silenceCheck1.en).toBe('Hello, can you hear me?');
    expect(config.scripts.silenceCheck2.en).toBe('Are you still on the line?');
    expect(config.scripts.silenceEnding.en).toBe(
      "As I haven't heard a response, I'll end this call now. Thank you for calling. Take care.",
    );
    expect(config.scripts.silenceCheck1.ja).toBe('もしもし、お聞きになれますでしょうか？');
    expect(config.scripts.silenceCheck2.ja).toBe('お電話はつながっておりますでしょうか？');
    expect(config.scripts.silenceEnding.ja).toBe(
      'お返事がないようですので、お電話を終了させていただきます。お電話ありがとうございました。どうぞお大事に。',
    );
  });

  test.each(['ja', 'en'])(
    "%s: no silence line contains one of that language's endCallPhrases (a match would hang up before the 3s step)",
    (language) => {
      const phrases = endCallPhrasesFor(config, language) ?? [];
      const lines = [
        config.scripts.silenceCheck1,
        config.scripts.silenceCheck2,
        config.scripts.silenceEnding,
      ].map((line) => (line[language] ?? '').toLowerCase());

      for (const line of lines) {
        for (const phrase of phrases) {
          expect(line).not.toContain(phrase.toLowerCase());
        }
      }
    },
  );
});

describe('the assistant and every handoff leg carry the same hang-up backstops', () => {
  test.each(['ja', 'en'])(
    '%s assistant sets endCallPhrases and the silence hook',
    async (language) => {
      const faq = await knowledge.listFaq(SAKURA_ID);

      const { assistant } = renderAssistant(config, language, faq, OPTIONS);

      expect(assistant.endCallPhrases).toEqual(endCallPhrasesFor(config, language));
      expect(assistant.hooks).toEqual(silenceHooks(config, language));
    },
  );

  test('a client with no configured phrases omits the field entirely (no empty array sent to Vapi)', () => {
    const minimal = buildMinimalConfig();

    const { assistant } = renderAssistant(minimal, 'fr', [], OPTIONS);

    expect('endCallPhrases' in assistant).toBe(false);
    expect(assistant.hooks).toEqual(silenceHooks(minimal, 'fr'));
  });

  test("handoff overrides carry the DESTINATION language's phrases and the hook (VP-6 R3: not inherited across a handoff)", () => {
    const toEn = renderHandoffTool(config, 'ja', 'en').destinations[0];
    const toJa = renderHandoffTool(config, 'en', 'ja').destinations[0];

    expect(toEn?.assistantOverrides.endCallPhrases).toEqual(endCallPhrasesFor(config, 'en'));
    expect(toJa?.assistantOverrides.endCallPhrases).toEqual(endCallPhrasesFor(config, 'ja'));
    expect(toEn?.assistantOverrides.hooks).toEqual(silenceHooks(config, 'en'));
    expect(toJa?.assistantOverrides.hooks).toEqual(silenceHooks(config, 'ja'));
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

  test('the shipped Sakura config is valid', () => {
    expect(clientConfigSchema.safeParse(config).success).toBe(true);
  });
});

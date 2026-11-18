/**
 * VP-27: techmirai-ai voice-quality parity with the Sakura flows.
 *
 * Every assertion here is either a behaviour techmirai-ai must now have, or a guard that Sakura and
 * Kanto render exactly as before. Prompt-text checks cannot prove the model obeys the text (that is
 * what the TechMirai scenarios in tools/vapi-test-suite are for); they prove the text is there, in
 * the right order, and nowhere it does not belong.
 */
import { describe, expect, test } from 'vitest';

import { loadClient } from '../../src/config/loadClient.js';
import { clientConfigSchema } from '../../src/config/schema.js';
import { FileKnowledgeSource } from '../../src/knowledge/KnowledgeSource.js';
import { renderAssistant } from '../../src/vapi/render.js';
import { renderHandoffTool } from '../../src/vapi/squad.js';
import { SILENCE_END_SERVER } from '../helpers/vapiFixtures.js';

const TECHMIRAI = 'techmirai-ai';
const OTHERS = ['sakura-seikotsuin', 'kanto-city-gas-demo'];
const OPTIONS = { baseUrl: 'https://example.test', credentialId: 'cred-test' };
const knowledge = new FileKnowledgeSource();

async function render(clientId: string, member: string) {
  const config = loadClient(clientId);
  const faq = await knowledge.listFaq(clientId);
  return { config, ...renderAssistant(config, member, faq, OPTIONS) };
}

async function promptOf(clientId: string, member: string): Promise<string> {
  const { assistant } = await render(clientId, member);
  return assistant.model.messages[0]?.content ?? '';
}

describe('M2: a mid-sentence "はい" is not a yes; a question and its tool call are separate turns', () => {
  test.each(['ja', 'en'])(
    'techmirai-ai %s prompt carries the confirmation guard',
    async (member) => {
      const prompt = await promptOf(TECHMIRAI, member);

      expect(prompt).toContain('WHILE you are still speaking');
      expect(prompt).toContain('are always separate turns');
      expect(prompt).toContain('that turn contains ONLY the question');
    },
  );

  test('the guard sits inside the consultation flow, before the "never call before a yes" rule', async () => {
    const prompt = await promptOf(TECHMIRAI, 'ja');
    const guard = prompt.indexOf('WHILE you are still speaking');
    const rule = prompt.indexOf('Never call request_consultation before a clear yes');

    expect(guard).toBeGreaterThan(prompt.indexOf('Consultation requests'));
    expect(guard).toBeLessThan(rule);
  });
});

describe('M4: the name is read back as its own turn, before the contact-number question', () => {
  test.each(['ja', 'en'])(
    '%s: read-back line comes after askName and before askContactNumber',
    async (member) => {
      const { config, assistant } = await render(TECHMIRAI, member);
      const prompt = assistant.model.messages[0]?.content ?? '';
      const scripts = config.consultation!.scripts;
      const confirm = scripts.confirmName[member]!;
      const idx = (text: string) => prompt.indexOf(text);

      expect(confirm).toContain('[[name]]');
      expect(idx(scripts.askName[member]!)).toBeGreaterThan(-1);
      expect(idx(confirm)).toBeGreaterThan(idx(scripts.askName[member]!));
      expect(idx(confirm)).toBeLessThan(idx(scripts.askContactNumber[member]!));
    },
  );

  test('the instruction says: own turn, wait for a clear yes, fix and re-read on a no, no tool call in that turn', async () => {
    const prompt = await promptOf(TECHMIRAI, 'ja');

    expect(prompt).toContain('Name read-back, as its own turn');
    expect(prompt).toMatch(/Name read-back[^\n]*clear yes/);
    expect(prompt).toMatch(/Name read-back[^\n]*no tool call/);
  });

  test('the read-back line is short (one sentence)', () => {
    const config = loadClient(TECHMIRAI);

    for (const language of config.languages.supported) {
      const line = config.consultation!.scripts.confirmName[language]!;
      expect(line.length).toBeLessThanOrEqual(60);
      expect(line.match(/[?？]/g)?.length).toBe(1);
    }
  });

  test('the schema requires the script (a consultation client without confirmName is invalid)', () => {
    const bad = structuredClone(loadClient(TECHMIRAI));
    delete (bad.consultation!.scripts as Record<string, unknown>)['confirmName'];

    expect(clientConfigSchema.safeParse(bad).success).toBe(false);
  });
});

describe('M5: the spoken-number fallback is protected', () => {
  test.each(['ja', 'en'])(
    '%s prompt tells the model how to hear a dictated number',
    async (member) => {
      const prompt = await promptOf(TECHMIRAI, member);

      expect(prompt).toContain('Hearing the number');
      expect(prompt).toContain('零');
      expect(prompt).toContain('レイ');
      expect(prompt).toMatch(/full stop or question mark in the middle of a digit sequence/);
      expect(prompt).toMatch(/word for word/);
    },
  );

  test.each(['ja', 'en'])(
    '%s: a custom endpointing rule waits longer after the number question',
    async (member) => {
      const { config, assistant } = await render(TECHMIRAI, member);
      const dictation = config.consultation!.numberDictation!;
      const rules = assistant.startSpeakingPlan?.customEndpointingRules ?? [];

      expect(rules).toHaveLength(1);
      expect(rules[0]).toMatchObject({ type: 'assistant', timeoutSeconds: dictation.waitSeconds });
      expect(dictation.waitSeconds).toBeGreaterThanOrEqual(2);
      expect(assistant.startSpeakingPlan?.transcriptionEndpointingPlan).toMatchObject({
        onNumberSeconds: dictation.onNumberSeconds,
        onNoPunctuationSeconds: 1.1,
        onPunctuationSeconds: 0.45,
      });
    },
  );

  test.each(['ja', 'en'])(
    '%s: the rule regex matches the spoken number question and nothing else in the flow',
    async (member) => {
      const { config, assistant } = await render(TECHMIRAI, member);
      const rule = assistant.startSpeakingPlan!.customEndpointingRules![0]!;
      const regex = new RegExp(rule.regex);
      const scripts = config.consultation!.scripts;

      expect(regex.test(scripts.askSpokenNumber[member]!)).toBe(true);
      // The model rarely repeats a line exactly: a leading acknowledgement and a different final mark.
      const core = scripts.askSpokenNumber[member]!.replace(/[?？]$/, '');
      expect(
        regex.test(`${member === 'ja' ? 'ありがとうございます。' : 'Thanks. '}${core}。`),
      ).toBe(true);
      for (const other of [
        'askName',
        'confirmName',
        'askContactNumber',
        'confirmSpokenNumber',
        'saved',
      ] as const) {
        expect(regex.test(scripts[other][member]!), other).toBe(false);
      }
    },
  );

  test('the regex is a literal: metacharacters in a script line cannot break it', async () => {
    const { assistant } = await render(TECHMIRAI, 'en');
    const rule = assistant.startSpeakingPlan!.customEndpointingRules![0]!;

    expect(() => new RegExp(rule.regex)).not.toThrow();
    expect(rule.regex.length).toBeGreaterThan(8);
  });

  test('the handoff overrides into ja carry the same rule (the return member is reached by handoff)', () => {
    const config = loadClient(TECHMIRAI);
    const toJa = renderHandoffTool(config, 'en', 'ja', SILENCE_END_SERVER).destinations[0];

    expect(toJa?.assistantOverrides.startSpeakingPlan?.customEndpointingRules).toHaveLength(1);
  });

  test('schema bounds: waitSeconds 0–15 (Vapi), onNumberSeconds 0–3 (Vapi), no unknown keys', () => {
    const config = loadClient(TECHMIRAI);
    const withDictation = (value: unknown) => ({
      ...config,
      consultation: { ...config.consultation!, numberDictation: value },
    });

    expect(clientConfigSchema.safeParse(withDictation({ waitSeconds: 2.5 })).success).toBe(true);
    expect(clientConfigSchema.safeParse(withDictation({ waitSeconds: 16 })).success).toBe(false);
    expect(
      clientConfigSchema.safeParse(withDictation({ waitSeconds: 2, onNumberSeconds: 4 })).success,
    ).toBe(false);
    expect(clientConfigSchema.safeParse(withDictation({ waitSeconds: 2, extra: 1 })).success).toBe(
      false,
    );
  });
});

describe('M3: stopSpeakingPlan is per client and per language', () => {
  test('techmirai-ai ja: Japanese acknowledgements never interrupt, and the live field names are used', async () => {
    const { assistant } = await render(TECHMIRAI, 'ja');
    const plan = assistant.stopSpeakingPlan;

    expect(plan?.numWords).toBeGreaterThanOrEqual(1);
    expect(plan?.acknowledgementPhrases).toEqual(
      expect.arrayContaining(['はい', 'ええ', 'うん', 'そうですね']),
    );
    expect(Object.keys(plan ?? {}).sort()).toEqual(['acknowledgementPhrases', 'numWords']);
  });

  test('the ja-return member (reached only by handoff) gets the same plan', async () => {
    const ja = (await render(TECHMIRAI, 'ja')).assistant.stopSpeakingPlan;
    const jaReturn = (await render(TECHMIRAI, 'ja-return')).assistant.stopSpeakingPlan;

    expect(jaReturn).toEqual(ja);
  });

  test('techmirai-ai en: nothing configured, so Vapi defaults (already English) stay in force', async () => {
    const { assistant } = await render(TECHMIRAI, 'en');

    expect('stopSpeakingPlan' in assistant).toBe(false);
  });

  test('the handoff into ja carries the plan (not assumed to be inherited, VAPI-FACTS VP-6 R3)', () => {
    const config = loadClient(TECHMIRAI);
    const toJa = renderHandoffTool(config, 'en', 'ja', SILENCE_END_SERVER).destinations[0];
    const toEn = renderHandoffTool(config, 'ja', 'en', SILENCE_END_SERVER).destinations[0];

    expect(toJa?.assistantOverrides.stopSpeakingPlan?.acknowledgementPhrases).toContain('はい');
    expect(toEn?.assistantOverrides.stopSpeakingPlan).toBeUndefined();
  });

  test('schema bounds follow the live OpenAPI: numWords 0–10, voiceSeconds 0–0.5, backoffSeconds 0–10', () => {
    const config = loadClient(TECHMIRAI);
    const withPlan = (plan: unknown) => {
      const copy = structuredClone(config);
      (copy.languages.settings['ja'] as Record<string, unknown>)['stopSpeakingPlan'] = plan;
      return copy;
    };

    expect(
      clientConfigSchema.safeParse(
        withPlan({ numWords: 10, voiceSeconds: 0.5, backoffSeconds: 10 }),
      ).success,
    ).toBe(true);
    expect(clientConfigSchema.safeParse(withPlan({ numWords: 11 })).success).toBe(false);
    expect(clientConfigSchema.safeParse(withPlan({ voiceSeconds: 0.6 })).success).toBe(false);
    expect(clientConfigSchema.safeParse(withPlan({ backoffSeconds: 11 })).success).toBe(false);
    expect(
      clientConfigSchema.safeParse(withPlan({ acknowledgementPhrases: ['x'.repeat(241)] })).success,
    ).toBe(false);
    expect(clientConfigSchema.safeParse(withPlan({ nope: 1 })).success).toBe(false);
  });
});

describe('clean-up: no clinic wording in the techmirai-ai prompt', () => {
  const LEFTOVERS = [
    'appointment dates and times',
    'checking availability before offering a time',
    'does not ask about booking',
    'make an appointment',
    'reservation_made',
    'health details',
    'reservation details',
  ];

  test.each(['ja', 'en', 'ja-return'])(
    'member %s has none of the leftover phrases',
    async (member) => {
      const prompt = await promptOf(TECHMIRAI, member);

      for (const phrase of LEFTOVERS) expect(prompt, phrase).not.toContain(phrase);
    },
  );

  test('the Limits line no longer promises an availability check the consultation flow forbids', async () => {
    const prompt = await promptOf(TECHMIRAI, 'ja');
    const limits = prompt.split('\n').find((line) => line.startsWith('Limits:')) ?? '';

    expect(limits).toContain('confirming a name or contact number');
    expect(limits).not.toMatch(/availability|offering a time/);
  });

  test.each(OTHERS)(
    '%s keeps its wording exactly (booking clients still need it)',
    async (clientId) => {
      const prompt = await promptOf(clientId, 'ja');

      expect(prompt).toContain('appointment dates and times');
      expect(prompt).toContain('checking availability before offering a time');
      expect(prompt).toContain('reservation_made');
    },
  );
});

describe('Sakura and Kanto are untouched by the new settings', () => {
  test.each(OTHERS)(
    '%s: no stopSpeakingPlan, no number-dictation rule, no onNumberSeconds',
    async (clientId) => {
      const config = loadClient(clientId);

      for (const member of ['ja', 'en']) {
        const faq = await knowledge.listFaq(clientId);
        const { assistant } = renderAssistant(config, member, faq, OPTIONS);

        expect('stopSpeakingPlan' in assistant).toBe(false);
        expect(assistant.startSpeakingPlan?.customEndpointingRules).toEqual([]);
        expect(assistant.startSpeakingPlan?.transcriptionEndpointingPlan).not.toHaveProperty(
          'onNumberSeconds',
        );
      }
    },
  );

  test.each(OTHERS)(
    '%s: handoff overrides carry no stopSpeakingPlan / startSpeakingPlan',
    (clientId) => {
      const config = loadClient(clientId);
      const destination = renderHandoffTool(config, 'ja', 'en', SILENCE_END_SERVER).destinations[0];

      expect(destination?.assistantOverrides).not.toHaveProperty('stopSpeakingPlan');
      expect(destination?.assistantOverrides).not.toHaveProperty('startSpeakingPlan');
    },
  );
});

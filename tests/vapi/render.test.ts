import { describe, expect, test } from 'vitest';

import { loadClient } from '../../src/config/loadClient.js';
import { FileKnowledgeSource } from '../../src/knowledge/KnowledgeSource.js';
import {
  REQUEST_CALLBACK_FUNCTION_NAME,
  UnconfiguredTranscriberError,
  renderAssistant,
} from '../../src/vapi/render.js';
import { UnsupportedLanguageError } from '../../src/vapi/promptTemplate.js';
import { SAKURA_ID } from '../helpers/clientFixtures.js';
import { buildMinimalConfig } from '../helpers/vapiFixtures.js';

const BASE_URL = 'https://example.ngrok-free.app';
const CREDENTIAL_ID = 'credential-uuid';
const OPTIONS = { baseUrl: BASE_URL, credentialId: CREDENTIAL_ID };
const knowledge = new FileKnowledgeSource();

describe('renderAssistant — Sakura fixture (ja)', () => {
  test('builds the assistant payload', async () => {
    const config = loadClient(SAKURA_ID);
    const faq = await knowledge.listFaq(SAKURA_ID);

    const { assistant } = renderAssistant(config, 'ja', faq, OPTIONS);

    expect(assistant.name).toBe('sakura-seikotsuin--ja');
    expect(assistant.firstMessage).toContain('さくら整骨院');
    expect(assistant.firstMessage).not.toContain('[[clinicName]]');
    expect(assistant.voice).toEqual({ provider: 'azure', voiceId: 'ja-JP-NanamiNeural' });
    expect(assistant.transcriber).toEqual({ provider: 'azure', language: 'ja-JP' });
    expect(assistant.model.provider).toBe('openai');
    expect(assistant.model.model).toBe('gpt-4o-mini');
    expect(assistant.model.messages).toEqual([{ role: 'system', content: expect.any(String) }]);
    expect(assistant.model.messages[0]?.content).toContain('さくら整骨院');
    expect(assistant.model.toolIds).toEqual([]);
  });

  test('builds the request_callback tool payload', async () => {
    const config = loadClient(SAKURA_ID);
    const faq = await knowledge.listFaq(SAKURA_ID);

    const { tool } = renderAssistant(config, 'ja', faq, OPTIONS);

    expect(tool.type).toBe('function');
    expect(tool.function.name).toBe(REQUEST_CALLBACK_FUNCTION_NAME);
    expect(tool.function.parameters.required).toEqual(['callerName', 'callerPhone']);
    expect(Object.keys(tool.function.parameters.properties)).toEqual([
      'callerName',
      'callerPhone',
      'reason',
    ]);
    expect(tool.server.url).toBe(`${BASE_URL}/api/voice/callback-request`);
  });

  test("the tool's request-failed message uses scripts.callbackFailed with clinic placeholders substituted", async () => {
    const config = loadClient(SAKURA_ID);
    const faq = await knowledge.listFaq(SAKURA_ID);

    const { tool } = renderAssistant(config, 'ja', faq, OPTIONS);

    const failedMessage = tool.messages?.find((message) => message.type === 'request-failed');
    expect(failedMessage?.content).toContain('048-000-0000');
    expect(failedMessage?.content).not.toContain('[[clinicPhone]]');
  });

  test('assistant.endCallMessage speaks scripts.goodbye with clinic placeholders substituted', async () => {
    const config = loadClient(SAKURA_ID);
    const faq = await knowledge.listFaq(SAKURA_ID);

    const { assistant } = renderAssistant(config, 'ja', faq, OPTIONS);

    expect(assistant.endCallMessage).toContain('さくら整骨院');
    expect(assistant.endCallMessage).not.toContain('[[');
    expect(assistant.model.tools).toEqual([{ type: 'endCall' }]);
  });
});

describe('renderAssistant — startSpeakingPlan (VP-6 A)', () => {
  test('uses Vapi text-based smart endpointing and a longer timeout while the assistant is asking for the phone number', async () => {
    const config = loadClient(SAKURA_ID);
    const faq = await knowledge.listFaq(SAKURA_ID);

    const { assistant } = renderAssistant(config, 'ja', faq, OPTIONS);

    expect(assistant.startSpeakingPlan?.smartEndpointingPlan).toEqual({ provider: 'vapi' });
    // The "vapi" smart provider reads its own decision thresholds from
    // transcriptionEndpointingPlan (VAPI-FACTS.md VP-6 R7) — this must be
    // set explicitly, and lower than the 1.5s default, or the "smart"
    // provider silently behaves identically to the old fixed wait.
    const onNoPunctuationSeconds =
      assistant.startSpeakingPlan?.transcriptionEndpointingPlan?.onNoPunctuationSeconds;
    expect(onNoPunctuationSeconds).toBeGreaterThanOrEqual(0.6);
    expect(onNoPunctuationSeconds).toBeLessThanOrEqual(0.8);
    const rules = assistant.startSpeakingPlan?.customEndpointingRules ?? [];
    expect(rules).toHaveLength(1);
    expect(rules[0]?.type).toBe('assistant');
    // Still longer than both the old fixed default AND the new shorter one.
    expect(rules[0]?.timeoutSeconds).toBeGreaterThan(1.5);
    expect(new RegExp(rules[0]?.regex ?? '')).toEqual(
      expect.objectContaining({
        source: expect.stringContaining('お電話番号を教えていただけますか'),
      }),
    );
  });

  test('the same plan shape holds for an arbitrary language — no hard-coded ja/en', () => {
    const config = buildMinimalConfig({ language: 'fr' });

    const { assistant } = renderAssistant(config, 'fr', config.faq, OPTIONS);

    expect(assistant.startSpeakingPlan?.smartEndpointingPlan).toEqual({ provider: 'vapi' });
    const regex = new RegExp(assistant.startSpeakingPlan?.customEndpointingRules?.[0]?.regex ?? '');
    expect(regex.test('askPhone text (fr)')).toBe(true);
  });
});

describe('renderAssistant — handoff (Sakura)', () => {
  test('the Japanese assistant opens with the call greeting and gets one handoff tool, to English', async () => {
    const config = loadClient(SAKURA_ID);
    const faq = await knowledge.listFaq(SAKURA_ID);

    const { assistant, handoffTools } = renderAssistant(config, 'ja', faq, OPTIONS);

    expect(assistant.firstMessage).toContain('For English, please say "English"');
    expect(handoffTools.map((tool) => tool.toLanguage)).toEqual(['en']);
    expect(handoffTools[0]?.payload.destinations[0]?.assistantName).toBe('sakura-seikotsuin--en');
  });

  test('the English assistant opens with its arrival greeting (not the "say English" greeting) and hands back to Japanese', async () => {
    const config = loadClient(SAKURA_ID);
    const faq = await knowledge.listFaq(SAKURA_ID);

    const { assistant, handoffTools } = renderAssistant(config, 'en', faq, OPTIONS);

    expect(assistant.name).toBe('sakura-seikotsuin--en');
    expect(assistant.firstMessage).toContain('English receptionist for Sakura Seikotsuin');
    expect(assistant.firstMessage).not.toContain('For English');
    expect(assistant.voice).toEqual({ provider: 'azure', voiceId: 'en-US-JennyNeural' });
    expect(assistant.transcriber).toEqual({ provider: 'azure', language: 'en-US' });
    expect(handoffTools.map((tool) => tool.toLanguage)).toEqual(['ja']);
    expect(handoffTools[0]?.payload.destinations[0]?.assistantName).toBe('sakura-seikotsuin--ja');
  });

  test('a single-language client renders no handoff tools', () => {
    const config = buildMinimalConfig({ language: 'fr' });

    expect(renderAssistant(config, 'fr', config.faq, OPTIONS).handoffTools).toEqual([]);
  });
});

describe('renderAssistant — error handling', () => {
  test('throws UnsupportedLanguageError for a language not in languages.supported', async () => {
    const config = loadClient(SAKURA_ID);
    const faq = await knowledge.listFaq(SAKURA_ID);

    expect(() => renderAssistant(config, 'fr', faq, OPTIONS)).toThrow(UnsupportedLanguageError);
  });

  test('throws UnconfiguredTranscriberError when languages.settings.<lang>.transcriber is null', () => {
    const config = buildMinimalConfig({ language: 'fr' });
    const withoutTranscriber = {
      ...config,
      languages: {
        ...config.languages,
        settings: { fr: { ...config.languages.settings['fr']!, transcriber: null } },
      },
    };

    expect(() =>
      renderAssistant(withoutTranscriber, 'fr', withoutTranscriber.faq, OPTIONS),
    ).toThrow(UnconfiguredTranscriberError);
  });
});

describe('renderAssistant — language handling', () => {
  test('produces structurally equivalent output for an arbitrary language — no hard-coded ja/en', () => {
    const config = buildMinimalConfig({ language: 'fr' });

    const { assistant, tool } = renderAssistant(config, 'fr', config.faq, OPTIONS);

    expect(assistant.name).toBe('test-clinic--fr');
    expect(assistant.firstMessage).toBe('greeting text (fr)');
    expect(assistant.voice).toEqual({ provider: 'azure', voiceId: 'test-voice-id' });
    expect(assistant.transcriber).toEqual({ provider: 'azure', language: 'fr' });
    expect(assistant.model.messages[0]?.content).toContain('Sample question (fr)?');
    expect(tool.function.name).toBe(REQUEST_CALLBACK_FUNCTION_NAME);
    expect(tool.server.url).toBe(`${BASE_URL}/api/voice/callback-request`);
  });
});

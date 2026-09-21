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
const knowledge = new FileKnowledgeSource();

describe('renderAssistant — Sakura fixture (ja)', () => {
  test('builds the assistant payload', async () => {
    const config = loadClient(SAKURA_ID);
    const faq = await knowledge.listFaq(SAKURA_ID);

    const { assistant } = renderAssistant(config, 'ja', faq, { baseUrl: BASE_URL });

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

    const { tool } = renderAssistant(config, 'ja', faq, { baseUrl: BASE_URL });

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

    const { tool } = renderAssistant(config, 'ja', faq, { baseUrl: BASE_URL });

    const failedMessage = tool.messages?.find((message) => message.type === 'request-failed');
    expect(failedMessage?.content).toContain('048-000-0000');
    expect(failedMessage?.content).not.toContain('[[clinicPhone]]');
  });
});

describe('renderAssistant — handoff (Sakura)', () => {
  test('the Japanese assistant opens with the call greeting and gets one handoff tool, to English', async () => {
    const config = loadClient(SAKURA_ID);
    const faq = await knowledge.listFaq(SAKURA_ID);

    const { assistant, handoffTools } = renderAssistant(config, 'ja', faq, { baseUrl: BASE_URL });

    expect(assistant.firstMessage).toContain('For English, please say "English"');
    expect(handoffTools.map((tool) => tool.toLanguage)).toEqual(['en']);
    expect(handoffTools[0]?.payload.destinations[0]?.assistantName).toBe('sakura-seikotsuin--en');
  });

  test('the English assistant opens with its arrival greeting (not the "say English" greeting) and hands back to Japanese', async () => {
    const config = loadClient(SAKURA_ID);
    const faq = await knowledge.listFaq(SAKURA_ID);

    const { assistant, handoffTools } = renderAssistant(config, 'en', faq, { baseUrl: BASE_URL });

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

    expect(renderAssistant(config, 'fr', config.faq, { baseUrl: BASE_URL }).handoffTools).toEqual(
      [],
    );
  });
});

describe('renderAssistant — error handling', () => {
  test('throws UnsupportedLanguageError for a language not in languages.supported', async () => {
    const config = loadClient(SAKURA_ID);
    const faq = await knowledge.listFaq(SAKURA_ID);

    expect(() => renderAssistant(config, 'fr', faq, { baseUrl: BASE_URL })).toThrow(
      UnsupportedLanguageError,
    );
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
      renderAssistant(withoutTranscriber, 'fr', withoutTranscriber.faq, { baseUrl: BASE_URL }),
    ).toThrow(UnconfiguredTranscriberError);
  });
});

describe('renderAssistant — language handling', () => {
  test('produces structurally equivalent output for an arbitrary language — no hard-coded ja/en', () => {
    const config = buildMinimalConfig({ language: 'fr' });

    const { assistant, tool } = renderAssistant(config, 'fr', config.faq, { baseUrl: BASE_URL });

    expect(assistant.name).toBe('test-clinic--fr');
    expect(assistant.firstMessage).toBe('greeting text (fr)');
    expect(assistant.voice).toEqual({ provider: 'azure', voiceId: 'test-voice-id' });
    expect(assistant.transcriber).toEqual({ provider: 'azure', language: 'fr' });
    expect(assistant.model.messages[0]?.content).toContain('Sample question (fr)?');
    expect(tool.function.name).toBe(REQUEST_CALLBACK_FUNCTION_NAME);
    expect(tool.server.url).toBe(`${BASE_URL}/api/voice/callback-request`);
  });
});

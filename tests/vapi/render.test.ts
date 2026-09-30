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
    expect(assistant.voice).toEqual({
      provider: 'cartesia',
      voiceId: 'e63d7d05-76b0-4ff5-b8fb-503a82688bfe',
    });
    expect(assistant.transcriber).toEqual({
      provider: 'cartesia',
      model: 'ink-whisper',
      language: 'ja',
    });
    expect(assistant.model.provider).toBe('openai');
    expect(assistant.model.model).toBe('gpt-5.6-terra');
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
    // VP-7 decision 1: never point the caller back at the number they're already
    // on — the failure line asks them to try again later instead of naming it.
    expect(failedMessage?.content).not.toContain('048-000-0000');
    expect(failedMessage?.content).not.toContain('[[clinicPhone]]');
    expect(failedMessage?.content).toContain('お電話');
  });

  test('assistant.endCallMessage speaks scripts.goodbye with clinic placeholders substituted', async () => {
    const config = loadClient(SAKURA_ID);
    const faq = await knowledge.listFaq(SAKURA_ID);

    const { assistant } = renderAssistant(config, 'ja', faq, OPTIONS);

    expect(assistant.endCallMessage).toBe('お大事になさってください。');
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

    expect(assistant.firstMessage).toContain(
      'If you would like assistance in English, please say "English."',
    );
    expect(handoffTools.map((tool) => tool.toLanguage)).toEqual(['en']);
    expect(handoffTools[0]?.payload.destinations[0]?.assistantName).toBe('sakura-seikotsuin--en');
  });

  test('the English assistant opens with its arrival greeting (not the "say English" greeting) and hands back to Japanese', async () => {
    const config = loadClient(SAKURA_ID);
    const faq = await knowledge.listFaq(SAKURA_ID);

    const { assistant, handoffTools } = renderAssistant(config, 'en', faq, OPTIONS);

    expect(assistant.name).toBe('sakura-seikotsuin--en');
    // Spoken text uses the VP-6 D phonetic override (namePronunciation.en), not the written name.
    expect(assistant.firstMessage).toContain('Thank you for calling Sakura Say-koh-tsoo-in');
    expect(assistant.firstMessage).toContain('How may I assist you today?');
    // Suite E1: no handoff/"English receptionist" wording.
    expect(assistant.firstMessage).not.toContain('English receptionist');
    expect(assistant.firstMessage).not.toContain('For English');
    expect(assistant.voice).toEqual({
      provider: 'cartesia',
      voiceId: 'e4d5f4c4-6601-4779-bee1-b3c14d629dc6',
    });
    expect(assistant.transcriber).toEqual({
      provider: 'cartesia',
      model: 'ink-whisper',
      language: 'en',
    });
    expect(handoffTools.map((tool) => tool.toLanguage)).toEqual(['ja']);
    // Redirected to ja-return (VP-7 R1), not the call-starting ja assistant —
    // its firstMessage is the full opening greeting, which must never replay.
    expect(handoffTools[0]?.payload.destinations[0]?.assistantName).toBe(
      'sakura-seikotsuin--ja-return',
    );
  });

  test('a single-language client renders no handoff tools', () => {
    const config = buildMinimalConfig({ language: 'fr' });

    expect(renderAssistant(config, 'fr', config.faq, OPTIONS).handoffTools).toEqual([]);
  });
});

describe('renderAssistant — ja-return member (Sakura, VP-7 R1)', () => {
  test("reuses ja's voice, transcriber, system prompt and goodbye, but its own resource name and arrival firstMessage", async () => {
    const config = loadClient(SAKURA_ID);
    const faq = await knowledge.listFaq(SAKURA_ID);

    const ja = renderAssistant(config, 'ja', faq, OPTIONS);
    const jaReturn = renderAssistant(config, 'ja-return', faq, OPTIONS);

    expect(jaReturn.assistant.name).toBe('sakura-seikotsuin--ja-return');
    expect(jaReturn.assistant.voice).toEqual(ja.assistant.voice);
    expect(jaReturn.assistant.transcriber).toEqual(ja.assistant.transcriber);
    expect(jaReturn.assistant.model.messages).toEqual(ja.assistant.model.messages);
    expect(jaReturn.assistant.endCallMessage).toBe(ja.assistant.endCallMessage);
    // Never the full opening greeting (that would replay "For English, please say English" mid-call).
    expect(jaReturn.assistant.firstMessage).not.toEqual(ja.assistant.firstMessage);
    expect(jaReturn.assistant.firstMessage).not.toContain('For English');
    expect(jaReturn.assistant.firstMessage).toBe('日本語で承ります。ご用件をお伺いいたします。');
  });

  test("gets its own outbound handoff tool to English, byte-identical to ja's own", async () => {
    const config = loadClient(SAKURA_ID);
    const faq = await knowledge.listFaq(SAKURA_ID);

    const ja = renderAssistant(config, 'ja', faq, OPTIONS);
    const jaReturn = renderAssistant(config, 'ja-return', faq, OPTIONS);

    expect(jaReturn.handoffTools.map((tool) => tool.toLanguage)).toEqual(['en']);
    const payload = jaReturn.handoffTools[0]?.payload;
    expect(payload?.destinations[0]?.assistantName).toBe('sakura-seikotsuin--en');
    expect(payload?.destinations[0]?.contextEngineeringPlan).toEqual({ type: 'all' });
    expect(payload?.messages).toEqual([{ type: 'request-start', content: '' }]);
    // Both render through the same content language ("ja"), so this must be
    // more than "looks similar" — it's the exact same payload, proving the
    // round trip (ja → en → ja-return → en) really does work the same way
    // ja's own ja → en handoff already does.
    expect(payload).toEqual(ja.handoffTools[0]?.payload);
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

describe('renderAssistant — VP-8 reservation tools', () => {
  const SERVICES = [
    {
      id: 'general-consultation',
      name: { ja: '一般施術', en: 'General Consultation' },
      durationMinutes: 30,
    },
    { id: 'follow-up', name: { ja: 'フォローアップ', en: 'Follow-up' }, durationMinutes: 20 },
  ];

  test('no services configured — no reservation tools', () => {
    const config = buildMinimalConfig({ language: 'fr' });

    const { reservationTools } = renderAssistant(config, 'fr', config.faq, OPTIONS);

    expect(reservationTools).toEqual([]);
  });

  test('services configured — all three reservation tools are built, pointed at the right URLs', () => {
    const config = buildMinimalConfig({ language: 'fr' });

    const { reservationTools } = renderAssistant(config, 'fr', config.faq, {
      ...OPTIONS,
      services: SERVICES,
    });

    const byKey = Object.fromEntries(reservationTools.map((t) => [t.key, t.payload]));
    expect(Object.keys(byKey).sort()).toEqual([
      'book-appointment',
      'check-availability',
      'lookup-patient',
    ]);
    expect(byKey['check-availability']?.function.name).toBe('check_availability');
    expect(byKey['check-availability']?.server.url).toBe(
      `${BASE_URL}/api/voice/check-availability`,
    );
    expect(byKey['lookup-patient']?.function.name).toBe('lookup_patient');
    expect(byKey['lookup-patient']?.server.url).toBe(`${BASE_URL}/api/voice/lookup-patient`);
    expect(byKey['book-appointment']?.function.name).toBe('book_appointment');
    expect(byKey['book-appointment']?.server.url).toBe(`${BASE_URL}/api/voice/book-appointment`);
  });

  test('book_appointment.serviceId is an enum of the configured service ids, and is not required', () => {
    const config = buildMinimalConfig({ language: 'fr' });

    const { reservationTools } = renderAssistant(config, 'fr', config.faq, {
      ...OPTIONS,
      services: SERVICES,
    });

    const bookAppointment = reservationTools.find((t) => t.key === 'book-appointment')?.payload;
    expect(bookAppointment?.function.parameters.properties.serviceId?.enum).toEqual([
      'general-consultation',
      'follow-up',
    ]);
    expect(bookAppointment?.function.parameters.required).not.toContain('serviceId');
    expect(bookAppointment?.function.parameters.required).toEqual(['date', 'time', 'patientPhone']);
    expect(bookAppointment?.function.parameters.properties.patientName).toBeUndefined();
    expect(bookAppointment?.function.parameters.properties.patientEmail).toBeUndefined();
  });
});

import { describe, expect, test } from 'vitest';

import { loadClient } from '../../src/config/loadClient.js';
import { FileKnowledgeSource } from '../../src/knowledge/KnowledgeSource.js';
import { allowedTopics, CALL_OUTCOMES, RESERVED_TOPICS } from '../../src/lib/callTopics.js';
import { buildSystemPrompt } from '../../src/vapi/promptTemplate.js';
import { LOG_CALL_TOPIC_FUNCTION_NAME, renderAssistant } from '../../src/vapi/render.js';
import { SAKURA_ID } from '../helpers/clientFixtures.js';
import { buildMinimalConfig } from '../helpers/vapiFixtures.js';

const OPTIONS = { baseUrl: 'https://example.ngrok-free.app/', credentialId: 'credential-uuid' };
const knowledge = new FileKnowledgeSource();

describe('log_call_topic tool definition', () => {
  test('is asynchronous, so the assistant never waits for our server (VP-4 §4.3)', async () => {
    const config = loadClient(SAKURA_ID);

    const { topicTool } = renderAssistant(
      config,
      'ja',
      await knowledge.listFaq(SAKURA_ID),
      OPTIONS,
    );

    expect(topicTool.async).toBe(true);
  });

  test('points at /api/voice/call-topic with the Custom Credential', async () => {
    const config = loadClient(SAKURA_ID);

    const { topicTool } = renderAssistant(
      config,
      'ja',
      await knowledge.listFaq(SAKURA_ID),
      OPTIONS,
    );

    expect(topicTool.server).toEqual({
      url: 'https://example.ngrok-free.app/api/voice/call-topic',
      credentialId: 'credential-uuid',
    });
  });

  test('the request_callback tool carries the credential too — both endpoints are authenticated', async () => {
    const config = loadClient(SAKURA_ID);

    const { tool } = renderAssistant(config, 'ja', await knowledge.listFaq(SAKURA_ID), OPTIONS);

    expect(tool.server.credentialId).toBe('credential-uuid');
  });

  test('offers exactly the FAQ ids plus other/unresolved/emergency as topics', async () => {
    const config = loadClient(SAKURA_ID);
    const faq = await knowledge.listFaq(SAKURA_ID);

    const { topicTool } = renderAssistant(config, 'ja', faq, OPTIONS);

    expect(topicTool.function.parameters.properties['topic']?.enum).toEqual([
      ...faq.map((entry) => entry.id),
      ...RESERVED_TOPICS,
    ]);
    expect(topicTool.function.parameters.properties['outcome']?.enum).toEqual([...CALL_OUTCOMES]);
    expect(topicTool.function.parameters.required).toEqual(['topic', 'outcome']);
  });

  test('has no parameter that could carry personal data', async () => {
    const config = loadClient(SAKURA_ID);

    const { topicTool } = renderAssistant(
      config,
      'ja',
      await knowledge.listFaq(SAKURA_ID),
      OPTIONS,
    );

    expect(Object.keys(topicTool.function.parameters.properties).sort()).toEqual([
      'outcome',
      'topic',
    ]);
  });

  test('says nothing to the caller on any path (empty messages)', async () => {
    const config = loadClient(SAKURA_ID);

    const { topicTool } = renderAssistant(
      config,
      'ja',
      await knowledge.listFaq(SAKURA_ID),
      OPTIONS,
    );

    expect(topicTool.messages?.map((message) => message.type).sort()).toEqual([
      'request-complete',
      'request-failed',
      'request-start',
    ]);
    expect(topicTool.messages?.every((message) => message.content === '')).toBe(true);
  });

  test('follows the language-agnostic path: a made-up language gets the same tool', () => {
    const config = buildMinimalConfig({ language: 'fr', faqIds: ['a', 'b'] });

    const { topicTool } = renderAssistant(config, 'fr', config.faq, OPTIONS);

    expect(topicTool.function.name).toBe(LOG_CALL_TOPIC_FUNCTION_NAME);
    expect(topicTool.function.parameters.properties['topic']?.enum).toEqual([
      'a',
      'b',
      ...RESERVED_TOPICS,
    ]);
  });
});

describe('allowedTopics', () => {
  test('does not duplicate a reserved word that is also a FAQ id', () => {
    expect(allowedTopics(['other', 'hours'])).toEqual([
      'other',
      'hours',
      'unresolved',
      'emergency',
    ]);
  });
});

describe('prompt: conditional collection and silent classification (VP-4 §4.4)', () => {
  const promptFor = async () => {
    const config = loadClient(SAKURA_ID);
    return buildSystemPrompt(config, 'ja', await knowledge.listFaq(SAKURA_ID));
  };

  test('forbids asking for a name or phone on a plain FAQ answer', async () => {
    expect(await promptFor()).toMatch(/never ask for a name or phone number/i);
  });

  test('restricts collection to "no match" and "asks for staff"', async () => {
    expect(await promptFor()).toMatch(
      /Take one only when you can't answer a question, or when the caller asks for a staff member/,
    );
  });

  test('tells the model to log the topic and hang up silently, without saying goodbye itself', async () => {
    const prompt = await promptFor();

    expect(prompt).toContain(`Call ${LOG_CALL_TOPIC_FUNCTION_NAME} exactly once`);
    expect(prompt).toMatch(/then call endCall to hang up/);
    // VP-7: the wording that fixes "model speaks a farewell instead of calling the tools".
    expect(prompt).toMatch(/your ONLY response is the two silent tool calls/);
    expect(prompt).toMatch(/saying it yourself would say it twice/i);
    expect(prompt).toMatch(/never mention either tool/i);
  });

  test('lists every FAQ id and the reserved topics as valid choices', async () => {
    const prompt = await promptFor();
    const faq = await knowledge.listFaq(SAKURA_ID);

    for (const entry of faq) expect(prompt).toContain(`"${entry.id}"`);
    for (const topic of RESERVED_TOPICS) expect(prompt).toContain(`"${topic}"`);
  });

  test('an emergency skips the callback flow but is still classified', async () => {
    const prompt = await promptFor();

    expect(prompt).toMatch(
      /do not collect a name or phone number, and do not call request_callback/i,
    );
    expect(prompt).toMatch(/Do this even for an emergency call/);
  });

  test('the personal-data rule for the analytics tool is stated', async () => {
    expect(await promptFor()).toMatch(
      /Never pass a name, phone number or any free text to log_call_topic/,
    );
  });
});

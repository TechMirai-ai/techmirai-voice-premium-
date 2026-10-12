import { describe, expect, test } from 'vitest';

import { loadClient } from '../../src/config/loadClient.js';
import { FileKnowledgeSource } from '../../src/knowledge/KnowledgeSource.js';
import { renderAssistant } from '../../src/vapi/render.js';
import { SAKURA_ID } from '../helpers/clientFixtures.js';

const OPTIONS = { baseUrl: 'https://example.test', credentialId: 'cred-test' };
const REPORT_URL = 'https://example.test/api/voice/end-of-call-report';
const config = loadClient(SAKURA_ID);
const faq = await new FileKnowledgeSource().listFaq(SAKURA_ID);

describe('end-of-call-report wiring in rendered payloads', () => {
  test.each(['ja', 'en', 'ja-return'])(
    'the %s assistant reports to the webhook, records, and links the outcome output',
    (memberId) => {
      const { assistant } = renderAssistant(config, memberId, faq, {
        ...OPTIONS,
        outcomeOutputId: 'so-1',
      });
      expect(assistant.server).toEqual({ url: REPORT_URL, credentialId: 'cred-test' });
      expect(assistant.serverMessages).toEqual(['end-of-call-report']);
      expect(assistant.artifactPlan).toEqual({
        recordingEnabled: true,
        structuredOutputIds: ['so-1'],
      });
    },
  );

  test('a dry run (no output id yet) still reports and records, without the link', () => {
    const { assistant } = renderAssistant(config, 'ja', faq, OPTIONS);
    expect(assistant.server?.url).toBe(REPORT_URL);
    expect(assistant.artifactPlan).toEqual({ recordingEnabled: true });
  });

  test('every handoff leg carries the same reporting config in its overrides', () => {
    const { handoffTools } = renderAssistant(config, 'ja', faq, {
      ...OPTIONS,
      outcomeOutputId: 'so-1',
    });
    expect(handoffTools.length).toBeGreaterThan(0);
    for (const { payload } of handoffTools) {
      for (const destination of payload.destinations) {
        expect(destination.assistantOverrides.server).toEqual({
          url: REPORT_URL,
          credentialId: 'cred-test',
        });
        expect(destination.assistantOverrides.serverMessages).toEqual(['end-of-call-report']);
        expect(destination.assistantOverrides.artifactPlan?.structuredOutputIds).toEqual(['so-1']);
      }
    }
  });

  test('the call-opening Japanese greeting tells the caller the call is recorded, before asking its question', () => {
    const { assistant } = renderAssistant(config, 'ja', faq, OPTIONS);
    const message = assistant.firstMessage;
    expect(message).toContain('録音');
    expect(message.indexOf('録音')).toBeLessThan(message.indexOf('ご用件'));
  });

  test('the English greeting after a handoff also says the call is recorded, before its question', () => {
    const { assistant } = renderAssistant(config, 'en', faq, OPTIONS);
    const message = assistant.firstMessage;
    expect(message).toMatch(/recorded/i);
    expect(message.search(/recorded/i)).toBeLessThan(message.indexOf('How may I assist'));
  });

  test('the "welcome back" line does not repeat the recording notice', () => {
    const { assistant } = renderAssistant(config, 'ja-return', faq, OPTIONS);
    expect(assistant.firstMessage).not.toContain('録音');
  });

  test('the tools keep their own server — the assistant-level server is only for the report', () => {
    const { tool, topicTool } = renderAssistant(config, 'ja', faq, OPTIONS);
    expect(tool.server.url).toBe('https://example.test/api/voice/callback-request');
    expect(topicTool.server.url).toBe('https://example.test/api/voice/call-topic');
  });
});

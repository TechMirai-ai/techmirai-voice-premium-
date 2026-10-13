import { describe, expect, test } from 'vitest';

import {
  callOutcomeStateName,
  ClientIdTooLongForOutputError,
  renderCallOutcomeOutput,
  renderReportingConfig,
} from '../../src/vapi/callReporting.js';
import { loadClient } from '../../src/config/loadClient.js';

const config = loadClient('sakura-seikotsuin');
const faq = [{ id: 'hours' }, { id: 'parking' }];

describe('renderCallOutcomeOutput', () => {
  test('is named after the client and fits Vapi’s 40-character limit', () => {
    const output = renderCallOutcomeOutput(config, faq);
    expect(output.name).toBe('sakura-seikotsuin--call-outcome');
    expect(output.name.length).toBeLessThanOrEqual(40);
    expect(callOutcomeStateName('sakura-seikotsuin')).toBe(output.name);
  });

  test('extracts an AI result with a topic enum (FAQ ids + reserved) and a resolved boolean', () => {
    const output = renderCallOutcomeOutput(config, faq);
    expect(output.type).toBe('ai');
    expect(output.schema.type).toBe('object');
    expect(output.schema.properties.topic.enum).toEqual([
      'hours',
      'parking',
      'other',
      'unresolved',
    ]);
    expect(output.schema.properties.resolved.type).toBe('boolean');
    expect(output.schema.required).toEqual(['topic', 'resolved', 'summary']);
  });

  test('also extracts a required staff-facing summary string (replaces the deprecated analysisPlan summary)', () => {
    const { summary } = renderCallOutcomeOutput(config, faq).schema.properties;
    expect(summary.type).toBe('string');
    expect(summary.description).toMatch(/language the caller spoke/i);
    expect(summary.description).toMatch(/ended before anything was said/i);
  });

  test('the resolved description says a callback or booking is not "resolved"', () => {
    const { resolved } = renderCallOutcomeOutput(config, faq).schema.properties;
    expect(resolved.description).toMatch(/callback/i);
  });

  test('refuses a client id too long to fit the name limit instead of truncating it', () => {
    const long = { ...config, clientId: 'a-very-long-clinic-client-identifier' };
    expect(() => renderCallOutcomeOutput(long, faq)).toThrow(ClientIdTooLongForOutputError);
  });
});

describe('renderReportingConfig', () => {
  const base = 'https://example.ngrok-free.app/';

  test('points the assistant at the end-of-call-report route with the shared credential', () => {
    expect(renderReportingConfig(base, 'cred-1', 'so-1').server).toEqual({
      url: 'https://example.ngrok-free.app/api/voice/end-of-call-report',
      credentialId: 'cred-1',
    });
  });

  test('sends only the end-of-call-report event to that server', () => {
    expect(renderReportingConfig(base, 'cred-1').serverMessages).toEqual(['end-of-call-report']);
  });

  test('turns recording on explicitly and links the structured output when its id is known', () => {
    expect(renderReportingConfig(base, 'cred-1', 'so-1').artifactPlan).toEqual({
      recordingEnabled: true,
      structuredOutputIds: ['so-1'],
    });
  });

  test('omits the structured-output link when the id is not known yet (dry run)', () => {
    expect(renderReportingConfig(base, 'cred-1').artifactPlan).toEqual({ recordingEnabled: true });
  });
});

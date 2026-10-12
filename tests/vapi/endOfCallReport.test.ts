import { describe, expect, test } from 'vitest';

import { parseEndOfCallReport } from '../../src/vapi/endOfCallReport.js';

const OUTPUT_ID = 'so-1';

function report(overrides: Record<string, unknown> = {}, artifact: Record<string, unknown> = {}) {
  return {
    message: {
      type: 'end-of-call-report',
      endedReason: 'assistant-ended-call',
      startedAt: '2026-10-12T01:00:00.000Z',
      endedAt: '2026-10-12T01:02:00.000Z',
      call: { id: 'call-9', assistantId: 'assistant-ja' },
      assistant: { id: 'assistant-ja', name: 'sakura-seikotsuin--ja' },
      analysis: { summary: 'Caller asked about parking.' },
      artifact: {
        transcript: 'AI: Hello\nUser: Hi',
        messages: [],
        structuredOutputs: {
          [OUTPUT_ID]: { name: 'outcome', result: { topic: 'parking', resolved: true } },
        },
        presignedMonoUrl: 'https://signed.example/mono.wav',
        presignedUrlsExpiresAt: '2026-10-12T02:00:00.000Z',
        ...artifact,
      },
      ...overrides,
    },
  };
}

describe('parseEndOfCallReport', () => {
  test('returns undefined for anything that is not an end-of-call-report', () => {
    expect(
      parseEndOfCallReport({ message: { type: 'tool-calls', call: { id: 'x' } } }),
    ).toBeUndefined();
    expect(parseEndOfCallReport('nope')).toBeUndefined();
    expect(parseEndOfCallReport({ message: { type: 'end-of-call-report' } })).toBeUndefined();
  });

  test('extracts call identity, timing, summary, transcript and recording link', () => {
    const parsed = parseEndOfCallReport(report())!;
    expect(parsed.callId).toBe('call-9');
    expect(parsed.assistant).toEqual({ id: 'assistant-ja', name: 'sakura-seikotsuin--ja' });
    expect(parsed.endedReason).toBe('assistant-ended-call');
    expect(parsed.startedAt).toBe('2026-10-12T01:00:00.000Z');
    expect(parsed.summary).toBe('Caller asked about parking.');
    expect(parsed.recordingUrl).toBe('https://signed.example/mono.wav');
  });

  test('reads topic and resolved from the first structured output with a result', () => {
    const parsed = parseEndOfCallReport(report())!;
    expect(parsed.topic).toBe('parking');
    expect(parsed.resolved).toBe(true);
  });

  test('a null structured-output result leaves topic and resolved undefined', () => {
    const parsed = parseEndOfCallReport(
      report({}, { structuredOutputs: { [OUTPUT_ID]: { name: 'outcome', result: null } } }),
    )!;
    expect(parsed.topic).toBeUndefined();
    expect(parsed.resolved).toBeUndefined();
  });

  test('collects tool results by name and takes the caller name from request_callback args', () => {
    const parsed = parseEndOfCallReport(
      report(
        {},
        {
          messages: [
            {
              role: 'tool_calls',
              toolCalls: [
                {
                  id: 't1',
                  function: { name: 'request_callback', arguments: '{"callerName":"Hanako"}' },
                },
              ],
            },
            {
              role: 'tool_call_result',
              toolCallId: 't1',
              name: 'request_callback',
              result: 'saved',
            },
            {
              role: 'tool_call_result',
              toolCallId: 't2',
              name: 'lookup_patient',
              result: 'Found: ヤマダ タロウ.',
            },
            { role: 'bot', message: 'hi' },
          ],
        },
      ),
    )!;
    expect(parsed.toolResults.map((r) => r.name)).toEqual(['request_callback', 'lookup_patient']);
    expect(parsed.callerName).toBe('Hanako');
    expect(parsed.matchedPatientName).toBe('ヤマダ タロウ');
  });

  test('no patient match leaves matchedPatientName undefined', () => {
    const parsed = parseEndOfCallReport(
      report(
        {},
        {
          messages: [
            {
              role: 'tool_call_result',
              toolCallId: 't2',
              name: 'lookup_patient',
              result: 'No patient record was found for that name.',
            },
          ],
        },
      ),
    )!;
    expect(parsed.matchedPatientName).toBeUndefined();
  });
});
